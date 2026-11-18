import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  mapR2ErrorExitCode,
  normalizeStrongETag,
  probeR2ManifestState,
  promoteCanonicalManifestWithCas,
} from "../lib/r2_manifest_cas.ts";
import {
  fetchSignedR2Read,
  parseR2ETag,
  R2_BUN_ADDED_UNSIGNED_HEADERS,
  R2EncodedETagError,
  R2S3Client,
  type R2S3ClientBackend,
  R2WeakETagError,
} from "../lib/r2_s3_client.ts";

const ACCESS_KEY = "fake-access";
const SECRET_KEY = "fake-secret";
const SESSION_TOKEN = "fake-session";
const MANIFEST = "manifests/test-sink/latest";

interface Seen {
  readonly method: string;
  readonly key: string;
  readonly headers: Headers;
  readonly signedHeaders: readonly string[];
  readonly signatureValid: boolean;
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return new Bun.CryptoHasher("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Recomputes SigV4 from the received headers, as R2 does, with the fake secret. */
function verifySigV4(
  request: Request,
  body: Uint8Array,
): { signedHeaders: string[]; valid: boolean } {
  const authorization = request.headers.get("authorization") ?? "";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (match === null) return { signedHeaders: [], valid: false };
  const [, accessKey, dateStamp, region, signedList, signature] = match;
  const signedHeaders = signedList!.split(";");
  const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
  const canonicalRequest = [
    request.method,
    new URL(request.url).pathname,
    "",
    signedHeaders
      .map((name) => `${name}:${(request.headers.get(name) ?? "").trim()}\n`)
      .join(""),
    signedList,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.headers.get("x-amz-date") ?? "",
    `${dateStamp}/${region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp!), region!), "s3"),
    "aws4_request",
  );
  const expected = Buffer.from(hmac(key, stringToSign)).toString("hex");
  return {
    signedHeaders,
    valid:
      accessKey === ACCESS_KEY &&
      expected === signature &&
      payloadHash === sha256Hex(body),
  };
}

/** Local R2 stand-in that verifies every signature and can mimic a re-encoding hop. */
class SigningR2 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  readonly seen: Seen[] = [];
  etagStyle: "stored" | "gzip" | "weak" = "stored";
  putEtagStyle: "stored" | "gzip" = "stored";
  server: ReturnType<typeof Bun.serve> | null = null;
  private generation = 0;

  start(): string {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.handle(request),
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  reset(): void {
    this.objects.clear();
    this.seen.length = 0;
    this.etagStyle = "stored";
    this.putEtagStyle = "stored";
  }

  store(key: string, body: string): string {
    this.generation += 1;
    const etag = `"s${this.generation}"`;
    this.objects.set(key, { body, etag });
    return etag;
  }

  count(method: string): number {
    return this.seen.filter((r) => r.method === method).length;
  }

  private presented(etag: string, style: SigningR2["etagStyle"]): string {
    if (style === "gzip") return `${etag.slice(0, -1)}-gzip"`;
    if (style === "weak") return `W/${etag}`;
    return etag;
  }

  private async handle(request: Request): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    const key = decodeURIComponent(
      new URL(request.url).pathname.replace(/^\/bucket\//, ""),
    );
    const { signedHeaders, valid } = verifySigV4(request, body);
    this.seen.push({
      method: request.method,
      key,
      headers: new Headers(request.headers),
      signedHeaders,
      signatureValid: valid,
    });
    if (!valid) return new Response("SignatureDoesNotMatch", { status: 403 });
    const current = this.objects.get(key);
    if (request.method === "GET" || request.method === "HEAD") {
      if (current === undefined) return new Response(null, { status: 404 });
      return new Response(request.method === "GET" ? current.body : null, {
        headers: { etag: this.presented(current.etag, this.etagStyle) },
      });
    }
    const ifMatch = request.headers.get("if-match");
    const ifNoneMatch = request.headers.get("if-none-match");
    if (
      (ifMatch !== null && ifMatch !== current?.etag) ||
      (ifNoneMatch === "*" && current !== undefined)
    ) {
      return new Response(null, { status: 412 });
    }
    const etag = this.store(key, new TextDecoder().decode(body));
    return new Response(null, {
      headers: { etag: this.presented(etag, this.putEtagStyle) },
    });
  }
}

const r2 = new SigningR2();
let endpoint = "";

beforeAll(() => {
  endpoint = r2.start();
});

afterAll(() => {
  r2.server?.stop(true);
});

const auth = () => ({
  endpoint,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  sessionToken: SESSION_TOKEN,
});

function client(): R2S3Client {
  const backend = {
    async write(key: string, data: Uint8Array | string) {
      const body =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      r2.store(key, body);
      return new TextEncoder().encode(body).byteLength;
    },
    file(key: string) {
      const read = () => {
        const object = r2.objects.get(key);
        if (object === undefined) throw new Error(`NoSuchKey: ${key}`);
        return object.body;
      };
      return {
        text: async () => read(),
        bytes: async () => new TextEncoder().encode(read()),
      };
    },
  } as unknown as R2S3ClientBackend;
  return R2S3Client.fromOptions(
    { bucket: "bucket", publicBase: "https://pub.test", ...auth() },
    backend,
  );
}

function spyFetch(): { fetchImpl: typeof fetch; inits: BunFetchRequestInit[] } {
  const inits: BunFetchRequestInit[] = [];
  const fetchImpl = (async (input: string, init: BunFetchRequestInit) => {
    inits.push(init);
    return fetch(input, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, inits };
}

function promote(c: R2S3Client, prevETag: string | null, generation: number) {
  return promoteCanonicalManifestWithCas({
    client: c,
    sinkId: "test-sink",
    prevETag,
    nextGenerationU32: generation,
    merkleRootSha256: "a".repeat(64),
    manifest: { generation },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function expectEverySetHeaderSigned(
  seen: Seen | undefined,
  init: BunFetchRequestInit | undefined,
): void {
  expect(seen?.signatureValid).toBe(true);
  const signed = new Set(seen?.signedHeaders);
  const ours = [...new Headers(init?.headers).keys()].filter(
    (name) => name !== "authorization",
  );
  expect(ours.length).toBeGreaterThan(0);
  expect(ours.filter((name) => !signed.has(name))).toEqual([]);
  expect(signed.has("host")).toBe(true);
  const unsignedOnWire = [...(seen?.headers.keys() ?? [])].filter(
    (name) => name !== "authorization" && !signed.has(name),
  );
  expect(
    unsignedOnWire.filter(
      (name) =>
        !(R2_BUN_ADDED_UNSIGNED_HEADERS as readonly string[]).includes(name),
    ),
  ).toEqual([]);
}

describe("SignedHeaders covers every header we set", () => {
  test("metadata CAS PUT: if-match, content-type, x-amz-meta-*, accept-encoding are signed", async () => {
    r2.reset();
    const prev = r2.store("obj", "old");
    const { fetchImpl, inits } = spyFetch();
    await client().writeWithMetadataResult("obj", "new", {
      type: "application/json",
      metadata: { Source: "test" },
      ifMatch: prev,
      fetchImpl,
    });
    const seen = r2.seen.find((r) => r.method === "PUT");
    expectEverySetHeaderSigned(seen, inits[0]);
    expect(seen?.signedHeaders).toEqual(
      expect.arrayContaining([
        "accept-encoding",
        "content-length",
        "content-type",
        "if-match",
        "x-amz-meta-source",
        "x-amz-security-token",
      ]),
    );
    expect(seen?.headers.get("if-match")).toBe(prev);
  });

  test("HEAD and GET sign accept-encoding and the session token", async () => {
    r2.reset();
    r2.store("ptr", "{}");
    const head = spyFetch();
    await client().headEtag("ptr", { fetchImpl: head.fetchImpl });
    expectEverySetHeaderSigned(
      r2.seen.find((r) => r.method === "HEAD"),
      head.inits[0],
    );
    const get = spyFetch();
    const response = await fetchSignedR2Read({
      auth: auth(),
      bucket: "bucket",
      key: "ptr",
      method: "GET",
      fetchImpl: get.fetchImpl,
    });
    expect(await response.text()).toBe("{}");
    expectEverySetHeaderSigned(
      r2.seen.find((r) => r.method === "GET"),
      get.inits[0],
    );
  });

  test("only Bun's Connection, User-Agent and Accept reach the wire unsigned", async () => {
    r2.reset();
    r2.store("ptr", "{}");
    await client().headEtag("ptr");
    const seen = r2.seen[0];
    const signed = new Set(seen?.signedHeaders);
    const unsigned = [...(seen?.headers.keys() ?? [])]
      .filter((name) => name !== "authorization" && !signed.has(name))
      .sort();
    expect(unsigned).toEqual([...R2_BUN_ADDED_UNSIGNED_HEADERS].sort());
  });
});

describe("identity encoding on signed requests", () => {
  test("GET, HEAD and PUT send accept-encoding: identity with decompress:false", async () => {
    r2.reset();
    r2.store("ptr", "{}");
    const { fetchImpl, inits } = spyFetch();
    const c = client();
    await c.headEtag("ptr", { fetchImpl });
    await fetchSignedR2Read({
      auth: auth(),
      bucket: "bucket",
      key: "ptr",
      method: "GET",
      fetchImpl,
    });
    await c.writeWithMetadata("ptr", "{}", {
      metadata: { source: "test" },
      fetchImpl,
    });
    expect(inits.map((init) => init.decompress)).toEqual([false, false, false]);
    expect(r2.seen.map((r) => r.headers.get("accept-encoding"))).toEqual([
      "identity",
      "identity",
      "identity",
    ]);
  });

  test("a gzip-tagged HEAD ETag throws R2EncodedETagError", async () => {
    r2.reset();
    r2.store("ptr", "{}");
    r2.etagStyle = "gzip";
    const error = await rejection(client().headEtag("ptr"));
    expect(error).toBeInstanceOf(R2EncodedETagError);
    expect(error).toMatchObject({
      code: "ERR_R2_ENCODED_ETAG",
      method: "HEAD",
      key: "ptr",
    });
  });

  test("a gzip-tagged GET ETag throws before the body is handed out", async () => {
    r2.reset();
    r2.store("ptr", "{}");
    r2.etagStyle = "gzip";
    const error = await rejection(
      fetchSignedR2Read({
        auth: auth(),
        bucket: "bucket",
        key: "ptr",
        method: "GET",
      }),
    );
    expect(error).toBeInstanceOf(R2EncodedETagError);
    expect(error).toMatchObject({ method: "GET" });
  });

  test("the CAS probe surfaces the named error and no If-Match PUT is sent", async () => {
    r2.reset();
    r2.store(MANIFEST, '{"generation":1}');
    r2.etagStyle = "gzip";
    const error = await rejection(probeR2ManifestState(client(), MANIFEST));
    expect(error).toBeInstanceOf(R2EncodedETagError);
    expect(mapR2ErrorExitCode(error)).toBe(74);
    expect(r2.count("PUT")).toBe(0);
  });

  test("a gzip-tagged PUT response ETag is refused, not returned as newETag", async () => {
    r2.reset();
    r2.putEtagStyle = "gzip";
    const error = await rejection(promote(client(), null, 1));
    expect(error).toBeInstanceOf(R2EncodedETagError);
    expect(error).toMatchObject({ method: "PUT" });
    expect(r2.count("HEAD")).toBe(0);
  });

  test("parseR2ETag refuses content-coding tags and keeps multipart and weak ETags", () => {
    for (const tagged of [
      '"abc-gzip"',
      '"abc+gzip"',
      '"abc;br"',
      '"abc-zstd"',
    ]) {
      expect(() => parseR2ETag(tagged, "k", "HEAD")).toThrow(
        R2EncodedETagError,
      );
    }
    expect(parseR2ETag(' "abc-3" ', "k", "HEAD")).toBe('"abc-3"');
    expect(parseR2ETag('W/"abc"', "k", "HEAD")).toBe('W/"abc"');
    expect(parseR2ETag("  ", "k", "HEAD")).toBeNull();
    expect(parseR2ETag(null, "k", "HEAD")).toBeNull();
  });
});

describe("weak ETags never reach If-Match", () => {
  test("normalizeStrongETag keeps W/ instead of upgrading it to strong", () => {
    expect(normalizeStrongETag(' W/"abc" ')).toBe('W/"abc"');
    expect(normalizeStrongETag('"abc"')).toBe('"abc"');
  });

  test("a weak prevETag throws R2WeakETagError before any write", async () => {
    r2.reset();
    const stored = r2.store(MANIFEST, '{"generation":1}');
    const objectsBefore = r2.objects.size;
    const error = await rejection(promote(client(), `W/${stored}`, 2));
    expect(error).toBeInstanceOf(R2WeakETagError);
    expect(error).toMatchObject({
      code: "ERR_R2_WEAK_ETAG",
      etag: `W/${stored}`,
      key: MANIFEST,
    });
    expect(mapR2ErrorExitCode(error)).toBe(74);
    expect(r2.seen).toHaveLength(0);
    expect(r2.objects.size).toBe(objectsBefore);
  });

  test("a weak ETag read by HEAD is returned as weak and refused by the CAS", async () => {
    r2.reset();
    r2.store(MANIFEST, '{"generation":1}');
    r2.etagStyle = "weak";
    const c = client();
    const probe = await probeR2ManifestState(c, MANIFEST);
    expect(probe.etag).toMatch(/^W\//);
    const error = await rejection(promote(c, probe.etag, 2));
    expect(error).toBeInstanceOf(R2WeakETagError);
    expect(r2.count("PUT")).toBe(0);
  });

  test("a direct weak ifMatch is refused without a request", async () => {
    r2.reset();
    const { fetchImpl, inits } = spyFetch();
    const error = await rejection(
      client().writeWithMetadata("obj", "x", {
        ifMatch: 'w/"abc"',
        fetchImpl,
      }),
    );
    expect(error).toBeInstanceOf(R2WeakETagError);
    expect(inits).toHaveLength(0);
  });

  test("a strong prevETag is sent verbatim as If-Match and promotes", async () => {
    r2.reset();
    const stored = r2.store(MANIFEST, '{"generation":1}');
    const result = await promote(client(), stored, 2);
    const put = r2.seen.find((r) => r.method === "PUT");
    expect(put?.headers.get("if-match")).toBe(stored);
    expect(result.newETag).toBe(r2.objects.get(MANIFEST)?.etag ?? "missing");
  });
});
