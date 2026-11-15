import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAS_CONFLICT_EXIT_CODE,
  MANIFEST_BUCKET,
  MANIFEST_KEYS,
  ManifestCasError,
  promoteManifest,
} from "./r2_manifest_cas_promote.ts";

type MockObject = { body: Uint8Array; etag: string };

/** Path-style S3 mock that enforces If-Match / If-None-Match on PUT like R2 does. */
function startMockS3() {
  const objects = new Map<string, MockObject>();
  const putHeaders: Headers[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const current = objects.get(key);
      if (request.method === "PUT") {
        putHeaders.push(request.headers);
        const ifMatch = request.headers.get("if-match");
        const ifNoneMatch = request.headers.get("if-none-match");
        if (
          ifMatch !== null &&
          (current === undefined || current.etag !== ifMatch)
        ) {
          return new Response(null, { status: 412 });
        }
        if (ifNoneMatch === "*" && current !== undefined)
          return new Response(null, { status: 412 });
        const body = new Uint8Array(await request.arrayBuffer());
        const etag = `"${new Bun.CryptoHasher("md5").update(body).digest("hex")}"`;
        objects.set(key, { body, etag });
        return new Response(null, { status: 200, headers: { etag } });
      }
      if (current === undefined) return new Response(null, { status: 404 });
      const headers = {
        etag: current.etag,
        "content-length": String(current.body.byteLength),
        "last-modified": new Date(0).toUTCString(),
      };
      if (request.method === "HEAD")
        return new Response(null, { status: 200, headers });
      return new Response(current.body, { status: 200, headers });
    },
  });
  return { server, objects, putHeaders };
}

let mock: ReturnType<typeof startMockS3>;
let store: Bun.S3Client;
const encoder = new TextEncoder();

beforeAll(() => {
  mock = startMockS3();
  store = new Bun.S3Client({
    accessKeyId: "fixture-access-key",
    secretAccessKey: "fixture-secret-key",
    endpoint: `http://127.0.0.1:${mock.server.port}`,
    bucket: MANIFEST_BUCKET,
  });
});

afterAll(() => mock.server.stop(true));

describe("manifest CAS promotion via presigned PUT + If-Match", () => {
  test("covers exactly the two governed keys", () => {
    expect([...MANIFEST_KEYS]).toEqual([
      "manifests/a11y-gate/latest",
      "manifests/spec-governance/latest",
    ]);
  });

  test("creates an absent key with If-None-Match: *", async () => {
    const key = "manifests/a11y-gate/latest";
    const result = await promoteManifest({
      store,
      key,
      body: encoder.encode('{"run":1}'),
    });
    expect(result.outcome).toBe("created");
    expect(result.previousEtag).toBeNull();
    expect(mock.putHeaders.at(-1)?.get("if-none-match")).toBe("*");
    expect(mock.objects.get(`${MANIFEST_BUCKET}/${key}`)?.etag).toBe(
      result.newEtag ?? "",
    );
  });

  test("stat() etag is quoted and sent verbatim as If-Match; current etag gives 200", async () => {
    const key = "manifests/a11y-gate/latest";
    const before = (await store.stat(key)).etag;
    expect(before).toMatch(/^"[0-9a-f]{32}"$/);
    const result = await promoteManifest({
      store,
      key,
      body: encoder.encode('{"run":2}'),
    });
    expect(result).toMatchObject({
      outcome: "promoted",
      previousEtag: before,
      rebases: 0,
    });
    expect(mock.putHeaders.at(-1)?.get("if-match")).toBe(before);
    expect(new TextDecoder().decode(await store.file(key).arrayBuffer())).toBe(
      '{"run":2}',
    );
  });

  test("identical bytes are a no-op without a PUT", async () => {
    const key = "manifests/a11y-gate/latest";
    const puts = mock.putHeaders.length;
    const result = await promoteManifest({
      store,
      key,
      body: encoder.encode('{"run":2}'),
    });
    expect(result.outcome).toBe("unchanged");
    expect(mock.putHeaders.length).toBe(puts);
  });

  test("stale etag gives 412 and fails after a single attempt with zero rebases", async () => {
    const key = "manifests/spec-governance/latest";
    await promoteManifest({ store, key, body: encoder.encode('{"v":1}') });
    const racingFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        await fetch(store.presign(key, { method: "PUT", expiresIn: 60 }), {
          method: "PUT",
          body: '{"v":"racer"}',
        });
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const puts = mock.putHeaders.length;
    const failure = await promoteManifest({
      store,
      key,
      body: encoder.encode('{"v":2}'),
      fetchImpl: racingFetch,
    }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ManifestCasError);
    expect((failure as ManifestCasError).code).toBe(
      "ERR_MANIFEST_CAS_CONFLICT_412",
    );
    expect(mock.putHeaders.length - puts).toBe(2);
    expect(new TextDecoder().decode(await store.file(key).arrayBuffer())).toBe(
      '{"v":"racer"}',
    );
  });

  test("an unquoted etag is rejected by the store (etag must be stored verbatim)", async () => {
    const key = "manifests/spec-governance/latest";
    const quoted = (await store.stat(key)).etag;
    const response = await fetch(
      store.presign(key, { method: "PUT", expiresIn: 60 }),
      {
        method: "PUT",
        headers: { "If-Match": quoted.replaceAll('"', "") },
        body: "x",
      },
    );
    expect(response.status).toBe(412);
  });

  test("dry-run reads but never writes", async () => {
    const puts = mock.putHeaders.length;
    const result = await promoteManifest({
      store,
      key: "manifests/spec-governance/latest",
      body: encoder.encode("new"),
      dryRun: true,
    });
    expect(result.outcome).toBe("dry-run");
    expect(mock.putHeaders.length).toBe(puts);
  });

  test("CLI exits 3 on a 412 conflict and never prints credential values", async () => {
    const key = "manifests/a11y-gate/latest";
    const dir = mkdtempSync(join(tmpdir(), "cas-cli-"));
    const manifestPath = join(dir, "a11y.json");
    writeFileSync(manifestPath, '{"cli":true}');
    const etagBefore = (await store.stat(key)).etag;
    const preload = join(dir, "race.ts");
    writeFileSync(
      preload,
      `const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (init?.method === "PUT") await realFetch(String(input), { method: "PUT", headers: { "If-Match": ${JSON.stringify(etagBefore)} }, body: "racer" });
  return realFetch(input, init);
}, { preconnect: realFetch.preconnect });
`,
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(import.meta.dir, "r2_manifest_cas_promote.ts"),
        "--a11y-gate",
        manifestPath,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          R2_ACCESS_KEY_ID: "fixture-access-key",
          R2_SECRET_ACCESS_KEY: "fixture-secret-key",
          R2_BUCKET_NAME: MANIFEST_BUCKET,
          S3_ENDPOINT: `http://127.0.0.1:${mock.server.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(CAS_CONFLICT_EXIT_CODE);
    expect(stderr).toContain("ERR_MANIFEST_CAS_CONFLICT_412");
    expect(`${stdout}${stderr}`).not.toContain("fixture-secret-key");
  });

  test("CLI rejects missing manifests with a usage error", async () => {
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "r2_manifest_cas_promote.ts")],
      {
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain(
      "ERR_MANIFEST_CAS_USAGE",
    );
  });
});
