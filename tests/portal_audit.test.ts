/**
 * Tests for the docs portal audit + tile crawler automation (task-9).
 *
 * No test may launch Bun.WebView or touch the network: every side-effecting
 * capability is injected. The offline path is proven by a runtime whose
 * createWebView()/fetchResource() throw if they are ever called.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAuditLock,
  EXPAND_SIDEBAR_EXPRESSION,
  parseAuditCliArgs,
  readAuditLock,
  releaseAuditLock,
  runDocumentationAudit,
  validateApiReferenceMarkdown,
  validateOpenApiDocumentFile,
  validateOpenApiSpec,
  type AuditRuntime,
  type WebViewHandle,
} from "../scripts/audit_docs_webview_cron.ts";
import {
  buildSelectorPresenceExpression,
  cssSelectorForTile,
  parseCrawlCliArgs,
  parseExtractedTileDom,
  runTileInspectionCrawl,
  TILE_EXTRACTION_EXPRESSION,
  UNMAPPED_LAUNCHER_TILES,
  type CrawlRuntime,
} from "../scripts/portal_tile_crawler.ts";

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(ROOT, "docs", "openapi.json");
const MARKDOWN_PATH = join(ROOT, "docs", "api-reference.md");
const FIXED_NOW = new Date("2026-10-30T12:00:00.000Z");
const PORTAL = "https://fantasy402-docs-4ay.pages.dev";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

interface CallLog {
  readonly calls: string[];
}

function makeOfflineRuntime(onCall: CallLog): AuditRuntime {
  return {
    async createWebView(): Promise<WebViewHandle> {
      onCall.calls.push("createWebView");
      throw new Error("offline audit must not launch Bun.WebView");
    },
    async fetchResource() {
      onCall.calls.push("fetchResource");
      throw new Error("offline audit must not touch the network");
    },
    async writeBytes(path: string, bytes: Uint8Array) {
      onCall.calls.push(`write:${path}`);
      writeFileSync(path, bytes);
    },
    mkdirp(path: string) {
      mkdirSync(path, { recursive: true });
    },
    now() {
      return FIXED_NOW;
    },
  };
}

interface FakeViewState {
  title: string;
  url: string;
  textLength: number;
  bodyText: string;
  hasScalarRoot: boolean;
  closed: boolean;
  expanded: boolean;
}

function makeFakeWebView(portalUrl: string): {
  readonly view: WebViewHandle;
  readonly state: FakeViewState;
} {
  const state: FakeViewState = {
    title: "SportsDesk & Fantasy402 Wire API Reference — evidence-labelled",
    url: portalUrl,
    textLength: 6200,
    bodyText:
      "Evidence-labelled spec getWebLog getBetTicker tiers: B observed request/route · C inferred",
    hasScalarRoot: true,
    closed: false,
    expanded: false,
  };
  const view: WebViewHandle = {
    get title(): string {
      return state.title;
    },
    get url(): string {
      return state.url;
    },
    get loading(): boolean {
      return false;
    },
    async navigate(url: string): Promise<void> {
      state.url = url;
    },
    async evaluate(expression: string): Promise<unknown> {
      if (expression === EXPAND_SIDEBAR_EXPRESSION) {
        state.expanded = true;
        return { clicked: 5 };
      }
      return {
        title: state.title,
        href: state.url,
        textLength: state.textLength,
        hasScalarRoot: state.hasScalarRoot,
        bodyText: state.bodyText,
      };
    },
    async screenshot(): Promise<Blob> {
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
        type: "image/jpeg",
      });
    },
    async close(): Promise<void> {
      state.closed = true;
    },
  };
  return { view, state };
}

function makeLiveRuntime(
  onCall: CallLog,
  specBytes: Uint8Array,
  portalUrl = PORTAL,
): AuditRuntime & { readonly state: FakeViewState } {
  const fake = makeFakeWebView(portalUrl);
  return {
    state: fake.state,
    async createWebView() {
      onCall.calls.push("createWebView");
      return fake.view;
    },
    async fetchResource(url: string) {
      onCall.calls.push(`fetchResource:${url}`);
      return { status: 200, bytes: specBytes };
    },
    async writeBytes(path: string, bytes: Uint8Array) {
      onCall.calls.push(`write:${path}`);
      writeFileSync(path, bytes);
    },
    mkdirp(path: string) {
      mkdirSync(path, { recursive: true });
    },
    now() {
      return FIXED_NOW;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Static validator                                                           */
/* -------------------------------------------------------------------------- */

describe("static openapi validator", () => {
  test("accepts the committed docs spec (71 paths, every op evidenced)", () => {
    const result = validateOpenApiDocumentFile(SPEC_PATH);
    expect(result.issues).toEqual([]);
    const byId = new Map(result.checks.map((check) => [check.id, check]));
    expect(byId.get("openapi-parse")?.status).toBe("PASS");
    expect(byId.get("openapi-version")?.status).toBe("PASS");
    expect(byId.get("openapi-path-count")?.status).toBe("PASS");
    expect(byId.get("openapi-evidence")?.status).toBe("PASS");
  });

  test("catches a temp-copy operation with missing x-evidence", () => {
    const dir = makeTempDir("audit-static-");
    try {
      const spec = readJsonObject(SPEC_PATH);
      const paths = spec["paths"];
      if (typeof paths !== "object" || paths === null) {
        throw new Error("spec.paths missing");
      }
      const firstPathItem = Object.values(paths)[0];
      if (typeof firstPathItem !== "object" || firstPathItem === null) {
        throw new Error("spec path item missing");
      }
      const firstOperation = Object.values(firstPathItem)[0];
      if (typeof firstOperation !== "object" || firstOperation === null) {
        throw new Error("spec operation missing");
      }
      delete (firstOperation as Record<string, unknown>)["x-evidence"];

      const mutatedPath = join(dir, "openapi.json");
      writeFileSync(mutatedPath, JSON.stringify(spec));

      const result = validateOpenApiDocumentFile(mutatedPath);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.severity).toBe("HIGH");
      expect(result.issues[0]?.category).toBe("SCHEMA_DRIFT");
      const evidenceCheck = result.checks.find(
        (check) => check.id === "openapi-evidence",
      );
      expect(evidenceCheck?.status).toBe("FAIL");
    } finally {
      cleanup(dir);
    }
  });

  test("catches a wrong path count and fabricated ajax.php", () => {
    const tooSmall = validateOpenApiSpec({
      openapi: "3.1.0",
      paths: {
        "/health": {
          get: { "x-evidence": { tier: "B" }, responses: {} },
        },
      },
    });
    expect(tooSmall.issues.some((issue) => issue.target === "paths")).toBe(
      true,
    );

    const fabricated = validateOpenApiSpec({
      openapi: "3.1.0",
      paths: {
        "/manager-tools/ajax.php": {
          post: { "x-evidence": { tier: "C" }, responses: {} },
        },
      },
    });
    expect(
      fabricated.issues.some(
        (issue) =>
          issue.severity === "CRITICAL" && issue.target.includes("ajax"),
      ),
    ).toBe(true);
  });

  test("api-reference markdown must keep the documented UI markers", () => {
    const okResult = validateApiReferenceMarkdown(
      readFileSync(MARKDOWN_PATH, "utf8"),
    );
    expect(okResult.issues).toEqual([]);

    const missing = validateApiReferenceMarkdown("# empty reference");
    expect(missing.issues.length).toBe(1);
    expect(missing.issues[0]?.severity).toBe("HIGH");
    expect(missing.issues[0]?.message).toContain("getBetTicker");
  });
});

/* -------------------------------------------------------------------------- */
/* Lockfile                                                                   */
/* -------------------------------------------------------------------------- */

describe("audit lockfile", () => {
  test("refuses a fresh lock held by a live pid", () => {
    const dir = makeTempDir("audit-lock-");
    try {
      const lockPath = join(dir, "nested", ".docs_audit.lock");
      const first = acquireAuditLock({ lockPath, now: FIXED_NOW });
      expect(first.ok).toBe(true);

      const second = acquireAuditLock({ lockPath, now: FIXED_NOW });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.holder.pid).toBe(process.pid);
        expect(second.holder.startedAt).toBe(FIXED_NOW.toISOString());
      }
      expect(readAuditLock(lockPath)?.pid).toBe(process.pid);
    } finally {
      cleanup(dir);
    }
  });

  test("recovers a stale lock whose process is gone", () => {
    const dir = makeTempDir("audit-lock-");
    try {
      const lockPath = join(dir, ".docs_audit.lock");
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: 999_999, startedAt: "2020-01-01T00:00:00.000Z" })}\n`,
      );
      const acquired = acquireAuditLock({
        lockPath,
        now: FIXED_NOW,
        isProcessAlive: () => false,
      });
      expect(acquired.ok).toBe(true);
      if (acquired.ok) {
        expect(acquired.replaced?.pid).toBe(999_999);
        expect(acquired.state.pid).toBe(process.pid);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("recovers an old lock even when its pid is still alive", () => {
    const dir = makeTempDir("audit-lock-");
    try {
      const lockPath = join(dir, ".docs_audit.lock");
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: 4242, startedAt: "2026-10-30T10:00:00.000Z" })}\n`,
      );
      const acquired = acquireAuditLock({
        lockPath,
        now: FIXED_NOW,
        staleMs: 60_000,
        isProcessAlive: () => true,
      });
      expect(acquired.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("release is owner-checked", () => {
    const dir = makeTempDir("audit-lock-");
    try {
      const lockPath = join(dir, ".docs_audit.lock");
      expect(acquireAuditLock({ lockPath }).ok).toBe(true);
      releaseAuditLock(lockPath, process.pid + 1);
      expect(existsSync(lockPath)).toBe(true);
      releaseAuditLock(lockPath, process.pid);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Audit orchestration                                                        */
/* -------------------------------------------------------------------------- */

describe("documentation audit orchestration", () => {
  test("offline audit passes and never launches WebView or network", async () => {
    const dir = makeTempDir("audit-offline-");
    try {
      const callLog: CallLog = { calls: [] };
      const summary = await runDocumentationAudit({
        rootDir: ROOT,
        outDir: dir,
        offline: true,
        runtime: makeOfflineRuntime(callLog),
      });

      expect(summary.status).toBe("PASS");
      expect(summary.mode).toBe("offline");
      expect(callLog.calls.filter((call) => call === "createWebView")).toEqual(
        [],
      );
      expect(
        callLog.calls.filter((call) => call.startsWith("fetchResource")),
      ).toEqual([]);
      expect(
        summary.checks.some((check) => check.id === "openapi-evidence"),
      ).toBe(true);
      expect(
        summary.checks
          .filter((check) => check.status === "SKIP")
          .map((check) => check.id),
      ).toContain("live-spec-hash");

      const reportPath = join(dir, "docs_error_audit.json");
      expect(existsSync(reportPath)).toBe(true);
      const report = readJsonObject(reportPath);
      expect(report["status"]).toBe("PASS");
      expect(report["mode"]).toBe("offline");
      expect(Array.isArray(report["checks"])).toBe(true);
      expect(Array.isArray(report["issues"])).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("live path uses the injectable runtime and writes a JPEG proof", async () => {
    const dir = makeTempDir("audit-live-");
    try {
      const callLog: CallLog = { calls: [] };
      const specBytes = new Uint8Array(readFileSync(SPEC_PATH));
      const runtime = makeLiveRuntime(callLog, specBytes);
      const summary = await runDocumentationAudit({
        rootDir: ROOT,
        outDir: dir,
        portalUrl: PORTAL,
        runtime,
      });

      expect(summary.status).toBe("PASS");
      expect(callLog.calls.filter((call) => call === "createWebView")).toEqual([
        "createWebView",
      ]);
      expect(runtime.state.expanded).toBe(true);
      expect(runtime.state.closed).toBe(true);
      expect(summary.backend).toBe("chrome");

      const checks = new Map(summary.checks.map((check) => [check.id, check]));
      expect(checks.get("webview-title")?.status).toBe("PASS");
      expect(checks.get("webview-url")?.status).toBe("PASS");
      expect(checks.get("webview-scalar-mounted")?.status).toBe("PASS");
      expect(checks.get("webview-body-markers")?.status).toBe("PASS");
      expect(checks.get("webview-console")?.status).toBe("PASS");
      expect(checks.get("live-spec-hash")?.status).toBe("PASS");
      expect(checks.get("webview-closed")?.status).toBe("PASS");

      expect(summary.screenshotPath).toBeDefined();
      if (summary.screenshotPath !== undefined) {
        expect(existsSync(summary.screenshotPath)).toBe(true);
        expect(readFileSync(summary.screenshotPath).length).toBe(4);
        expect(summary.screenshotPath).toContain(
          "audit_2026-10-30T12-00-00-000Z.jpg",
        );
      }
      expect(callLog.calls.some((call) => call.includes("/openapi.json"))).toBe(
        true,
      );
    } finally {
      cleanup(dir);
    }
  });

  test("live path skips the network comparison with skipLive", async () => {
    const dir = makeTempDir("audit-live-");
    try {
      const callLog: CallLog = { calls: [] };
      const runtime = makeLiveRuntime(callLog, new Uint8Array());
      const summary = await runDocumentationAudit({
        rootDir: ROOT,
        outDir: dir,
        portalUrl: PORTAL,
        skipLive: true,
        runtime,
      });
      expect(summary.status).toBe("PASS");
      expect(
        callLog.calls.filter((call) => call.startsWith("fetchResource")),
      ).toEqual([]);
      const liveCheck = summary.checks.find(
        (check) => check.id === "live-spec-hash",
      );
      expect(liveCheck?.status).toBe("SKIP");
    } finally {
      cleanup(dir);
    }
  });

  test("CLI parsing: default once, watch/schedule, offline, portal", () => {
    expect(parseAuditCliArgs([])).toEqual({
      mode: "once",
      schedule: "0 * * * *",
      offline: false,
      skipLive: false,
      json: false,
      portalUrl: undefined,
    });
    const watch = parseAuditCliArgs([
      "--watch",
      "--schedule",
      "*/15 * * * *",
      "--portal",
      PORTAL,
      "--skip-live",
      "--json",
    ]);
    expect(typeof watch).toBe("object");
    if (typeof watch === "object") {
      expect(watch.mode).toBe("watch");
      expect(watch.schedule).toBe("*/15 * * * *");
      expect(watch.portalUrl).toBe(PORTAL);
      expect(watch.skipLive).toBe(true);
      expect(watch.json).toBe(true);
    }
    const offline = parseAuditCliArgs(["--offline"]);
    expect(typeof offline === "object" && offline.offline).toBe(true);
    expect(typeof parseAuditCliArgs(["--bogus"])).toBe("string");
  });
});

/* -------------------------------------------------------------------------- */
/* Tile crawler                                                               */
/* -------------------------------------------------------------------------- */

describe("portal tile crawler", () => {
  test("offline crawl is deterministic and never launches a WebView", async () => {
    const dir = makeTempDir("crawl-offline-");
    try {
      const callLog: CallLog = { calls: [] };
      const runtime: CrawlRuntime = {
        async createWebView() {
          callLog.calls.push("createWebView");
          throw new Error("offline crawl must not launch Bun.WebView");
        },
        async writeBytes(path, bytes) {
          writeFileSync(path, bytes);
        },
        mkdirp(path) {
          mkdirSync(path, { recursive: true });
        },
        now() {
          return FIXED_NOW;
        },
      };

      const report = await runTileInspectionCrawl({
        mode: "offline",
        rootDir: ROOT,
        outDir: dir,
        runtime,
      });

      expect(report.mode).toBe("offline");
      expect(report.totalTiles).toBe(UNMAPPED_LAUNCHER_TILES.length);
      expect(report.observedTiles).toBe(0);
      expect(callLog.calls).toEqual([]);
      expect(
        report.tiles.every(
          (tile) =>
            tile.status === "CATALOG_ONLY" && tile.evidenceKind === "catalog",
        ),
      ).toBe(true);

      const reportPath = join(dir, "tile_crawler_audit.json");
      expect(existsSync(reportPath)).toBe(true);
      const written = readJsonObject(reportPath);
      expect(written["mode"]).toBe("offline");
      expect(written["totalTiles"]).toBe(UNMAPPED_LAUNCHER_TILES.length);
    } finally {
      cleanup(dir);
    }
  });

  test("catalog selectors are valid CSS (no Playwright :has-text)", () => {
    for (const tile of UNMAPPED_LAUNCHER_TILES) {
      const selector = cssSelectorForTile(tile);
      expect(selector).toContain("data-tile");
      expect(selector).not.toContain(":has-text");
      expect(
        tile.candidateMethod === "POST" || tile.candidateMethod === "GET",
      ).toBe(true);
    }
  });

  test("selector-presence expression escapes quotes safely", () => {
    const expression = buildSelectorPresenceExpression("div[data-tile='x']");
    expect(expression).toContain("document.querySelector");
    expect(expression).toContain("div[data-tile='x']");
    const quoted = buildSelectorPresenceExpression(
      "div[data-tile=\"say 'hi'\"]",
    );
    expect(quoted).toContain("querySelector");
    expect(quoted.startsWith("(() =>")).toBe(true);
  });

  test("DOM extraction result is parsed at the boundary", () => {
    expect(
      parseExtractedTileDom({
        inputs: ["customerID"],
        lKeys: ["L-1031"],
        panelTitle: "Cashier",
      }),
    ).toEqual({
      inputs: ["customerID"],
      lKeys: ["L-1031"],
      panelTitle: "Cashier",
    });
    expect(parseExtractedTileDom({ inputs: "nope" })).toBeUndefined();
    expect(TILE_EXTRACTION_EXPRESSION).toContain("querySelectorAll");
  });

  test("CLI parsing: offline default, live requires --portal", () => {
    expect(parseCrawlCliArgs([])).toEqual({
      mode: "offline",
      portalUrl: undefined,
      outDir: undefined,
      json: false,
    });
    expect(typeof parseCrawlCliArgs(["--live"])).toBe("string");
    const live = parseCrawlCliArgs([
      "--live",
      "--portal",
      "https://www.fantasy402.com/manager.html",
      "--out",
      "/tmp/proofs",
      "--json",
    ]);
    expect(typeof live).toBe("object");
    if (typeof live === "object") {
      expect(live.mode).toBe("live");
      expect(live.portalUrl).toContain("fantasy402.com");
      expect(live.json).toBe(true);
    }
    expect(typeof parseCrawlCliArgs(["--nope"])).toBe("string");
  });
});
