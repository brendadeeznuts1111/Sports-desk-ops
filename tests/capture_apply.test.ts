/**
 * apply_captures.ts — capture→evidence upgrade tests.
 *
 * These tests are hermetic: every case builds a throw-away root in the OS temp
 * directory with a small fixture ledger/spec, writes synthetic capture records,
 * and injects fake side effects, so nothing spawns a generator, formats a file,
 * opens WebView or touches the network.
 *
 * What is proven:
 *   - a valid live capture upgrades exactly one B row to A and recomputes counts
 *   - mock/offline captures are refused (they must never claim tier A)
 *   - a missing response, dirty redaction and mutation captures are refused
 *   - contradicted rows and non-B rows are skipped, not silently upgraded
 *   - applying the same capture twice is an idempotent no-op
 *   - any pipeline failure (generator or docs gate) restores the ledger, spec
 *     and markdown byte-for-byte and writes no audit record
 *   - a held lock refuses the write before anything is mutated
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCaptureRecord } from "../scripts/capture/recorder.ts";
import { captureHash } from "../scripts/capture/recorder.ts";
import {
  applyCaptures,
  captureRecordDigest,
  ISSUE_CODES,
  main,
  parseCaptureValue,
  sha256Hex,
  type ApplyDeps,
  type ApplyResult,
  type StepResult,
} from "../scripts/apply_captures.ts";

/* -------------------------------------------------------------------------- */
/* Fixture ledger + spec                                                      */
/* -------------------------------------------------------------------------- */

interface FixtureRow {
  readonly path: string;
  readonly method: string;
  readonly tier: "A" | "B" | "C" | "D" | "E";
  readonly contradicted?: boolean;
  readonly capturedResponse?: boolean;
}

const FIXTURE_ROWS: readonly FixtureRow[] = [
  {
    path: "/cloud/api/Manager/getBetTicker",
    method: "post",
    tier: "B",
  },
  {
    path: "/cloud/api/Manager/getBetTickerConfig",
    method: "post",
    tier: "B",
  },
  {
    path: "/cloud/api/Manager/getWebLog",
    method: "post",
    tier: "B",
    contradicted: true,
  },
  {
    path: "/cloud/api/Manager/getPending",
    method: "post",
    tier: "C",
  },
  {
    path: "/api/desk/auth/session",
    method: "post",
    tier: "E",
  },
];

/** Fixture spec omits getBetTickerConfig on purpose (tests E_SPEC_OP_MISSING). */
const SPEC_PATHS = new Set([
  "/cloud/api/Manager/getBetTicker",
  "/cloud/api/Manager/getWebLog",
  "/cloud/api/Manager/getPending",
  "/cloud/api/Manager/updateByColumn",
  "/api/desk/auth/session",
]);

function fixtureCounts(rows: readonly FixtureRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
    total: rows.length,
  };
  for (const row of rows) counts[row.tier] = (counts[row.tier] ?? 0) + 1;
  return counts;
}

function ledgerFixture(rows: readonly FixtureRow[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generated: "2026-10-31",
    generatedBy: "capture_apply fixture",
    counts: fixtureCounts(rows),
    surfaceCounts: { D: 0, E: 0, total: 0 },
    countsByTag: {},
    operations: rows.map((row) => ({
      path: row.path,
      method: row.method,
      operationId: null,
      tag: "Fixture",
      tier: row.tier,
      capturedResponse: row.capturedResponse === true,
      contradicted: row.contradicted === true,
      contradictedReason:
        row.contradicted === true ? "fixture contradiction" : null,
      evidence: [
        {
          source: "fixture:custody",
          kind: "none",
          note: "fixture row for capture-apply tests",
        },
      ],
      requiredCapture: "fixture: capture this operation",
    })),
    surfaces: [],
  };
}

function specFixture(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const path of SPEC_PATHS) paths[path] = { post: { responses: {} } };
  return {
    openapi: "3.1.0",
    info: { title: "capture-apply fixture", version: "0.0.0" },
    paths,
  };
}

function writeJson(path: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(path, bytes);
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Fixture capture records                                                   */
/* -------------------------------------------------------------------------- */

interface CaptureFixtureOptions {
  readonly path?: string;
  readonly method?: string;
  readonly mode?: string;
  readonly status?: number;
  readonly response?: unknown;
  readonly redactionClean?: boolean;
  readonly schemaVersion?: number;
}

function captureFixture(
  options: CaptureFixtureOptions = {},
): Record<string, unknown> {
  const path = options.path ?? "/cloud/api/Manager/getBetTicker";
  const response =
    options.response === undefined
      ? {
          status: options.status ?? 200,
          contentType: "application/json",
          bodySha256: sha256Hex('{"INFO":true,"LIST":[]}'),
          bodySkeleton: { INFO: "boolean", LIST: "array" },
          bytes: 42,
        }
      : options.response;
  return {
    schemaVersion: options.schemaVersion ?? 1,
    mode: options.mode ?? "live",
    capturedAt: "2026-10-31T12:34:56.000Z",
    operation: { path, method: options.method ?? "POST", operationId: null },
    request: {
      url: `https://www.fantasy402.com${path}`,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      contentType: "application/x-www-form-urlencoded",
      bodySha256: sha256Hex("operation=fixture&RRO=1"),
      bodySkeleton: { operation: "string", RRO: "string" },
    },
    response,
    redaction: {
      policyVersion: 1,
      clean: options.redactionClean ?? true,
      fieldsRedacted: ["Cookie", "Authorization", "customerID"],
      piiRedacted: true,
    },
    provenance: {
      portalHost: "www.fantasy402.com",
      proxy: "env",
      auth: "cookie",
      bunVersion: "1.4.4",
    },
    samples: 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Temp roots and fake side effects                                          */
/* -------------------------------------------------------------------------- */

const tempDirs: string[] = [];

function makeRoot(): { root: string; capturesDir: string; dateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "capture-apply-"));
  tempDirs.push(root);
  const docs = join(root, "docs");
  const evidence = join(docs, "evidence");
  const capturesDir = join(evidence, "captures");
  const dateDir = join(capturesDir, "2026-10-31");
  mkdirSync(dateDir, { recursive: true });
  writeJson(join(evidence, "ledger.json"), ledgerFixture(FIXTURE_ROWS));
  writeJson(join(docs, "openapi.json"), specFixture());
  writeFileSync(join(docs, "api-reference.md"), "# fixture api reference\n");
  return { root, capturesDir, dateDir };
}

function writeCapture(
  dir: string,
  name: string,
  value: Record<string, unknown>,
): { path: string; digest: string } {
  const path = join(dir, name);
  writeJson(path, value);
  return { path, digest: captureRecordDigest(value) };
}

interface FakeDepsOptions {
  readonly spec?: StepResult;
  readonly markdown?: StepResult;
  readonly verify?: StepResult;
  readonly format?: StepResult;
}

const OK_STEP: StepResult = { ok: true, code: 0, stdout: "", stderr: "" };

function makeDeps(options: FakeDepsOptions = {}): {
  deps: ApplyDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: ApplyDeps = {
    regenerateSpec: () => {
      calls.push("spec");
      return options.spec ?? OK_STEP;
    },
    regenerateMarkdown: () => {
      calls.push("markdown");
      return options.markdown ?? OK_STEP;
    },
    verifyDocs: () => {
      calls.push("verify");
      return options.verify ?? OK_STEP;
    },
    formatFile: () => {
      calls.push("format");
      return options.format ?? OK_STEP;
    },
    now: () => new Date("2026-10-31T18:00:00.000Z"),
    log: () => {},
  };
  return { deps, calls };
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function ledgerAt(root: string): Record<string, unknown> {
  return JSON.parse(
    readText(join(root, "docs", "evidence", "ledger.json")),
  ) as Record<string, unknown>;
}

function rowByPath(
  ledger: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const operations = ledger.operations;
  if (!Array.isArray(operations)) throw new Error("fixture ledger has no rows");
  const row = operations.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).path === path,
  );
  if (row === undefined)
    throw new Error(`fixture ledger has no row for ${path}`);
  return row;
}

function auditFiles(capturesDir: string): string[] {
  if (!existsSync(capturesDir)) return [];
  return readdirSync(capturesDir).filter((name) => name.startsWith("applied-"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("apply_captures", () => {
  test("upgrades a live B row to A, appends capture evidence and recomputes counts", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    const capture = writeCapture(
      dateDir,
      "getbetticker.post.json",
      captureFixture(),
    );
    const { deps, calls } = makeDeps();

    const dryRun = applyCaptures(
      { root, capturesDir, write: false, json: false },
      deps,
    );
    expect(dryRun.ok).toBe(true);
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.upgrades).toHaveLength(1);
    expect(dryRun.upgrades[0]?.evidenceSource).toBe(
      `capture:2026-10-31:${capture.digest}`,
    );
    expect(dryRun.countsBefore).toEqual({
      A: 0,
      B: 3,
      C: 1,
      D: 0,
      E: 1,
      total: 5,
    });
    expect(dryRun.countsAfter).toEqual({
      A: 1,
      B: 2,
      C: 1,
      D: 0,
      E: 1,
      total: 5,
    });
    expect(dryRun.applied).toBe(false);
    expect(calls).toEqual([]);
    expect(
      rowByPath(ledgerAt(root), "/cloud/api/Manager/getBetTicker").tier,
    ).toBe("B");

    const written = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(written.ok).toBe(true);
    expect(written.applied).toBe(true);
    expect(written.failureKind).toBeNull();
    expect(calls).toEqual(["format", "spec", "markdown", "verify"]);

    const ledger = ledgerAt(root);
    const row = rowByPath(ledger, "/cloud/api/Manager/getBetTicker");
    expect(row.tier).toBe("A");
    expect(row.capturedResponse).toBe(true);
    expect(row.requiredCapture).toBeNull();
    expect(row.resolution).toBeUndefined();
    const evidence = row.evidence;
    expect(Array.isArray(evidence)).toBe(true);
    const sources = (evidence as unknown[])
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
      )
      .map((entry) => entry.source);
    expect(sources).toContain(`capture:2026-10-31:${capture.digest}`);
    expect(ledger.counts).toEqual({
      A: 1,
      B: 2,
      C: 1,
      D: 0,
      E: 1,
      total: 5,
    });
    expect(written.auditRecord).not.toBeNull();
    expect(auditFiles(capturesDir)).toEqual(["applied-2026-10-31.json"]);
  });

  test("refuses mock captures and never claims tier A", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "mock.post.json", captureFixture({ mode: "mock" }));
    const { deps, calls } = makeDeps();

    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections[0]?.code).toBe(ISSUE_CODES.MODE_NOT_LIVE);
    expect(result.rejections[0]?.message).toMatch(
      /mock\/offline captures never upgrade/i,
    );
    expect(calls).toEqual([]);
    expect(
      rowByPath(ledgerAt(root), "/cloud/api/Manager/getBetTicker").tier,
    ).toBe("B");
  });

  test("refuses a capture without a response", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "no-response.post.json",
      captureFixture({ response: null }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections[0]?.code).toBe(ISSUE_CODES.RESPONSE_MISSING);
  });

  test("refuses a capture whose redaction report is not clean", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "dirty.post.json",
      captureFixture({ redactionClean: false }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections[0]?.code).toBe(ISSUE_CODES.REDACTION);
    expect(result.rejections[0]?.message).toMatch(/secrets|PII|clean/i);
  });

  test("refuses a mutation capture", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "mutation.post.json",
      captureFixture({ path: "/cloud/api/Manager/updateByColumn" }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections[0]?.code).toBe(ISSUE_CODES.OP_NOT_ALLOWED);
    expect(result.rejections[0]?.message).toMatch(/state mutation/i);
  });

  test("upgrades a C row from a valid live capture (full-shape capture)", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "tier-c.post.json",
      captureFixture({ path: "/cloud/api/Manager/getPending" }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      makeDeps().deps,
    );
    expect(result.upgrades).toHaveLength(1);
    expect(result.applied).toBe(true);
    expect(result.upgrades[0]?.operation).toBe("getPending");
    expect(
      rowByPath(ledgerAt(root), "/cloud/api/Manager/getPending").tier,
    ).toBe("A");
  });

  test("upgrades a contradicted B row from a valid live capture and records the resolution", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    const capture = writeCapture(
      dateDir,
      "contradicted.post.json",
      captureFixture({ path: "/cloud/api/Manager/getWebLog" }),
    );
    const { deps } = makeDeps();

    const plan = applyCaptures(
      { root, capturesDir, write: false, json: false },
      deps,
    );
    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]?.resolvesContradiction).toBe(true);
    expect(plan.upgrades[0]?.previousContradictionReason).toBe(
      "fixture contradiction",
    );

    const written = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(written.ok).toBe(true);
    expect(written.applied).toBe(true);

    const row = rowByPath(ledgerAt(root), "/cloud/api/Manager/getWebLog");
    expect(row.tier).toBe("A");
    expect(row.capturedResponse).toBe(true);
    expect(row.contradicted).toBe(false);
    expect(row.contradictedReason).toBeNull();
    expect(row.requiredCapture).toBeNull();
    expect(row.resolution).toEqual({
      resolvedBy: "capture:2026-10-31/contradicted.post.json",
      resolvedAt: "2026-10-31T18:00:00.000Z",
      previousReason: "fixture contradiction",
    });
    const sources = (row.evidence as unknown[])
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
      )
      .map((entry) => entry.source);
    expect(sources).toContain(`capture:2026-10-31:${capture.digest}`);
  });

  test("leaves a contradicted row untouched when no valid live capture exists", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "contradicted-mock.post.json",
      captureFixture({ path: "/cloud/api/Manager/getWebLog", mode: "mock" }),
    );
    writeCapture(
      dateDir,
      "contradicted-no-response.post.json",
      captureFixture({ path: "/cloud/api/Manager/getWebLog", response: null }),
    );
    const before = readText(join(root, "docs", "evidence", "ledger.json"));
    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      makeDeps().deps,
    );
    expect(result.applied).toBe(false);
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections.map((rejection) => rejection.code).sort()).toEqual(
      [ISSUE_CODES.MODE_NOT_LIVE, ISSUE_CODES.RESPONSE_MISSING],
    );
    expect(readText(join(root, "docs", "evidence", "ledger.json"))).toBe(
      before,
    );
    const row = rowByPath(ledgerAt(root), "/cloud/api/Manager/getWebLog");
    expect(row.contradicted).toBe(true);
    expect(row.contradictedReason).toBe("fixture contradiction");
    expect(row.tier).toBe("B");
    expect(row.resolution).toBeUndefined();
  });

  test("refuses a capture whose operation is missing from the spec", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(
      dateDir,
      "spec-missing.post.json",
      captureFixture({ path: "/cloud/api/Manager/getBetTickerConfig" }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.upgrades).toHaveLength(0);
    expect(result.rejections[0]?.code).toBe(ISSUE_CODES.SPEC_OP_MISSING);
  });

  test("plans a mixed store honestly: one upgrade, refusals and skips separated", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "valid.post.json", captureFixture());
    writeCapture(dateDir, "mock.post.json", captureFixture({ mode: "mock" }));
    writeCapture(
      dateDir,
      "no-response.post.json",
      captureFixture({ response: null }),
    );
    writeCapture(
      dateDir,
      "dirty.post.json",
      captureFixture({ redactionClean: false }),
    );
    writeCapture(
      dateDir,
      "mutation.post.json",
      captureFixture({ path: "/cloud/api/Manager/updateByColumn" }),
    );
    writeCapture(
      dateDir,
      "contradicted.post.json",
      captureFixture({ path: "/cloud/api/Manager/getWebLog" }),
    );
    writeCapture(
      dateDir,
      "tier-c.post.json",
      captureFixture({ path: "/cloud/api/Manager/getPending" }),
    );
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.ok).toBe(true);
    expect(result.capturesFound).toBe(7);
    expect(result.upgrades.map((upgrade) => upgrade.operation).sort()).toEqual([
      "getBetTicker",
      "getPending",
      "getWebLog",
    ]);
    expect(
      result.upgrades.find((upgrade) => upgrade.operation === "getWebLog")
        ?.resolvesContradiction,
    ).toBe(true);
    expect(result.skips).toHaveLength(0);
    expect(result.rejections).toHaveLength(4);
    expect(result.countsAfter).toEqual({
      A: 3,
      B: 1,
      C: 0,
      D: 0,
      E: 1,
      total: 5,
    });
  });

  test("is idempotent: applying the same capture twice does not rewrite the ledger", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "getbetticker.post.json", captureFixture());
    const { deps } = makeDeps();

    const first = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(first.applied).toBe(true);
    const ledgerAfterFirst = readText(
      join(root, "docs", "evidence", "ledger.json"),
    );

    const second = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(second.ok).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.upgrades).toHaveLength(0);
    expect(second.skips[0]?.reason).toMatch(
      /already has capturedResponse:true/i,
    );
    expect(readText(join(root, "docs", "evidence", "ledger.json"))).toBe(
      ledgerAfterFirst,
    );
    expect(auditFiles(capturesDir)).toHaveLength(1);
  });

  test("rolls back ledger, spec and markdown when the docs gate fails", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "getbetticker.post.json", captureFixture());
    const ledgerPath = join(root, "docs", "evidence", "ledger.json");
    const specPath = join(root, "docs", "openapi.json");
    const markdownPath = join(root, "docs", "api-reference.md");
    const beforeLedger = readText(ledgerPath);
    const beforeSpec = readText(specPath);
    const beforeMarkdown = readText(markdownPath);
    const { deps } = makeDeps({
      verify: {
        ok: false,
        code: 1,
        stdout: "RESULT: FAIL",
        stderr: "injected verify failure",
      },
    });

    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("write-failed");
    expect(result.applied).toBe(false);
    expect(result.countsAfter).toBeNull();
    expect(result.errors[0]).toMatch(/docs gate rejected/i);
    expect(result.errors[0]).toMatch(/restored/i);
    expect(readText(ledgerPath)).toBe(beforeLedger);
    expect(readText(specPath)).toBe(beforeSpec);
    expect(readText(markdownPath)).toBe(beforeMarkdown);
    expect(auditFiles(capturesDir)).toHaveLength(0);
    expect(
      rowByPath(ledgerAt(root), "/cloud/api/Manager/getBetTicker").tier,
    ).toBe("B");
  });

  test("rolls back when markdown regeneration fails", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "getbetticker.post.json", captureFixture());
    const ledgerPath = join(root, "docs", "evidence", "ledger.json");
    const beforeLedger = readText(ledgerPath);
    const { deps } = makeDeps({
      markdown: {
        ok: false,
        code: 1,
        stdout: "",
        stderr: "injected markdown failure",
      },
    });

    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("write-failed");
    expect(result.errors[0]).toMatch(/api-reference\.md regeneration failed/i);
    expect(readText(ledgerPath)).toBe(beforeLedger);
    expect(auditFiles(capturesDir)).toHaveLength(0);
  });

  test("refuses to write while another apply holds the lock", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "getbetticker.post.json", captureFixture());
    writeFileSync(join(capturesDir, ".apply.lock"), '{"pid":1}\n');
    const ledgerPath = join(root, "docs", "evidence", "ledger.json");
    const before = readText(ledgerPath);

    const result = applyCaptures(
      { root, capturesDir, write: true, json: false },
      makeDeps().deps,
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("input-error");
    expect(result.errors[0]).toMatch(/E_LOCK_HELD/);
    expect(readText(ledgerPath)).toBe(before);
  });

  test("uses the store manifest as an index and rejects stale hashes", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    const capture = writeCapture(
      dateDir,
      "getbetticker.post.json",
      captureFixture(),
    );
    const manifestPath = join(capturesDir, "manifest.json");
    writeJson(manifestPath, {
      schemaVersion: 1,
      store: "evidence-captures",
      generatedAt: "2026-10-31T15:00:00.000Z",
      policyVersion: 1,
      counts: {
        total: 2,
        live: 1,
        mock: 1,
        withResponse: 1,
        withoutResponse: 1,
        clean: 1,
        operations: ["getBetTicker"],
      },
      captures: [
        {
          file: "2026-10-31/getbetticker.post.json",
          mode: "live",
          capturedAt: "2026-10-31T12:34:56.000Z",
          operation: {
            path: "/cloud/api/Manager/getBetTicker",
            method: "POST",
          },
          captureHash: capture.digest,
          requestBodySha256: sha256Hex("operation=fixture&RRO=1"),
          responseStatus: 200,
          responseBodySha256: null,
          responseBytes: 42,
          redaction: {
            policyVersion: 1,
            clean: true,
            fieldsRedacted: 3,
            piiRedacted: 1,
          },
          provenance: {
            portalHost: "www.fantasy402.com",
            proxy: "env",
            auth: "cookie",
            bunVersion: "1.4.4",
          },
          samples: 1,
        },
        {
          file: "2026-10-31/missing.post.json",
          mode: "live",
          capturedAt: "2026-10-31T12:34:56.000Z",
          operation: {
            path: "/cloud/api/Manager/getBetTicker",
            method: "POST",
          },
          captureHash: sha256Hex("missing"),
          requestBodySha256: sha256Hex("x"),
          responseStatus: 200,
          responseBodySha256: null,
          responseBytes: 1,
          redaction: {
            policyVersion: 1,
            clean: true,
            fieldsRedacted: 0,
            piiRedacted: 0,
          },
          provenance: {
            portalHost: "www.fantasy402.com",
            proxy: "env",
            auth: "cookie",
            bunVersion: "1.4.4",
          },
          samples: 1,
        },
      ],
    });

    const withManifest = applyCaptures(
      { root, capturesDir, write: true, json: false },
      makeDeps().deps,
    );
    expect(withManifest.applied).toBe(true);
    expect(withManifest.upgrades[0]?.digest).toBe(capture.digest);
    expect(
      withManifest.rejections.some((rejection) =>
        rejection.message.includes(
          "manifest lists a capture file that is missing",
        ),
      ),
    ).toBe(true);

    // A stale hash must refuse the capture rather than mint a wrong evidence id.
    const { root: root2, capturesDir: dir2, dateDir: dateDir2 } = makeRoot();
    writeCapture(dateDir2, "getbetticker.post.json", captureFixture());
    writeJson(join(dir2, "manifest.json"), {
      schemaVersion: 1,
      captures: [
        {
          file: "2026-10-31/getbetticker.post.json",
          captureHash: sha256Hex("stale"),
        },
      ],
    });
    const stale = applyCaptures(
      { root: root2, capturesDir: dir2, write: false, json: false },
      makeDeps().deps,
    );
    expect(stale.upgrades).toHaveLength(0);
    expect(
      stale.rejections.some(
        (rejection) => rejection.code === ISSUE_CODES.MANIFEST,
      ),
    ).toBe(true);
    expect(
      stale.rejections.map((rejection) => rejection.message).join(" "),
    ).toMatch(/does not match the record/);
  });

  test("interoperates with the capture tooling's record builder and captureHash", () => {
    const record = buildCaptureRecord({
      mode: "live",
      capturedAt: "2026-10-31T12:34:56.000Z",
      operation: { path: "/cloud/api/Manager/getInfoManager", method: "POST" },
      request: {
        url: "https://www.fantasy402.com/cloud/api/Manager/getInfoManager",
        method: "POST",
        headers: {
          cookie: "session=fixture-not-real",
          authorization: "Bearer fixture-not-real",
          "content-type": "application/x-www-form-urlencoded",
        },
        contentType: "application/x-www-form-urlencoded",
        body: "operation=getInfoManager&agentID=DEMO-AGENT",
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
        bytes: new TextEncoder().encode(
          '{"balance":"0","grand-total-weekly":"0"}',
        ),
      },
      provenance: {
        portalHost: "www.fantasy402.com",
        proxy: "env",
        auth: "cookie",
        bunVersion: "1.4.4",
      },
    });

    // The tooling's own digest and ours must be the same string, byte for byte;
    // a divergence here would mint a different evidence id than the manifest.
    expect(captureRecordDigest(record)).toBe(captureHash(record));

    // A record the real writer produces must pass the apply validator unchanged
    // (schema drift between the store and the apply tool is a release failure).
    const parsed = parseCaptureValue(record);
    expect(parsed.issues).toEqual([]);
    expect(parsed.record?.operation.path).toBe(
      "/cloud/api/Manager/getInfoManager",
    );
    expect(parsed.record?.responseStatus).toBe(200);
  });

  test("a fixture-only store is a non-upgradeable PASS with an actionable note", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    // tests/fixtures/captures shape: transport fixtures, not capture records.
    writeCapture(dateDir, "getBetTicker.fixture.json", {
      fixtureVersion: 1,
      operation: { path: "/cloud/api/Manager/getBetTicker", method: "POST" },
      capturedAt: "2026-10-30T12:00:00.000Z",
      request: { form: { operation: "getBetTicker" } },
      response: { status: 200 },
    });
    const result = applyCaptures(
      { root, capturesDir, write: false, json: false },
      makeDeps().deps,
    );
    expect(result.ok).toBe(true);
    expect(result.upgrades).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/none of the 1 file\(s\) parsed/);
    expect(result.warnings.join(" ")).toMatch(/capture:evidence:live/);
  });

  test("a mock-only store exits 0 through the CLI with a nothing-to-upgrade note", () => {
    const { root, capturesDir, dateDir } = makeRoot();
    writeCapture(dateDir, "mock.post.json", captureFixture({ mode: "mock" }));
    const logs: string[] = [];
    const { deps } = makeDeps();
    const code = main(
      ["--dry-run", "--captures", capturesDir, "--root", root],
      { ...deps, log: (line) => logs.push(line) },
      root,
    );
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toMatch(/NOTE: no upgrade planned/);
    expect(output).toMatch(/PASS with nothing to upgrade/);
    expect(output).not.toMatch(/ERROR/);
  });

  test("reports a missing capture store as an actionable input error", () => {
    const { root } = makeRoot();
    const result: ApplyResult = applyCaptures(
      {
        root,
        capturesDir: join(root, "docs", "evidence", "captures-missing"),
        write: false,
        json: false,
      },
      makeDeps().deps,
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("input-error");
    expect(result.errors[0]).toMatch(/capture store not found/i);
  });
});

describe("capture digest single implementation", () => {
  test("captureRecordDigest is defined once, in apply_captures.ts", () => {
    // generate_openapi.ts carried a second copy of the canonical-JSON + sha256 pair. It agreed
    // with this one, which is exactly the dangerous state: two implementations that have not
    // drifted yet, in a repo where three copies of the ledger counts had.
    const definitions: string[] = [];
    for (const file of new Glob("scripts/**/*.ts").scanSync({
      cwd: resolve(import.meta.dir, ".."),
    })) {
      const source = readFileSync(
        resolve(import.meta.dir, "../", file),
        "utf8",
      );
      if (/function\s+captureRecordDigest\s*\(/.test(source))
        definitions.push(file);
    }
    expect(definitions).toEqual(["scripts/apply_captures.ts"]);
  });

  test("the generator imports the shared digest instead of recomputing it", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../scripts/generate_openapi.ts"),
      "utf8",
    );
    expect(source).toContain(
      'import { captureRecordDigest } from "./apply_captures.ts"',
    );
    expect(source).not.toMatch(/function\s+canonicalizeJsonValue\s*\(/);
  });
});
