import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  R2_BUN_ADDED_UNSIGNED_HEADERS,
  R2_ERROR_CODES,
  R2_HTTP_HEADER,
  R2_IDENTITY_ENCODING_HEADERS,
  R2_IDENTITY_GET_HEADERS,
  R2_UNSIGNED_PAYLOAD,
  R2EncodedETagError,
  R2EncodedResponseError,
  R2WeakETagError,
  assertStrongETag,
  isR2ErrorCode,
  isWeakETag,
  parseR2ETag,
  parseStrongETag,
  type R2GetObjectResult,
  type R2HeadObjectResult,
  type R2PutObjectResult,
  type StrongETag,
} from "../lib/r2_http_contracts.ts";

const ROOT = join(import.meta.dir, "..");
const SCAN_TREES = [
  "lib",
  "src",
  "services",
  "scripts",
  "packages/sportsdesk-ops",
] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/**
 * Frozen counts of raw header-name literals outside `lib/r2_http_contracts.ts`.
 * New sites fail this test; a removed site must drop its count (ratchet down).
 */
const RAW_HEADER_ALLOWLIST: ReadonlyArray<
  readonly [file: string, token: string, count: number]
> = [
  ["lib/blob_ingest.ts", "content-encoding", 1],
  ["lib/docs_server.ts", "accept-encoding", 3],
  ["lib/docs_server.ts", "content-encoding", 1],
  ["lib/docs_server.ts", "if-none-match", 1],
  ["lib/f402_cdn_pin.ts", "etag", 1],
  ["lib/f402_in_page_fetch.ts", "accept-encoding", 1],
  ["lib/f402_in_page_fetch.ts", "content-encoding", 1],
  ["lib/http_compression.ts", "accept-encoding", 4],
  ["lib/http_compression.ts", "content-encoding", 3],
  ["lib/r2_s3_client.ts", "etag", 1],
  ["lib/r2_s3_client.ts", "if-match", 1],
  ["lib/r2_s3_client.ts", "if-none-match", 1],
  ["lib/r2_s3_client.ts", "x-amz-content-sha256", 1],
  ["lib/static_dir_probe.ts", "etag", 1],
  ["lib/static_dir_probe.ts", "if-none-match", 1],
  [
    "packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts",
    "content-encoding",
    1,
  ],
  ["scripts/capture/redact.ts", "accept-encoding", 1],
  ["scripts/dashboard_preview.ts", "accept-encoding", 1],
  ["scripts/dashboard_preview.ts", "content-encoding", 1],
  ["scripts/dev_dashboard.ts", "if-none-match", 3],
  ["scripts/r2_manifest_cas_promote.ts", "etag", 1],
  ["scripts/r2_manifest_cas_promote.ts", "if-match", 1],
  ["scripts/r2_manifest_cas_promote.ts", "if-none-match", 1],
  ["services/sportsdesk_ingestion_feed_provenance.ts", "etag", 1],
  ["services/sportsdesk_webview_server.ts", "accept-encoding", 3],
  ["services/sportsdesk_webview_server.ts", "etag", 1],
  ["services/sportsdesk_webview_server.ts", "if-none-match", 5],
  ["src/lib/syndicate_adjacency_rollup.ts", "etag", 1],
  ["src/lib/syndicate_adjacency_rollup.ts", "if-match", 1],
  ["src/lib/syndicate_adjacency_rollup.ts", "if-none-match", 1],
  ["src/lib/xml_ingest_r2_publish.ts", "if-match", 1],
];

const ALWAYS_HEADER_LITERAL =
  /["'](If-Match|If-None-Match|if-match|if-none-match|x-amz-content-sha256|X-Amz-Content-Sha256|accept-encoding|Accept-Encoding|content-encoding|Content-Encoding|UNSIGNED-PAYLOAD)["']/g;
const ETAG_HEADER_ACCESS =
  /\.(?:get|set|has|delete)\(\s*["']etag["']\s*[,)]|\[["']etag["']\]/gi;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed === "*/"
  );
}

function isTestFile(name: string): boolean {
  return name.includes(".test.") || name.endsWith(".test.ts");
}

function isSourceFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXT.has(name.slice(dot));
}

function walkSourceFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkSourceFiles(path, acc);
      continue;
    }
    if (stat.isFile() && isSourceFile(entry) && !isTestFile(entry)) {
      acc.push(path);
    }
  }
}

function scanRawHeaderLiterals(): Map<string, number> {
  const counts = new Map<string, number>();
  const files: string[] = [];
  for (const tree of SCAN_TREES) {
    const root = join(ROOT, tree);
    try {
      walkSourceFiles(root, files);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  for (const abs of files) {
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    if (rel === "lib/r2_http_contracts.ts") continue;
    const text = readFileSync(abs, "utf8");
    for (const line of text.split("\n")) {
      if (isCommentLine(line)) continue;
      ALWAYS_HEADER_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ALWAYS_HEADER_LITERAL.exec(line)) !== null) {
        const token = match[1]!.toLowerCase();
        const key = `${rel}\t${token}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ETAG_HEADER_ACCESS.lastIndex = 0;
      while (ETAG_HEADER_ACCESS.exec(line) !== null) {
        const key = `${rel}\tetag`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe("r2 http contracts", () => {
  test("identity header maps share accept-encoding: identity", () => {
    expect(R2_IDENTITY_ENCODING_HEADERS).toEqual({
      [R2_HTTP_HEADER.acceptEncoding]: "identity",
    });
    expect(R2_IDENTITY_GET_HEADERS).toBe(R2_IDENTITY_ENCODING_HEADERS);
    expect(R2_UNSIGNED_PAYLOAD).toBe("UNSIGNED-PAYLOAD");
    expect(R2_BUN_ADDED_UNSIGNED_HEADERS).toEqual([
      "connection",
      "user-agent",
      "accept",
    ]);
  });

  test("error-code registry is unique and guards unknown strings", () => {
    const values = Object.values(R2_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
    for (const code of values) {
      expect(code.startsWith("ERR_R2_")).toBe(true);
      expect(isR2ErrorCode(code)).toBe(true);
    }
    expect(isR2ErrorCode("ERR_PROXY_TUNNEL")).toBe(false);
    expect(isR2ErrorCode(R2_ERROR_CODES.WEAK_ETAG)).toBe(true);
  });

  test("isWeakETag and assertStrongETag refuse W/ tags", () => {
    expect(isWeakETag('W/"abc"')).toBe(true);
    expect(isWeakETag('w/"abc"')).toBe(true);
    expect(isWeakETag('"abc"')).toBe(false);
    const strong = assertStrongETag("manifests/latest", '"abc"');
    const branded: StrongETag = strong;
    expect(String(branded)).toBe('"abc"');
    expect(() => assertStrongETag("manifests/latest", 'W/"abc"')).toThrow(
      R2WeakETagError,
    );
    try {
      assertStrongETag("k", 'W/"x"');
    } catch (error) {
      expect(error).toBeInstanceOf(R2WeakETagError);
      expect(error as R2WeakETagError).toMatchObject({
        code: "ERR_R2_WEAK_ETAG",
        exitCode: 74,
        key: "k",
        etag: 'W/"x"',
      });
    }
  });

  test("parseR2ETag lets weak tags through and refuses encoded suffixes", () => {
    expect(parseR2ETag(null, "k", "GET")).toBeNull();
    expect(parseR2ETag("  ", "k", "HEAD")).toBeNull();
    expect(parseR2ETag('  W/"abc"  ', "k", "GET")).toBe('W/"abc"');
    expect(() => parseR2ETag('"abc-gzip"', "k", "GET")).toThrow(
      R2EncodedETagError,
    );
    expect(() => parseR2ETag('"abc+gzip"', "k", "HEAD")).toThrow(
      R2EncodedETagError,
    );
    try {
      parseR2ETag('"abc-gzip"', "obj", "PUT");
    } catch (error) {
      expect(error).toBeInstanceOf(R2EncodedETagError);
      expect(error as R2EncodedETagError).toMatchObject({
        code: "ERR_R2_ENCODED_ETAG",
        method: "PUT",
        key: "obj",
      });
    }
  });

  test("parseStrongETag brands a strong tag and fails on missing, weak, or encoded", () => {
    const etag = parseStrongETag(' "abc" ', "manifests/latest", "HEAD");
    const branded: StrongETag = etag;
    expect(String(branded)).toBe('"abc"');
    expect(() => parseStrongETag(null, "k")).toThrow(TypeError);
    expect(() => parseStrongETag('W/"abc"', "k")).toThrow(R2WeakETagError);
    expect(() => parseStrongETag('"abc-gzip"', "k", "GET")).toThrow(
      R2EncodedETagError,
    );
  });

  test("encoded-response error carries the Content-Encoding", () => {
    const error = new R2EncodedResponseError("chunks/ab.bin", "gzip");
    expect(error.code).toBe("ERR_R2_ENCODED_RESPONSE");
    expect(error.contentEncoding).toBe("gzip");
    expect(error.message).toContain("gzip");
  });

  test("HEAD/GET/PUT result shapes distinguish 404 from a body+etag pair", () => {
    const missing: R2GetObjectResult = {
      status: 404,
      etag: null,
      body: null,
    };
    const found: R2GetObjectResult = {
      status: 200,
      etag: '"abc"',
      body: new Uint8Array([1]),
    };
    const head: R2HeadObjectResult = {
      status: 200,
      etag: '"abc"',
      contentEncoding: "identity",
      contentLength: 1,
    };
    const put: R2PutObjectResult = { status: 200, etag: '"abc"' };
    expect(missing.body).toBeNull();
    expect(found.body.byteLength).toBe(1);
    expect(head.contentEncoding).toBe(
      R2_IDENTITY_ENCODING_HEADERS["accept-encoding"],
    );
    expect(put.etag).toBe('"abc"');
  });
});

describe("r2 http header literal ratchet", () => {
  test("raw header strings outside lib/r2_http_contracts.ts stay on the allowlist", () => {
    const actual = scanRawHeaderLiterals();
    const expected = new Map<string, number>();
    for (const [file, token, count] of RAW_HEADER_ALLOWLIST) {
      expected.set(`${file}\t${token}`, count);
    }

    const unexpected: string[] = [];
    for (const [key, count] of [...actual.entries()].sort()) {
      const want = expected.get(key);
      if (want === undefined) {
        unexpected.push(`new ${key.replace("\t", " ")} x${count}`);
        continue;
      }
      if (count !== want) {
        unexpected.push(
          `count ${key.replace("\t", " ")} expected ${want} got ${count}`,
        );
      }
    }
    for (const [key, count] of [...expected.entries()].sort()) {
      if (!actual.has(key)) {
        unexpected.push(
          `removed ${key.replace("\t", " ")} (was ${count}; drop it from the allowlist)`,
        );
      }
    }
    expect(unexpected).toEqual([]);
  });
});
