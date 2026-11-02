#!/usr/bin/env bun
/**
 * @file audit_docs_webview_cron.ts
 * @description Deployed-portal audit for the evidence-labelled SportsDesk docs.
 *
 * Rewritten against the real Bun 1.4.4 API (reports/docs-review/BUN_CAPTURE_CONTRACT.md):
 *   - Bun.WebView read-only properties (`view.title`, `view.url`) are values, not
 *     functions; the view is closed with `await view.close()` (never destroy /
 *     asyncDispose); screenshots are Blobs converted to Buffers.
 *   - Bun.cron is an in-process scheduler; the returned job exposes ref()/stop().
 *   - Bun.fetch is used for the live spec hash comparison.
 *
 * Modes:
 *   --once (default)   one audit pass, writes reports/docs_error_audit.json
 *   --watch [--schedule "<cron>"]  initial pass + Bun.cron daemon with SIGINT/SIGTERM drain
 *   --offline          static-only: no WebView, no network
 *
 * A lockfile (reports/.docs_audit.lock) prevents overlapping daemons/audits.
 * Exit code is 0 unless a CRITICAL or HIGH issue was recorded.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { startInProcessCron, type InProcessCronJob } from "../lib/bun_cron.ts";

const SCRIPT_DIR = import.meta.dir;
const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_PORTAL_URL = "https://fantasy402-docs-4ay.pages.dev";
const DEFAULT_SCHEDULE = "0 * * * *";
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 15_000;
const CONTENT_SETTLE_TIMEOUT_MS = 10_000;
const CONTENT_POLL_INTERVAL_MS = 150;
const CONTENT_SETTLED_MIN_TEXT_LENGTH = 1_000;
const LIVE_FETCH_TIMEOUT_MS = 15_000;
// Release contract: the committed spec must document exactly these paths. Bumped from 47 when
// the daemon routes (live-bets, agent-tree, scoreboard, sports, game-admin) became spec surfaces.
const EXPECTED_OPENAPI_PATH_COUNT = 70;
const REQUIRED_TITLE_PATTERN = /Wire API Reference|Scalar/i;
const DOCUMENTED_OPERATION_MARKERS = [
  "getWebLog",
  "getBetTicker",
  "inferred",
] as const;
const CONSOLE_ERROR_PATTERN =
  /(error|uncaught|exception|refused|failed to load|typeerror|syntaxerror)/i;

/* -------------------------------------------------------------------------- */
/* Shared result types                                                        */
/* -------------------------------------------------------------------------- */

export type CheckStatus = "PASS" | "FAIL" | "SKIP";
export type IssueSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type IssueCategory =
  | "CONSOLE_ERROR"
  | "SCHEMA_DRIFT"
  | "UI_ASSERTION"
  | "LIVE_SPEC_DRIFT"
  | "WEBVIEW_ERROR"
  | "SCREENSHOT"
  | "STATIC_DOCS"
  | "LOCK";

export interface AuditCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface AuditIssue {
  readonly severity: IssueSeverity;
  readonly category: IssueCategory;
  readonly target: string;
  readonly message: string;
}

export type AuditMode = "offline" | "once" | "watch";

export interface AuditSummary {
  readonly auditedAt: string;
  readonly portalUrl: string;
  readonly mode: AuditMode;
  readonly backend: string;
  readonly checks: readonly AuditCheck[];
  readonly issues: readonly AuditIssue[];
  readonly status: "PASS" | "FAIL";
  readonly screenshotPath: string | undefined;
  readonly reportPath: string | undefined;
  readonly contentSettleMs: number | undefined;
}

/** A failing CRITICAL/HIGH issue makes the audit fail (and the CLI exit 1). */
export function isFailingSeverity(severity: IssueSeverity): boolean {
  return severity === "CRITICAL" || severity === "HIGH";
}

export function summarizeStatus(
  issues: readonly AuditIssue[],
): "PASS" | "FAIL" {
  return issues.some((issue) => isFailingSeverity(issue.severity))
    ? "FAIL"
    : "PASS";
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestampSlug(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error ? error : new Error(describeError(error)),
        );
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Static validation (offline-safe)                                           */
/* -------------------------------------------------------------------------- */

export interface StaticAuditResult {
  readonly checks: readonly AuditCheck[];
  readonly issues: readonly AuditIssue[];
}

export interface ValidateSpecOptions {
  /** Release contract: the docs spec has exactly 47 paths. */
  readonly expectedPathCount?: number;
}

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

/**
 * Pure static validator: OpenAPI 3.1.0, expected path count, and x-evidence on
 * every operation. Unit-tested with in-memory / temp-copy documents.
 */
export function validateOpenApiSpec(
  spec: unknown,
  options: ValidateSpecOptions = {},
): StaticAuditResult {
  const checks: AuditCheck[] = [];
  const issues: AuditIssue[] = [];
  const expectedPathCount =
    options.expectedPathCount ?? EXPECTED_OPENAPI_PATH_COUNT;

  if (!isRecord(spec)) {
    checks.push({
      id: "openapi-parse",
      status: "FAIL",
      detail: "docs/openapi.json must contain a JSON object",
    });
    issues.push({
      severity: "CRITICAL",
      category: "SCHEMA_DRIFT",
      target: "docs/openapi.json",
      message: "OpenAPI document is not a JSON object",
    });
    return { checks, issues };
  }

  checks.push({
    id: "openapi-parse",
    status: "PASS",
    detail: "docs/openapi.json parsed as a JSON object",
  });

  const versionOk = spec.openapi === "3.1.0";
  checks.push({
    id: "openapi-version",
    status: versionOk ? "PASS" : "FAIL",
    detail: `openapi=${JSON.stringify(spec.openapi)} (expected "3.1.0")`,
  });
  if (!versionOk) {
    issues.push({
      severity: "HIGH",
      category: "SCHEMA_DRIFT",
      target: "openapi",
      message: `openapi version must be exactly "3.1.0", found ${JSON.stringify(spec.openapi)}`,
    });
  }

  const paths = isRecord(spec.paths) ? spec.paths : undefined;
  const pathCount = paths === undefined ? 0 : Object.keys(paths).length;
  const pathCountOk = pathCount === expectedPathCount;
  checks.push({
    id: "openapi-path-count",
    status: pathCountOk ? "PASS" : "FAIL",
    detail: `${pathCount} paths (release contract: ${expectedPathCount})`,
  });
  if (!pathCountOk) {
    issues.push({
      severity: "HIGH",
      category: "SCHEMA_DRIFT",
      target: "paths",
      message: `expected ${expectedPathCount} documented paths, found ${pathCount}`,
    });
  }

  const operationsWithoutEvidence: string[] = [];
  const operationsWithInvalidTier: string[] = [];
  let operationCount = 0;
  if (paths !== undefined) {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!isRecord(pathItem)) continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (
          !(HTTP_METHODS as readonly string[]).includes(method) ||
          !isRecord(operation)
        ) {
          continue;
        }
        operationCount += 1;
        const label = `${method.toUpperCase()} ${path}`;
        const evidence = operation["x-evidence"];
        if (!isRecord(evidence)) {
          operationsWithoutEvidence.push(label);
          continue;
        }
        const tier = evidence.tier;
        if (typeof tier !== "string" || !["A", "B", "C", "D"].includes(tier)) {
          operationsWithInvalidTier.push(`${label}: ${JSON.stringify(tier)}`);
        }
      }
    }
  }

  const evidenceOk =
    operationCount > 0 &&
    operationsWithoutEvidence.length === 0 &&
    operationsWithInvalidTier.length === 0;
  checks.push({
    id: "openapi-evidence",
    status: evidenceOk ? "PASS" : "FAIL",
    detail: `${operationCount} operations; ${operationsWithoutEvidence.length} missing x-evidence; ${operationsWithInvalidTier.length} invalid tier`,
  });
  for (const label of operationsWithoutEvidence) {
    issues.push({
      severity: "HIGH",
      category: "SCHEMA_DRIFT",
      target: label,
      message:
        "operation is missing x-evidence {tier, sources, capturedResponse}; evidence tier must be explicit",
    });
  }
  for (const label of operationsWithInvalidTier) {
    issues.push({
      severity: "HIGH",
      category: "SCHEMA_DRIFT",
      target: label,
      message: `x-evidence.tier must be A|B|C|D, found ${label.split(": ").slice(1).join(": ")}`,
    });
  }

  const fabricated = paths !== undefined && "/manager-tools/ajax.php" in paths;
  checks.push({
    id: "openapi-no-fabricated-contract",
    status: fabricated ? "FAIL" : "PASS",
    detail: fabricated
      ? "fabricated /manager-tools/ajax.php path present"
      : "no /manager-tools/ajax.php fabricated wire contract",
  });
  if (fabricated) {
    issues.push({
      severity: "CRITICAL",
      category: "SCHEMA_DRIFT",
      target: "/manager-tools/ajax.php",
      message:
        "fabricated GS wire contract re-appeared; the GS surfaces are blocked_contract (see docs/gs-manager-contracts.md)",
    });
  }

  return { checks, issues };
}

/** Load and validate docs/openapi.json from disk (temp copies work too). */
export function validateOpenApiDocumentFile(
  filePath: string,
  options: ValidateSpecOptions = {},
): StaticAuditResult {
  if (!existsSync(filePath)) {
    return {
      checks: [
        {
          id: "openapi-parse",
          status: "FAIL",
          detail: `missing ${filePath}`,
        },
      ],
      issues: [
        {
          severity: "CRITICAL",
          category: "SCHEMA_DRIFT",
          target: filePath,
          message: "docs/openapi.json does not exist",
        },
      ],
    };
  }
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      checks: [
        {
          id: "openapi-parse",
          status: "FAIL",
          detail: `JSON parse failed: ${describeError(error)}`,
        },
      ],
      issues: [
        {
          severity: "CRITICAL",
          category: "SCHEMA_DRIFT",
          target: filePath,
          message: `docs/openapi.json is not valid JSON: ${describeError(error)}`,
        },
      ],
    };
  }
  return validateOpenApiSpec(spec, options);
}

/**
 * Offline check that the generated markdown still advertises the documented
 * operations and the evidence-tier marker the portal renders.
 */
export function validateApiReferenceMarkdown(
  markdown: string,
): StaticAuditResult {
  const missing = DOCUMENTED_OPERATION_MARKERS.filter(
    (marker) => !markdown.toLowerCase().includes(marker.toLowerCase()),
  );
  const checks: AuditCheck[] = [
    {
      id: "api-reference-markers",
      status: missing.length === 0 ? "PASS" : "FAIL",
      detail:
        missing.length === 0
          ? `all expected markers present: ${DOCUMENTED_OPERATION_MARKERS.join(", ")}`
          : `missing markers: ${missing.join(", ")}`,
    },
  ];
  const issues: AuditIssue[] = [];
  if (missing.length > 0) {
    issues.push({
      severity: "HIGH",
      category: "STATIC_DOCS",
      target: "docs/api-reference.md",
      message: `generated reference lost expected UI strings: ${missing.join(", ")}`,
    });
  }
  return { checks, issues };
}

/** Static-only evidence audit used by `--offline` and before every live pass. */
export function validateStaticEvidence(
  rootDir: string,
  options: ValidateSpecOptions = {},
): StaticAuditResult {
  const specPath = join(rootDir, "docs", "openapi.json");
  const markdownPath = join(rootDir, "docs", "api-reference.md");
  const specResult = validateOpenApiDocumentFile(specPath, options);
  const checks: AuditCheck[] = [...specResult.checks];
  const issues: AuditIssue[] = [...specResult.issues];

  if (!existsSync(markdownPath)) {
    checks.push({
      id: "api-reference-markers",
      status: "FAIL",
      detail: `missing ${markdownPath}`,
    });
    issues.push({
      severity: "HIGH",
      category: "STATIC_DOCS",
      target: "docs/api-reference.md",
      message: "generated API reference markdown is missing",
    });
  } else {
    const markdownResult = validateApiReferenceMarkdown(
      readFileSync(markdownPath, "utf8"),
    );
    checks.push(...markdownResult.checks);
    issues.push(...markdownResult.issues);
  }

  return { checks, issues };
}

/* -------------------------------------------------------------------------- */
/* Lockfile (prevents overlapping audits / daemons)                           */
/* -------------------------------------------------------------------------- */

export interface AuditLockState {
  readonly pid: number;
  readonly startedAt: string;
}

export interface AcquireLockOptions {
  readonly lockPath: string;
  readonly pid?: number;
  readonly now?: Date;
  readonly staleMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export type AcquireLockResult =
  | {
      readonly ok: true;
      readonly state: AuditLockState;
      readonly replaced: AuditLockState | undefined;
    }
  | { readonly ok: false; readonly holder: AuditLockState };

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read a lockfile; returns undefined when absent or unparseable (stale). */
export function readAuditLock(lockPath: string): AuditLockState | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/**
 * Acquire the audit lock. A fresh lock held by a live process is refused; a
 * lock whose process is gone or which is older than `staleMs` is recovered.
 */
export function acquireAuditLock(
  options: AcquireLockOptions,
): AcquireLockResult {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  mkdirSync(dirname(options.lockPath), { recursive: true });

  const existing = readAuditLock(options.lockPath);
  if (existing !== undefined) {
    const startedMs = Date.parse(existing.startedAt);
    const ageMs = Number.isFinite(startedMs)
      ? now.getTime() - startedMs
      : Number.POSITIVE_INFINITY;
    const alive = isProcessAlive(existing.pid);
    if (alive && ageMs <= staleMs) {
      return { ok: false, holder: existing };
    }
  }

  const state: AuditLockState = { pid, startedAt: now.toISOString() };
  writeFileSync(options.lockPath, `${JSON.stringify(state)}\n`, "utf8");
  return { ok: true, state, replaced: existing };
}

/** Release the lock (owner-checked when a pid is supplied). */
export function releaseAuditLock(lockPath: string, pid?: number): void {
  const existing = readAuditLock(lockPath);
  if (existing === undefined) {
    rmSync(lockPath, { force: true });
    return;
  }
  if (pid !== undefined && existing.pid !== pid) return;
  rmSync(lockPath, { force: true });
}

/* -------------------------------------------------------------------------- */
/* Bun.WebView adapter (real API only)                                        */
/* -------------------------------------------------------------------------- */

export type WebViewBackend = "chrome" | "webkit";

export interface WebViewOptions {
  readonly width: number;
  readonly height: number;
  readonly backend: WebViewBackend;
  readonly console: (type: string, ...args: unknown[]) => void;
}

export interface WebViewScreenshotOptions {
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
}

/** Minimal structural surface of the real Bun.WebView used by this audit. */
export interface WebViewHandle {
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options?: WebViewScreenshotOptions): Promise<Blob>;
  close(): void | Promise<void>;
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): void | Promise<void>;
}

type WebViewConstructor = new (options: WebViewOptions) => WebViewHandle;

function getWebViewConstructor(): WebViewConstructor | undefined {
  const candidate = (Bun as unknown as { WebView?: unknown }).WebView;
  if (typeof candidate !== "function") return undefined;
  return candidate as WebViewConstructor;
}

export interface FetchedResource {
  readonly status: number;
  readonly bytes: Uint8Array;
}

/** Injectable boundary so tests never launch WebView / touch the network. */
export interface AuditRuntime {
  createWebView(options: WebViewOptions): Promise<WebViewHandle>;
  fetchResource(url: string): Promise<FetchedResource>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): void;
  now(): Date;
}

export function createDefaultAuditRuntime(): AuditRuntime {
  return {
    async createWebView(options: WebViewOptions): Promise<WebViewHandle> {
      const Constructor = getWebViewConstructor();
      if (Constructor === undefined) {
        throw new Error(
          "Bun.WebView is unavailable; this requires Bun >= 1.4 with native WebView support",
        );
      }
      return new Constructor(options);
    },
    async fetchResource(url: string): Promise<FetchedResource> {
      const bunFetch = (Bun as unknown as { fetch?: typeof fetch }).fetch;
      const fetcher = bunFetch ?? fetch;
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, bytes };
    },
    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
      await Bun.write(path, bytes);
    },
    mkdirp(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    now(): Date {
      return new Date();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Page inspection expressions (single IIFE each — real evaluate contract)    */
/* -------------------------------------------------------------------------- */

export const PAGE_SNAPSHOT_EXPRESSION = `(() => {
  const body = document.body;
  const text = (body && body.innerText) || "";
  const scalarRoot = document.querySelector(
    ".scalar-api-reference, [data-scalar], [class*='scalar']"
  );
  return {
    title: document.title || "",
    href: (document.location && document.location.href) || "",
    textLength: text.length,
    hasScalarRoot: Boolean(scalarRoot),
    bodyText: text.slice(0, 20000),
  };
})()`;

export const EXPAND_SIDEBAR_EXPRESSION = `(() => {
  const toggles = Array.from(
    document.querySelectorAll(
      "aside button[aria-expanded='false'], aside [role='button'][aria-expanded='false']"
    )
  );
  let clicked = 0;
  for (const toggle of toggles) {
    try {
      toggle.click();
      clicked += 1;
    } catch {
      // A non-clickable sidebar stub is not fatal; the body-marker check catches it.
    }
  }
  return { clicked };
})()`;

export interface PageSnapshot {
  readonly title: string;
  readonly href: string;
  readonly textLength: number;
  readonly hasScalarRoot: boolean;
  readonly bodyText: string;
}

/** Parse an `evaluate` result at the boundary instead of trusting it. */
export function parsePageSnapshot(value: unknown): PageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { title, href, textLength, hasScalarRoot, bodyText } = value;
  if (
    typeof title !== "string" ||
    typeof href !== "string" ||
    typeof textLength !== "number" ||
    typeof hasScalarRoot !== "boolean" ||
    typeof bodyText !== "string"
  ) {
    return undefined;
  }
  return { title, href, textLength, hasScalarRoot, bodyText };
}

async function readPageSnapshot(
  view: WebViewHandle,
): Promise<PageSnapshot | undefined> {
  const raw = await view.evaluate(PAGE_SNAPSHOT_EXPRESSION);
  return parsePageSnapshot(raw);
}

/** Poll view.title/view.url until navigation has produced a document title. */
async function waitForTitle(
  view: WebViewHandle,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.title.trim() !== "" && view.url.trim() !== "") return true;
    await sleep(CONTENT_POLL_INTERVAL_MS);
  }
  return view.title.trim() !== "";
}

/**
 * Poll until the predicate is satisfied. Bun.WebView.navigate() resolves at
 * document load, not SPA hydration, so the Scalar portal must be polled until
 * its rendered content is actually present.
 */
async function waitForSnapshot(
  view: WebViewHandle,
  predicate: (snapshot: PageSnapshot) => boolean,
  timeoutMs = CONTENT_SETTLE_TIMEOUT_MS,
): Promise<PageSnapshot | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: PageSnapshot | undefined;
  while (Date.now() < deadline) {
    try {
      lastSnapshot = await readPageSnapshot(view);
    } catch {
      lastSnapshot = undefined;
    }
    if (lastSnapshot !== undefined && predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await sleep(CONTENT_POLL_INTERVAL_MS);
  }
  return lastSnapshot;
}

/** The Scalar shell has finished hydrating enough to assert content. */
function hasContentSettled(snapshot: PageSnapshot): boolean {
  return (
    snapshot.hasScalarRoot &&
    snapshot.textLength >= CONTENT_SETTLED_MIN_TEXT_LENGTH
  );
}

/** Every documented operation/marker has rendered into the page body. */
function hasAllMarkers(snapshot: PageSnapshot): boolean {
  const bodyText = snapshot.bodyText.toLowerCase();
  return DOCUMENTED_OPERATION_MARKERS.every((marker) =>
    bodyText.includes(marker.toLowerCase()),
  );
}

interface LaunchedWebView {
  readonly view: WebViewHandle;
  readonly backend: WebViewBackend;
  readonly fallbackWarning: string | undefined;
}

/**
 * Try the task-mandated chrome backend first, then fall back to webkit with an
 * explicit warning. (In some sandboxes Chrome cannot spawn its helper process;
 * webkit renders the same portal and is honest about the degradation.)
 */
async function launchPortalWebView(
  runtime: AuditRuntime,
  portalUrl: string,
  consoleSink: (type: string, ...args: unknown[]) => void,
): Promise<LaunchedWebView> {
  const failures: string[] = [];
  for (const backend of ["chrome", "webkit"] as const) {
    let view: WebViewHandle | undefined;
    try {
      view = await runtime.createWebView({
        width: 1440,
        height: 900,
        backend,
        console: consoleSink,
      });
      await withTimeout(
        view.navigate(portalUrl),
        NAVIGATION_TIMEOUT_MS,
        `${backend} navigate`,
      );
      if (!(await waitForTitle(view))) {
        throw new Error(`page never rendered a document title with ${backend}`);
      }
      return {
        view,
        backend,
        fallbackWarning:
          failures.length === 0
            ? undefined
            : `chrome backend unavailable (${failures.join(" | ")}); rendered with webkit`,
      };
    } catch (error) {
      failures.push(`${backend}: ${describeError(error)}`);
      if (view !== undefined) {
        try {
          await view.close();
        } catch {
          // Already gone; nothing to release.
        }
      }
    }
  }
  throw new Error(
    `no Bun.WebView backend could render ${portalUrl}: ${failures.join(" | ")}`,
  );
}

async function closeAllWebViews(): Promise<void> {
  const webViewClass = (
    Bun as unknown as {
      WebView?: { closeAll?: () => void | Promise<void> };
    }
  ).WebView;
  const closeAll = webViewClass?.closeAll;
  if (typeof closeAll !== "function") return;
  try {
    await closeAll();
  } catch {
    // Best-effort safety net; the finally-block close() owns the real cleanup.
  }
}

/* -------------------------------------------------------------------------- */
/* Live spec hash comparison                                                  */
/* -------------------------------------------------------------------------- */

export interface LiveSpecCheck {
  readonly check: AuditCheck;
  readonly issue: AuditIssue | undefined;
}

export async function checkLiveSpecHash(
  runtime: AuditRuntime,
  rootDir: string,
  portalUrl: string,
): Promise<LiveSpecCheck> {
  const localPath = join(rootDir, "docs", "openapi.json");
  let localBytes: Uint8Array;
  try {
    localBytes = readFileSync(localPath);
  } catch (error) {
    return {
      check: {
        id: "live-spec-hash",
        status: "FAIL",
        detail: `cannot read local docs/openapi.json: ${describeError(error)}`,
      },
      issue: {
        severity: "HIGH",
        category: "LIVE_SPEC_DRIFT",
        target: "docs/openapi.json",
        message: `cannot read local docs/openapi.json: ${describeError(error)}`,
      },
    };
  }
  const specUrl = new URL(
    "openapi.json",
    portalUrl.endsWith("/") ? portalUrl : `${portalUrl}/`,
  ).toString();

  let deployed: FetchedResource;
  try {
    deployed = await runtime.fetchResource(specUrl);
  } catch (error) {
    return {
      check: {
        id: "live-spec-hash",
        status: "FAIL",
        detail: `could not fetch ${specUrl}: ${describeError(error)}`,
      },
      issue: {
        severity: "HIGH",
        category: "LIVE_SPEC_DRIFT",
        target: specUrl,
        message: `deployed spec is unreachable: ${describeError(error)}`,
      },
    };
  }
  if (deployed.status !== 200) {
    return {
      check: {
        id: "live-spec-hash",
        status: "FAIL",
        detail: `${specUrl} returned HTTP ${deployed.status}`,
      },
      issue: {
        severity: "HIGH",
        category: "LIVE_SPEC_DRIFT",
        target: specUrl,
        message: `deployed spec returned HTTP ${deployed.status}; cannot verify deployment parity`,
      },
    };
  }

  const localSha = sha256Hex(localBytes);
  const deployedSha = sha256Hex(deployed.bytes);
  if (localSha === deployedSha) {
    return {
      check: {
        id: "live-spec-hash",
        status: "PASS",
        detail: `deployed spec matches docs/openapi.json (sha256 ${deployedSha})`,
      },
      issue: undefined,
    };
  }
  return {
    check: {
      id: "live-spec-hash",
      status: "FAIL",
      detail: `deployed sha256 ${deployedSha} != committed ${localSha}`,
    },
    issue: {
      severity: "HIGH",
      category: "LIVE_SPEC_DRIFT",
      target: specUrl,
      message: `deployed spec (${deployedSha}) differs from committed docs/openapi.json (${localSha})`,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audit orchestration                                                        */
/* -------------------------------------------------------------------------- */

export interface AuditOptions {
  readonly rootDir?: string | undefined;
  readonly outDir?: string | undefined;
  readonly portalUrl?: string | undefined;
  readonly offline?: boolean | undefined;
  readonly skipLive?: boolean | undefined;
  readonly mode?: AuditMode | undefined;
  readonly runtime?: AuditRuntime | undefined;
}

export interface WebViewAuditResult {
  readonly checks: readonly AuditCheck[];
  readonly issues: readonly AuditIssue[];
  readonly backend: string;
  readonly screenshotPath: string | undefined;
  readonly contentSettleMs: number | undefined;
}

async function auditWebView(
  runtime: AuditRuntime,
  portalUrl: string,
  outDir: string,
  timestamp: string,
): Promise<WebViewAuditResult> {
  const checks: AuditCheck[] = [];
  const issues: AuditIssue[] = [];
  const consoleMessages: string[] = [];
  const consoleSink = (type: string, ...args: unknown[]): void => {
    const body = args
      .map((argument) =>
        typeof argument === "string" ? argument : JSON.stringify(argument),
      )
      .join(" ");
    consoleMessages.push(type ? `[${type}] ${body}` : body);
  };

  let view: WebViewHandle | undefined;
  let backend = "unavailable";
  let screenshotPath: string | undefined;
  let contentSettleMs: number | undefined;
  let liveChecksComplete = false;

  try {
    let launched: LaunchedWebView;
    try {
      launched = await launchPortalWebView(runtime, portalUrl, consoleSink);
    } catch (error) {
      checks.push({
        id: "webview-launch",
        status: "FAIL",
        detail: describeError(error),
      });
      issues.push({
        severity: "CRITICAL",
        category: "WEBVIEW_ERROR",
        target: portalUrl,
        message: `could not launch/render the deployed portal: ${describeError(error)}`,
      });
      return { checks, issues, backend, screenshotPath, contentSettleMs };
    }

    view = launched.view;
    backend = launched.backend;
    checks.push({
      id: "webview-launch",
      status: "PASS",
      detail: `Bun.WebView backend=${launched.backend} ${launched.backend === "chrome" ? "" : "(chrome unavailable, webkit fallback)"}`,
    });
    if (launched.fallbackWarning !== undefined) {
      issues.push({
        severity: "MEDIUM",
        category: "WEBVIEW_ERROR",
        target: "Bun.WebView",
        message: launched.fallbackWarning,
      });
    }

    checks.push({
      id: "webview-navigate",
      status: "PASS",
      detail: `navigated to ${portalUrl}`,
    });

    // Bun.WebView.navigate() resolves at document load, not SPA hydration:
    // poll until the Scalar shell has actually rendered content.
    const settleStarted = Date.now();
    const settledSnapshot = await waitForSnapshot(view, hasContentSettled);
    contentSettleMs = Date.now() - settleStarted;

    // Expand collapsed Scalar tag groups so every documented operation is in
    // the rendered DOM before asserting markers.
    try {
      await view.evaluate(EXPAND_SIDEBAR_EXPRESSION);
      await sleep(750);
    } catch (error) {
      issues.push({
        severity: "MEDIUM",
        category: "UI_ASSERTION",
        target: "sidebar",
        message: `could not expand Scalar sidebar groups: ${describeError(error)}`,
      });
    }

    // Keep polling until the documented markers render (bounded), rather than
    // asserting a skeleton page.
    const markerSnapshot = await waitForSnapshot(view, hasAllMarkers);
    const snapshot =
      markerSnapshot ?? settledSnapshot ?? (await readPageSnapshot(view));
    if (snapshot === undefined) {
      checks.push({
        id: "webview-render",
        status: "FAIL",
        detail: "page snapshot evaluate() returned an unexpected shape",
      });
      issues.push({
        severity: "HIGH",
        category: "WEBVIEW_ERROR",
        target: portalUrl,
        message: "page snapshot evaluate() returned an unexpected shape",
      });
    } else {
      checks.push({
        id: "webview-content-settled",
        status: settledSnapshot === undefined ? "FAIL" : "PASS",
        detail: `Scalar content settled in ${String(contentSettleMs)}ms (textLength=${String(settledSnapshot?.textLength ?? 0)})`,
      });
      if (settledSnapshot === undefined) {
        issues.push({
          severity: "HIGH",
          category: "UI_ASSERTION",
          target: "Scalar",
          message: `Scalar content never settled within ${CONTENT_SETTLE_TIMEOUT_MS}ms (SPA hydration not observed)`,
        });
      }

      const titleOk = REQUIRED_TITLE_PATTERN.test(snapshot.title);
      checks.push({
        id: "webview-title",
        status: titleOk ? "PASS" : "FAIL",
        detail: `title=${JSON.stringify(snapshot.title)}`,
      });
      if (!titleOk) {
        issues.push({
          severity: "HIGH",
          category: "UI_ASSERTION",
          target: "document.title",
          message: `page title ${JSON.stringify(snapshot.title)} does not match ${REQUIRED_TITLE_PATTERN}`,
        });
      }

      const urlOk = snapshot.href.startsWith(portalUrl.replace(/\/$/, ""));
      checks.push({
        id: "webview-url",
        status: urlOk ? "PASS" : "FAIL",
        detail: `url=${JSON.stringify(snapshot.href)}`,
      });
      if (!urlOk) {
        issues.push({
          severity: "HIGH",
          category: "UI_ASSERTION",
          target: "document.location.href",
          message: `page url ${JSON.stringify(snapshot.href)} does not start with ${portalUrl}`,
        });
      }

      const scalarOk = snapshot.hasScalarRoot && snapshot.textLength > 500;
      checks.push({
        id: "webview-scalar-mounted",
        status: scalarOk ? "PASS" : "FAIL",
        detail: `scalarRoot=${snapshot.hasScalarRoot} textLength=${snapshot.textLength}`,
      });
      if (!scalarOk) {
        issues.push({
          severity: "HIGH",
          category: "UI_ASSERTION",
          target: "Scalar",
          message:
            "Scalar reference did not mount (no scalar root element or page body is empty)",
        });
      }

      const bodyText = snapshot.bodyText.toLowerCase();
      const missingMarkers = DOCUMENTED_OPERATION_MARKERS.filter(
        (marker) => !bodyText.includes(marker.toLowerCase()),
      );
      checks.push({
        id: "webview-body-markers",
        status: missingMarkers.length === 0 ? "PASS" : "FAIL",
        detail:
          missingMarkers.length === 0
            ? `rendered markers: ${DOCUMENTED_OPERATION_MARKERS.join(", ")}`
            : `missing rendered markers: ${missingMarkers.join(", ")}`,
      });
      for (const marker of missingMarkers) {
        issues.push({
          severity: "HIGH",
          category: "UI_ASSERTION",
          target: marker,
          message: `documented operation/marker "${marker}" is not rendered in the deployed page body`,
        });
      }
    }

    const consoleErrors = consoleMessages.filter((message) =>
      CONSOLE_ERROR_PATTERN.test(message),
    );
    checks.push({
      id: "webview-console",
      status: consoleErrors.length === 0 ? "PASS" : "FAIL",
      detail:
        consoleErrors.length === 0
          ? `${consoleMessages.length} console message(s), no errors`
          : `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(" | ")}`,
    });
    for (const message of consoleErrors.slice(0, 10)) {
      issues.push({
        severity: "HIGH",
        category: "CONSOLE_ERROR",
        target: portalUrl,
        message: `page console error: ${message}`,
      });
    }

    // Screenshot proof: always captured for a live pass.
    try {
      const blob = await view.screenshot({ format: "jpeg", quality: 80 });
      const bytes = Buffer.from(await blob.arrayBuffer());
      const proofsDir = join(outDir, "doc_audit_proofs");
      runtime.mkdirp(proofsDir);
      const proofPath = join(
        proofsDir,
        `audit_${timestampSlug(timestamp)}.jpg`,
      );
      await runtime.writeBytes(proofPath, bytes);
      screenshotPath = proofPath;
      checks.push({
        id: "webview-screenshot",
        status: "PASS",
        detail: `${bytes.length} byte JPEG proof at ${proofPath}`,
      });
    } catch (error) {
      checks.push({
        id: "webview-screenshot",
        status: "FAIL",
        detail: describeError(error),
      });
      issues.push({
        severity: "MEDIUM",
        category: "SCREENSHOT",
        target: "Bun.WebView.screenshot",
        message: `could not capture the audit screenshot proof: ${describeError(error)}`,
      });
    }

    liveChecksComplete = true;
  } finally {
    if (view !== undefined) {
      try {
        await view.close();
        checks.push({
          id: "webview-closed",
          status: "PASS",
          detail: "WebView closed with await view.close()",
        });
      } catch (error) {
        checks.push({
          id: "webview-closed",
          status: "FAIL",
          detail: describeError(error),
        });
        issues.push({
          severity: "MEDIUM",
          category: "WEBVIEW_ERROR",
          target: "Bun.WebView.close",
          message: `WebView close failed: ${describeError(error)}`,
        });
      }
    }
    await closeAllWebViews();
  }

  if (!liveChecksComplete) {
    checks.push({
      id: "webview-closed",
      status: "SKIP",
      detail: "no WebView to close",
    });
  }
  return { checks, issues, backend, screenshotPath, contentSettleMs };
}

/**
 * Run one deployed-portal audit. All side-effecting capabilities are injectable
 * via `runtime`, so tests can prove the live path is never touched offline.
 */
export async function runDocumentationAudit(
  options: AuditOptions = {},
): Promise<AuditSummary> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const outDir = options.outDir ?? join(rootDir, "reports");
  const portalUrl =
    options.portalUrl ?? process.env["DOCS_PORTAL_URL"] ?? DEFAULT_PORTAL_URL;
  const offline = options.offline ?? false;
  const skipLive = options.skipLive ?? false;
  const mode: AuditMode = options.mode ?? (offline ? "offline" : "once");
  const runtime = options.runtime ?? createDefaultAuditRuntime();
  const auditedAt = runtime.now().toISOString();

  const checks: AuditCheck[] = [];
  const issues: AuditIssue[] = [];

  const staticResult = validateStaticEvidence(rootDir);
  checks.push(...staticResult.checks);
  issues.push(...staticResult.issues);

  let backend = "not-launched";
  let screenshotPath: string | undefined;
  let contentSettleMs: number | undefined;

  if (offline) {
    checks.push(
      {
        id: "webview-launch",
        status: "SKIP",
        detail: "offline mode: no Bun.WebView launch",
      },
      {
        id: "webview-ui",
        status: "SKIP",
        detail: "offline mode: title/url/body/Scalar assertions skipped",
      },
      {
        id: "live-spec-hash",
        status: "SKIP",
        detail: "offline mode: no network request for the deployed spec",
      },
    );
  } else {
    const webViewResult = await auditWebView(
      runtime,
      portalUrl,
      outDir,
      auditedAt,
    );
    backend = webViewResult.backend;
    screenshotPath = webViewResult.screenshotPath;
    contentSettleMs = webViewResult.contentSettleMs;
    checks.push(...webViewResult.checks);
    issues.push(...webViewResult.issues);

    if (skipLive) {
      checks.push({
        id: "live-spec-hash",
        status: "SKIP",
        detail: "--skip-live: deployed spec hash comparison skipped",
      });
    } else {
      const liveResult = await checkLiveSpecHash(runtime, rootDir, portalUrl);
      checks.push(liveResult.check);
      if (liveResult.issue !== undefined) issues.push(liveResult.issue);
    }
  }

  const status = summarizeStatus(issues);
  const reportPath = join(outDir, "docs_error_audit.json");
  const summary: AuditSummary = {
    auditedAt,
    portalUrl,
    mode,
    backend,
    checks,
    issues,
    status,
    screenshotPath,
    reportPath,
    contentSettleMs,
  };

  try {
    runtime.mkdirp(outDir);
    await runtime.writeBytes(
      reportPath,
      new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`),
    );
  } catch (error) {
    issues.push({
      severity: "MEDIUM",
      category: "STATIC_DOCS",
      target: reportPath,
      message: `could not write audit report: ${describeError(error)}`,
    });
  }

  const finalStatus = summarizeStatus(issues);
  return { ...summary, issues, status: finalStatus };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export interface AuditCliOptions {
  readonly mode: "once" | "watch";
  readonly schedule: string;
  readonly offline: boolean;
  readonly skipLive: boolean;
  readonly json: boolean;
  readonly portalUrl: string | undefined;
}

const AUDIT_USAGE =
  'usage: bun run scripts/audit_docs_webview_cron.ts [--once|--watch [--schedule "<cron>"]] [--offline] [--portal <url>] [--skip-live] [--json]';

/** Parse audit CLI args; returns a human-readable error string on bad input. */
export function parseAuditCliArgs(
  argv: readonly string[],
): AuditCliOptions | string {
  let mode: "once" | "watch" = "once";
  let schedule = DEFAULT_SCHEDULE;
  let offline = false;
  let skipLive = false;
  let json = false;
  let portalUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--once") {
      mode = "once";
    } else if (argument === "--watch") {
      mode = "watch";
    } else if (argument === "--offline") {
      offline = true;
    } else if (argument === "--skip-live") {
      skipLive = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--portal") {
      const next = argv[index + 1];
      if (next === undefined) return `--portal requires a URL\n${AUDIT_USAGE}`;
      portalUrl = next;
      index += 1;
    } else if (argument.startsWith("--portal=")) {
      portalUrl = argument.slice("--portal=".length);
    } else if (argument === "--schedule") {
      const next = argv[index + 1];
      if (next === undefined) {
        return `--schedule requires a cron expression\n${AUDIT_USAGE}`;
      }
      schedule = next;
      index += 1;
    } else if (argument.startsWith("--schedule=")) {
      schedule = argument.slice("--schedule=".length);
    } else {
      return `unknown argument: ${argument}\n${AUDIT_USAGE}`;
    }
  }
  return { mode, schedule, offline, skipLive, json, portalUrl };
}

function printAuditSummary(summary: AuditSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    `[Doc Auditor] ${summary.status} — ${summary.mode} audit of ${summary.portalUrl} (backend: ${summary.backend})`,
  );
  for (const check of summary.checks) {
    console.log(`  ${check.status.padEnd(4)} ${check.id}: ${check.detail}`);
  }
  for (const issue of summary.issues) {
    console.log(
      `  ISSUE [${issue.severity}/${issue.category}] ${issue.target}: ${issue.message}`,
    );
  }
  if (summary.screenshotPath !== undefined) {
    console.log(`  proof: ${summary.screenshotPath}`);
  }
  if (summary.reportPath !== undefined) {
    console.log(`  report: ${summary.reportPath}`);
  }
}

async function runAuditCliPass(options: {
  readonly rootDir: string;
  readonly outDir: string;
  readonly portalUrl: string | undefined;
  readonly offline: boolean;
  readonly skipLive: boolean;
  readonly mode: AuditMode;
  readonly json: boolean;
}): Promise<AuditSummary> {
  const summary = await runDocumentationAudit({
    rootDir: options.rootDir,
    outDir: options.outDir,
    portalUrl: options.portalUrl,
    offline: options.offline,
    skipLive: options.skipLive,
    mode: options.mode,
  });
  printAuditSummary(summary, options.json);
  return summary;
}

async function runOnceCli(cli: AuditCliOptions): Promise<number> {
  const rootDir = DEFAULT_ROOT_DIR;
  const outDir = join(rootDir, "reports");
  const lockPath = join(outDir, ".docs_audit.lock");
  const lock = acquireAuditLock({ lockPath });
  if (!lock.ok) {
    console.error(
      `[Doc Auditor] refusing to overlap: ${lockPath} held by pid ${lock.holder.pid} since ${lock.holder.startedAt}`,
    );
    return 1;
  }
  try {
    const summary = await runAuditCliPass({
      rootDir,
      outDir,
      portalUrl: cli.portalUrl,
      offline: cli.offline,
      skipLive: cli.skipLive,
      mode: cli.offline ? "offline" : "once",
      json: cli.json,
    });
    return summary.status === "PASS" ? 0 : 1;
  } finally {
    releaseAuditLock(lockPath, process.pid);
    await closeAllWebViews();
  }
}

async function runWatchCli(cli: AuditCliOptions): Promise<number> {
  if (typeof Bun.cron !== "function") {
    console.error(
      "[Doc Auditor] --watch requires in-process Bun.cron (Bun >= 1.4)",
    );
    return 1;
  }
  const rootDir = DEFAULT_ROOT_DIR;
  const outDir = join(rootDir, "reports");
  const lockPath = join(outDir, ".docs_audit.lock");
  const lock = acquireAuditLock({ lockPath });
  if (!lock.ok) {
    console.error(
      `[Doc Auditor] refusing to overlap: ${lockPath} held by pid ${lock.holder.pid} since ${lock.holder.startedAt}`,
    );
    return 1;
  }

  let job: InProcessCronJob | undefined;
  let stopped = false;
  let resolveStopped: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });

  const shutdown = (signal: string): void => {
    if (stopped) return;
    stopped = true;
    console.log(`[Doc Auditor] ${signal} received; draining watch daemon`);
    job?.stop();
    releaseAuditLock(lockPath, process.pid);
    void closeAllWebViews().finally(() => {
      resolveStopped();
    });
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  try {
    await runAuditCliPass({
      rootDir,
      outDir,
      portalUrl: cli.portalUrl,
      offline: cli.offline,
      skipLive: cli.skipLive,
      mode: "watch",
      json: cli.json,
    });
    if (stopped) return 0;
    job = startInProcessCron(cli.schedule, async () => {
      try {
        await runAuditCliPass({
          rootDir,
          outDir,
          portalUrl: cli.portalUrl,
          offline: cli.offline,
          skipLive: cli.skipLive,
          mode: "watch",
          json: cli.json,
        });
      } catch (error) {
        console.error(
          `[Doc Auditor] scheduled audit failed: ${describeError(error)}`,
        );
      }
    });
    job.ref();
    console.log(
      `[Doc Auditor] watch daemon scheduled with Bun.cron "${cli.schedule}"; Ctrl+C to stop`,
    );
    await stoppedPromise;
    return 0;
  } finally {
    if (!stopped) {
      job?.stop();
      releaseAuditLock(lockPath, process.pid);
      await closeAllWebViews();
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const cli = parseAuditCliArgs(argv);
  if (typeof cli === "string") {
    console.error(cli);
    return 2;
  }
  return cli.mode === "watch" ? runWatchCli(cli) : runOnceCli(cli);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`[Doc Auditor] crashed: ${describeError(error)}`);
      process.exitCode = 2;
    },
  );
}
