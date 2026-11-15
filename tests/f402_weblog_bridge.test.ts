import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultWeblogCapturePath,
  resolveWeblogCorpusPaths,
  WEBLOG_BRIDGE_USAGE_HINT,
} from "../lib/f402_weblog_bridge_inputs.ts";
import {
  buildWeblogRollup,
  parseOperation,
  type WebLogRollup,
} from "../lib/f402_weblog.ts";
import { parseDataWindowEndMs } from "../lib/r2_pipeline_kpis.ts";
import {
  R2PreconditionFailedError,
  R2S3Client,
  type R2S3ClientBackend,
} from "../lib/r2_s3_client.ts";
import {
  assertSanitizedF402Weblog,
  formatWeblogBridgeHelp,
  publishF402WeblogRollup,
  type WeblogR2PublishClient,
} from "../scripts/f402_weblog_bridge.ts";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "t".repeat(32);

const weblogLine = (loginId: string, accessDateTime: string) =>
  JSON.stringify({
    AccessDateTime: accessDateTime,
    LoginID: loginId,
    IPAddress: "203.0.113.1",
    Operation: "login",
  });

describe("f402_weblog_bridge inputs", () => {
  test("defaultWeblogCapturePath matches staging convention", () => {
    expect(defaultWeblogCapturePath("2026-11-08")).toBe(
      "out/f402/weblog/11-08-2026.jsonl",
    );
  });

  test("--fetch-mode captures then returns that path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-bridge-"));
    const capturePath = join(dir, "capture.jsonl");
    const captured: { capturePath: string; mode: string }[] = [];
    const result = await resolveWeblogCorpusPaths(
      {
        "fetch-mode": "A",
        date: "2026-11-08",
        "save-capture": capturePath,
        "bearer-token": TOKEN,
      },
      {
        resolveToken: () => ({ token: TOKEN, source: "cli" as const }),
        fetchAndPersist: async (opts) => {
          captured.push({
            capturePath: opts.capturePath,
            mode: opts.request.mode,
          });
          writeFileSync(
            opts.capturePath,
            `${weblogLine("BB7884", "2026-11-08 12:00:00")}\n`,
            { mode: 0o600 },
          );
          return {
            rows: [],
            body: {},
            url: "https://mock.test/cloud/api/Manager/getWebLog",
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.paths).toEqual([capturePath]);
    expect(captured[0]?.capturePath).toBe(capturePath);
    expect(captured[0]?.mode).toBe("A");
    expect(existsSync(capturePath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("--fetch-mode B is rejected for activity rollup", async () => {
    const result = await resolveWeblogCorpusPaths({
      "fetch-mode": "B",
      date: "2026-11-08",
      "bearer-token": TOKEN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/not supported/);
    expect(result.message).toMatch(/LoginID, IPAddress/);
  });

  test("--from without --fetch-mode still resolves paths", async () => {
    const result = await resolveWeblogCorpusPaths({
      from: "a.jsonl,b.jsonl",
    });
    expect(result).toEqual({ ok: true, paths: ["a.jsonl", "b.jsonl"] });
  });

  test("neither --from nor --fetch-mode fails with hint", async () => {
    const result = await resolveWeblogCorpusPaths({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(WEBLOG_BRIDGE_USAGE_HINT);
  });
});

describe("f402_weblog_bridge CLI", () => {
  test("exits 2 with usage hint when no corpus source", () => {
    const proc = Bun.spawnSync(["bun", "scripts/f402_weblog_bridge.ts"], {
      cwd: ROOT,
      stderr: "pipe",
      stdout: "pipe",
      env: { ...Bun.env, F402_BEARER_TOKEN: "" },
    });
    expect(proc.exitCode).toBe(2);
    const err = proc.stderr.toString();
    expect(err).toContain("--from required");
    expect(err).toContain("--fetch-mode");
  });

  test("--from + --dry-run rolls up fixture jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-cli-"));
    try {
      const jsonl = join(dir, "corpus.jsonl");
      writeFileSync(jsonl, `${weblogLine("U1", "2026-11-08 10:00:00")}\n`, {
        mode: 0o600,
      });
      const bets = join(dir, "bets.jsonl");
      writeFileSync(bets, "", { mode: 0o600 });
      const out = join(dir, "rollup.json");
      const proc = Bun.spawnSync(
        [
          "bun",
          "scripts/f402_weblog_bridge.ts",
          "--from",
          jsonl,
          "--bets",
          bets,
          "--out",
          out,
          "--dry-run",
          "--no-r2",
        ],
        { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(existsSync(out)).toBe(false);
      expect(proc.stdout.toString()).toContain("gates");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sampleRollup(): WebLogRollup {
  const fromMs = Date.parse("2026-11-08T10:00:00.000Z");
  const toMs = Date.parse("2026-11-08T12:00:00.000Z");
  const parsed = parseOperation("login");
  return buildWeblogRollup(
    {
      total: 1,
      malformed: 0,
      templates: new Set([parsed.template]),
      rows: [
        {
          accessMs: fromMs + 60_000,
          loginId: "U1",
          ip: "203.0.113.10",
          ip32: null,
          ipv6Prefix64: null,
          operation: "login",
          ...parsed,
        },
      ],
    },
    [],
    fromMs,
    toMs,
  );
}

describe("f402_weblog_bridge Pass 1 guards & CAS", () => {
  test("--help and usage hint advertise --filter sportsdesk-ops weblog:rollup --fetch-mode A and never B/I or root-less aliases", () => {
    const help = formatWeblogBridgeHelp();
    expect(help).toContain(
      "bun run --filter sportsdesk-ops weblog:rollup --fetch-mode A",
    );
    expect(help).not.toContain("--fetch-mode B");
    expect(help).not.toContain("--fetch-mode I");
    expect(help).not.toContain("A|B");
    expect(help).not.toContain("Mode B");
    expect(help).not.toContain("Mode I");
    // No root-less `bun run weblog:rollup`
    expect(help).not.toMatch(/bun run\s+weblog:rollup/);

    const proc = Bun.spawnSync(
      ["bun", "scripts/f402_weblog_bridge.ts", "--help"],
      { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("bun run --filter sportsdesk-ops weblog:rollup");
    expect(out).not.toMatch(/bun run\s+weblog:rollup/);
    expect(out).not.toContain("--fetch-mode B");
  });

  test("assertSanitizedF402Weblog allows clean rollup with timestamps + numeric sessions.logins and rejects PII/IPs/oversize", () => {
    const rollup = sampleRollup();
    const clean = assertSanitizedF402Weblog({
      ...rollup,
      data_window_max_epoch_ms: rollup.window.toMs,
      r2_published_at_epoch_ms: rollup.window.toMs + 5_000,
    });
    expect(clean.byteLength).toBeGreaterThan(0);

    expect(() => assertSanitizedF402Weblog({ customerId: "C100" })).toThrow(
      /forbidden key/,
    );
    expect(() => assertSanitizedF402Weblog({ agentLogin: "AG1" })).toThrow(
      /forbidden key/,
    );
    expect(() => assertSanitizedF402Weblog({ logins: ["U1"] })).toThrow(
      /forbidden key/,
    );
    expect(() =>
      assertSanitizedF402Weblog({ note: "client 198.51.100.77 hit" }),
    ).toThrow(/raw IP literal/);
    expect(() =>
      assertSanitizedF402Weblog({ note: "peer 2001:db8::8a2e:370:7334" }),
    ).toThrow(/raw IP literal/);
    expect(() => assertSanitizedF402Weblog({ note: "loopback ::1" })).toThrow(
      /raw IP literal/,
    );
    expect(() =>
      assertSanitizedF402Weblog({ ok: true }, new Uint8Array(256 * 1024 + 1)),
    ).toThrow(/exceeds/);
  });

  test("publishF402WeblogRollup verifies stat.size, stamps dual-clock lineage, and promotes manifests/f402-weblog/latest with If-Match CAS", async () => {
    const rollup = sampleRollup();
    const writes: Array<{
      key: string;
      bytes: number;
      ifMatch?: string;
      ifNoneMatch?: string;
      metadata?: Readonly<Record<string, string>>;
      body: string;
    }> = [];
    const client: WeblogR2PublishClient = {
      publicBase: "https://example.r2.dev",
      async writeWithMetadata(key, data, opts) {
        const buf =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        writes.push({
          key,
          bytes: buf.byteLength,
          ...(opts?.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
          ...(opts?.ifNoneMatch !== undefined
            ? { ifNoneMatch: opts.ifNoneMatch }
            : {}),
          ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}),
          body: new TextDecoder().decode(buf),
        });
        return buf.byteLength;
      },
      async stat(key) {
        const last = writes.findLast((w) => w.key === key);
        return { size: last?.bytes ?? 0 };
      },
      async headEtag() {
        return '"etag-v1"';
      },
    };

    const nowMs = rollup.window.toMs + 30_000;
    const res = await publishF402WeblogRollup({ client, rollup, nowMs });
    expect(res.manifestKey).toBe("manifests/f402-weblog/latest");
    expect(res.manifestIfMatch).toBe('"etag-v1"');
    expect(res.manifestIfNoneMatch).toBeNull();
    expect(res.pointerOutcome).toBe("written");
    expect(res.dataWindowMaxEpochMs).toBe(rollup.window.toMs);
    expect(res.r2PublishedAtEpochMs).toBe(nowMs);

    const manifestWrite = writes.find(
      (w) => w.key === "manifests/f402-weblog/latest",
    );
    expect(manifestWrite?.ifMatch).toBe('"etag-v1"');
    expect(manifestWrite?.metadata?.["data-window-max-epoch-ms"]).toBe(
      String(rollup.window.toMs),
    );
    expect(manifestWrite?.metadata?.["r2-published-at-epoch-ms"]).toBe(
      String(nowMs),
    );
    const parsedManifest = JSON.parse(manifestWrite!.body);
    expect(parseDataWindowEndMs(parsedManifest)).toBe(rollup.window.toMs);
    expect(parsedManifest.r2_published_at_epoch_ms).toBe(nowMs);
  });

  test("publishF402WeblogRollup rejects stat.size mismatch and performs 0 rebases on HTTP 412", async () => {
    const rollup = sampleRollup();
    const badStatClient: WeblogR2PublishClient = {
      publicBase: "https://example.r2.dev",
      async writeWithMetadata(_k, data) {
        return typeof data === "string" ? data.length : data.byteLength;
      },
      async stat() {
        return { size: 1 };
      },
      async headEtag() {
        return null;
      },
    };
    await expect(
      publishF402WeblogRollup({ client: badStatClient, rollup }),
    ).rejects.toThrow(/size mismatch/);

    // Real R2S3Client fetch mock: verify 412 triggers 0 retries / 0 rebases
    const fetchCalls: Array<{
      method: string;
      url: string;
      ifMatch?: string;
      ifNoneMatch?: string;
    }> = [];
    const mockFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      fetchCalls.push({
        method,
        url,
        ...(headers.get("if-match")
          ? { ifMatch: headers.get("if-match")! }
          : {}),
        ...(headers.get("if-none-match")
          ? { ifNoneMatch: headers.get("if-none-match")! }
          : {}),
      });
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { etag: '"etag-prev"' },
        });
      }
      if (url.endsWith("/manifests/f402-weblog/latest")) {
        return new Response(null, { status: 412 });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const fakeBackend = {
      file() {
        throw new Error("unused");
      },
      async write() {
        return 0;
      },
      presign() {
        return "";
      },
      async stat() {
        const lastDaily = fetchCalls.find((c) => c.url.endsWith("rollup.json"));
        void lastDaily;
        return {
          size: assertSanitizedF402Weblog({
            ...rollup,
            data_window_max_epoch_ms: rollup.window.toMs,
            r2_published_at_epoch_ms: 1700000000000,
          }).byteLength,
          etag: '"daily"',
          lastModified: new Date(0),
          type: "application/json",
        };
      },
      async exists() {
        return false;
      },
      async size() {
        return 0;
      },
      async list() {
        throw new Error("unused");
      },
      async delete() {},
      async unlink() {},
    } as unknown as R2S3ClientBackend;

    const r2Client = R2S3Client.fromOptions(
      {
        bucket: "sportsdesk",
        endpoint: "https://r2.example.com",
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "SECRET_TEST",
        publicBase: "https://pub.example.com",
      },
      fakeBackend,
    );

    await expect(
      publishF402WeblogRollup({
        client: r2Client,
        rollup,
        nowMs: 1700000000000,
        fetchImpl: mockFetch,
      }),
    ).rejects.toBeInstanceOf(R2PreconditionFailedError);

    const manifestPuts = fetchCalls.filter(
      (c) =>
        c.method === "PUT" && c.url.endsWith("/manifests/f402-weblog/latest"),
    );
    expect(manifestPuts).toHaveLength(1);
    expect(manifestPuts[0]?.ifMatch).toBe('"etag-prev"');
    const latestPuts = fetchCalls.filter(
      (c) => c.method === "PUT" && c.url.endsWith("/f402-weblog/latest.json"),
    );
    expect(latestPuts).toHaveLength(0);
  });
  test("a pointer 412 is retried once while our manifest is still current", async () => {
    const rollup = sampleRollup();
    const manifestEtags: (string | null)[] = [null, '"m1"', '"m1"'];
    const pointerEtags: (string | null)[] = ['"p0"', '"p1"'];
    const pointerAttempts: Array<string | null> = [];
    const writes: Array<{ key: string; bytes: number }> = [];
    let failPointer = true;
    const client: WeblogR2PublishClient = {
      publicBase: "https://example.r2.dev",
      async writeWithMetadata(key, data, opts) {
        const buf =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        if (key === "f402-weblog/latest.json") {
          pointerAttempts.push(opts?.ifMatch ?? null);
          if (failPointer) {
            failPointer = false;
            throw new R2PreconditionFailedError(key);
          }
        }
        writes.push({ key, bytes: buf.byteLength });
        return buf.byteLength;
      },
      async stat(key) {
        const last = writes.findLast((w) => w.key === key);
        return { size: last?.bytes ?? 0 };
      },
      async headEtag(key) {
        if (key === "manifests/f402-weblog/latest") {
          return manifestEtags.shift() ?? null;
        }
        if (key === "f402-weblog/latest.json") {
          return pointerEtags.shift() ?? null;
        }
        return null;
      },
    };

    const res = await publishF402WeblogRollup({ client, rollup });
    expect(res.pointerOutcome).toBe("written");
    // the failed attempt used p0; the retry used the pointer's new ETag p1
    expect(pointerAttempts).toEqual(['"p0"', '"p1"']);
    // only the successful pointer write landed
    expect(
      writes.filter((w) => w.key === "f402-weblog/latest.json"),
    ).toHaveLength(1);
  });

  test("a pointer 412 leaves the pointer to a newer manifest", async () => {
    const rollup = sampleRollup();
    // before the manifest write, after it, and what the conflict check sees
    const manifestEtags: (string | null)[] = [null, '"m1"', '"m2"'];
    const pointerEtags: (string | null)[] = ['"p0"'];
    let pointerAttempts = 0;
    const writes: Array<{ key: string; bytes: number }> = [];
    const client: WeblogR2PublishClient = {
      publicBase: "https://example.r2.dev",
      async writeWithMetadata(key, data) {
        const buf =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        if (key === "f402-weblog/latest.json") {
          pointerAttempts += 1;
          throw new R2PreconditionFailedError(key);
        }
        writes.push({ key, bytes: buf.byteLength });
        return buf.byteLength;
      },
      async stat(key) {
        const last = writes.findLast((w) => w.key === key);
        return { size: last?.bytes ?? 0 };
      },
      async headEtag(key) {
        if (key === "manifests/f402-weblog/latest") {
          return manifestEtags.shift() ?? null;
        }
        if (key === "f402-weblog/latest.json") {
          return pointerEtags.shift() ?? null;
        }
        return null;
      },
    };

    const res = await publishF402WeblogRollup({ client, rollup });
    expect(res.pointerOutcome).toBe("superseded");
    expect(pointerAttempts).toBe(1);
  });
});
