/**
 * evidence_capture — capture read-only Fantasy402 evidence in mock or live mode.
 *
 * Default mode is `mock`: it replays deterministic fixtures through the exact
 * same record/redaction/skeleton pipeline and never touches the network or a
 * browser. Live mode is opt-in three ways over:
 *
 *   F402_LIVE_CAPTURE=1
 *   F402_BASE_URL, F402_AGENT_ID, F402_PASSWORD (env only, never argv)
 *   F402_OFFLINE_ONLY must not be 1
 *
 * The live path authenticates in a headless Bun.WebView (Chrome backend), reads
 * HttpOnly cookies via CDP, replays them through one Bun.FetchSession per run
 * (honoring HTTP(S)_PROXY/NO_PROXY), and persists value-free capture records.
 *
 * Examples:
 *   bun run scripts/evidence_capture.ts --mode mock --dry-run --json
 *   bun run scripts/evidence_capture.ts --mode mock --out /tmp/cap-test --json
 *   bun run scripts/evidence_capture.ts --ops getWebLog,getBetTicker --json
 *   F402_LIVE_CAPTURE=1 bun run scripts/evidence_capture.ts --mode live --dry-run
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AllowlistError,
  parseOpsArgument,
  READ_ONLY_OPS,
  type ReadOnlyOp,
} from "./capture/allowlist.ts";
import { cookieHandoffForHost } from "./capture/cookies.ts";
import { submitLoginForm } from "./capture/f402_login.ts";
import { isPlainObject, sha256Hex } from "./capture/json.ts";
import {
  assertFixtureOperations,
  buildMockRequest,
  loadMockFixtures,
  MockTransport,
  MockTransportError,
  MOCK_PORTAL_HOST,
  planMockCaptures,
  type MockFixture,
} from "./capture/mock.ts";
import {
  buildLiveRequest,
  hostOf,
  normalizeBaseUrl,
  resolveCaptureVars,
  resolveLoginConfig,
  type CaptureVars,
  type LoginConfig,
  type PlannedRequest,
} from "./capture/ops.ts";
import {
  describeProxy,
  normalizeProxyUrl,
  readProxyEnv,
  setProxyEnv,
  ProxyConfigError,
  type ProxyDescription,
  type ProxySettings,
} from "./capture/proxy.ts";
import {
  buildCaptureRecord,
  CaptureStore,
  manifestHash,
  type WrittenCapture,
} from "./capture/recorder.ts";
import {
  PiiLeakError,
  redactError,
  redactUrlForLog,
} from "./capture/redact.ts";
import { HttpSession, SessionError } from "./capture/session.ts";
import type {
  CaptureManifest,
  CaptureMode,
  CaptureRecord,
  Env,
  HttpTransport,
  RawHttpResponse,
} from "./capture/types.ts";
import {
  escapeForExpression,
  ManagedWebView,
  WebViewError,
} from "./capture/webview.ts";
import {
  chromeFailureAdvice,
  diagnoseChromeBackend,
} from "../lib/webview_backend_diagnostics.ts";

export const CLI_NAME = "evidence_capture";
const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CliOptions {
  mode: CaptureMode;
  opsArg: string;
  proxy: string | null;
  out: string | null;
  timeoutMs: number;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParseArgsResult =
  { ok: true; options: CliOptions } | { ok: false; message: string };

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

/** Parse argv without touching the network, files or process environment. */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const options: CliOptions = {
    mode: "mock",
    opsArg: "all",
    proxy: null,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
    json: false,
    help: false,
  };
  try {
    let index = 0;
    while (index < argv.length) {
      const raw = argv[index] ?? "";
      const equals = raw.indexOf("=");
      const flag = equals === -1 ? raw : raw.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);
      const valueFor = (name: string): string => {
        if (inlineValue !== undefined) {
          if (inlineValue.length === 0)
            throw new UsageError(`${name} requires a value`);
          return inlineValue;
        }
        const value = takeValue(argv, index, name);
        index += 1;
        return value;
      };
      switch (flag) {
        case "--mode": {
          const mode = valueFor("--mode");
          if (mode !== "mock" && mode !== "live") {
            throw new UsageError('--mode must be "mock" or "live"');
          }
          options.mode = mode;
          break;
        }
        case "--ops":
          options.opsArg = valueFor("--ops");
          break;
        case "--proxy": {
          const rawProxy = valueFor("--proxy");
          try {
            normalizeProxyUrl(rawProxy);
          } catch (error) {
            throw new UsageError(redactError(error));
          }
          options.proxy = rawProxy;
          break;
        }
        case "--out": {
          const out = valueFor("--out");
          if (out.trim().length === 0)
            throw new UsageError("--out requires a directory");
          options.out = out;
          break;
        }
        case "--timeout-ms": {
          const parsed = Number(valueFor("--timeout-ms"));
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new UsageError("--timeout-ms must be a positive integer");
          }
          options.timeoutMs = parsed;
          break;
        }
        case "--dry-run":
          options.dryRun = true;
          break;
        case "--json":
          options.json = true;
          break;
        case "--help":
        case "-h":
          options.help = true;
          break;
        default:
          throw new UsageError(
            raw.startsWith("-")
              ? `unknown flag ${raw}`
              : `unexpected argument "${raw}" (this CLI takes flags only)`,
          );
      }
      index += 1;
    }
  } catch (error) {
    if (error instanceof UsageError)
      return { ok: false, message: error.message };
    throw error;
  }
  return { ok: true, options };
}

const HELP_TEXT = `evidence_capture — capture read-only Fantasy402 wire evidence

Usage:
  bun run scripts/evidence_capture.ts [--mode mock|live] [--ops <comma|all>]
      [--proxy URL] [--out DIR] [--timeout-ms N] [--dry-run] [--json]

Options:
  --mode        mock (default, offline fixtures) or live (opt-in, needs env gate)
  --ops         Comma list of allowlisted ops, or "all" (default)
                (${READ_ONLY_OPS.join(", ")})
  --proxy       HTTP proxy URL for the live data path (sets HTTP(S)_PROXY for the run)
  --out         Capture store directory (default: docs/evidence/captures)
  --timeout-ms  Per-request timeout for live mode (default: ${DEFAULT_TIMEOUT_MS})
  --dry-run     Print the planned ops/target/proxy and write nothing
  --json        Emit one JSON object on stdout (warnings go to stderr)
  --help, -h    Show this help

Live gate (all required, env only — never pass secrets in argv):
  F402_LIVE_CAPTURE=1
  F402_BASE_URL, F402_AGENT_ID, F402_PASSWORD
  (F402_OFFLINE_ONLY=1 forces live mode OFF)

Examples:
  bun run scripts/evidence_capture.ts --mode mock --dry-run --json
  bun run scripts/evidence_capture.ts --mode mock --out /tmp/cap-test --json
  bun run scripts/evidence_capture.ts --ops getWebLog,getBetTicker --json
  F402_LIVE_CAPTURE=1 bun run scripts/evidence_capture.ts --mode live --dry-run

Exit codes: 0 success · 1 runtime/redaction failure · 2 usage/refusal/unsafe op
`;

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface LiveAuthConfig {
  env: Env;
  baseUrl: string;
  login: LoginConfig;
  timeoutMs: number;
}

export interface LiveAuthSession {
  /** Raw Cookie header value — memory only, never logged or persisted. */
  cookieHeader: string;
  cookieNames: readonly string[];
  /**
   * Portal-issued `Authorization: Bearer <jwt>` value (fantasy402 manager API).
   * Memory only: never logged, persisted, or written to a capture record.
   */
  authorizationHeader?: string;
  close(): Promise<void>;
}

export type AuthSessionFactory = (
  config: LiveAuthConfig,
) => Promise<LiveAuthSession>;

export type TransportFactory = (options: {
  timeoutMs: number;
}) => HttpTransport;

export interface CliDeps {
  env: Env;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  rootDir: string;
  /** Live-only: replace the Chrome WebView login (tests inject a fake). */
  createAuthSession?: AuthSessionFactory;
  /** Live-only: replace Bun.FetchSession (tests inject a fake). */
  createTransport?: TransportFactory;
  /** Live-only: replace the docs/openapi.json read. */
  loadOpenApi?: () => Promise<unknown>;
}

export interface CliResult {
  code: number;
  payload: Record<string, unknown> | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Live gate
// ---------------------------------------------------------------------------

export interface LiveGate {
  enabled: boolean;
  missing: string[];
  reason: string | null;
}

/** Decide whether live capture is allowed, naming only env var *names*. */
export function evaluateLiveGate(env: Env): LiveGate {
  const missing: string[] = [];
  if (env["F402_LIVE_CAPTURE"]?.trim() !== "1") {
    missing.push("F402_LIVE_CAPTURE=1");
  }
  if (env["F402_OFFLINE_ONLY"]?.trim() === "1") {
    return {
      enabled: false,
      missing: [],
      reason: "F402_OFFLINE_ONLY=1 disables live capture for this process",
    };
  }
  for (const name of ["F402_BASE_URL", "F402_AGENT_ID", "F402_PASSWORD"]) {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) missing.push(name);
  }
  if (missing.length > 0) {
    return {
      enabled: false,
      missing,
      reason: `live capture is disabled (missing: ${missing.join(", ")})`,
    };
  }
  return { enabled: true, missing: [], reason: null };
}

// ---------------------------------------------------------------------------
// Default live auth (WebView + CDP cookies)
// ---------------------------------------------------------------------------

/**
 * Authenticate in a headless Chrome WebView and hand back the session Cookie
 * header. The view is always closed; only the cookie header survives in memory.
 */
export async function authenticateWithWebView(
  config: LiveAuthConfig,
): Promise<LiveAuthSession> {
  const { loadF402CredentialsSecure } =
    await import("../lib/f402_credentials_policy.ts");
  const { agentId: agentID, password } = await loadF402CredentialsSecure(
    config.env,
  );
  void password;
  if (agentID.length === 0) {
    throw new Error(
      "live capture requires keychain (secrets:f402) or TTY credentials",
    );
  }
  const view = ManagedWebView.launch({
    backend: "chrome",
    navigateTimeoutMs: config.timeoutMs,
  });
  try {
    // fantasy402 keeps the native view URL at `about:blank` while serving its
    // SPA; allow that bootstrap state, then wait for the login form to exist
    // AND its framework to bind (a click before hydration falls through to a
    // native form submit and discards the typed values).
    await view.navigate(config.login.loginUrl, { allowOpaqueUrl: true });
    await view.waitForSelector(config.login.userSelector, {
      timeoutMs: config.timeoutMs,
    });
    // The login form is server-rendered; its submit handler is bound by jQuery
    // slightly later. Clicking before that falls through to a native form POST
    // that reloads the page and drops the typed values. Wait, then retry with a
    // refill if the first attempt landed prematurely.
    const hydrationMs = Number(config.env["F402_LOGIN_HYDRATION_MS"] ?? "1500");
    await Bun.sleep(Number.isFinite(hydrationMs) ? hydrationMs : 1500);
    const submitExists = await view.evaluate(
      `(() => document.querySelector(${escapeForExpression(config.login.submitSelector)}) !== null)()`,
    );

    let probe: unknown = null;
    const attemptDeadline = Date.now() + config.timeoutMs;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await view.fill(config.login.userSelector, agentID);
      await view.fill(config.login.passSelector, password);
      // Submit button when the markup has one; otherwise requestSubmit() before
      // any key press (Enter cannot implicitly submit a two-field form, and
      // WebKit delivers no keydown for it when the selector is missing).
      await submitLoginForm(view, config.login, submitExists === true);
      const attemptEnd = Math.min(Date.now() + 8_000, attemptDeadline);
      for (;;) {
        probe = await view.evaluate(config.login.authenticatedExpression);
        const authed =
          isPlainObject(probe) &&
          probe["hasPasswordField"] !== true &&
          String(probe["url"] ?? "").length > 0;
        if (authed) break;
        if (Date.now() >= attemptEnd || Date.now() >= attemptDeadline) break;
        await Bun.sleep(250);
      }
      if (
        isPlainObject(probe) &&
        probe["hasPasswordField"] !== true &&
        String(probe["url"] ?? "").length > 0
      ) {
        break;
      }
      if (Date.now() >= attemptDeadline) break;
      // The page may have reloaded to the login form; give it a moment to
      // re-render before the next fill + submit.
      await view.waitForSelector(config.login.userSelector, {
        timeoutMs: 10_000,
      });
      await Bun.sleep(1_000);
    }
    if (isPlainObject(probe) && probe["hasPasswordField"] === true) {
      throw new Error(
        "login did not complete: password field is still present after submit",
      );
    }
    const cookies = await view.getAllCookies();
    const handoff = cookieHandoffForHost(
      cookies,
      hostOf(config.baseUrl),
      undefined,
      undefined,
      {
        requestSecure: config.baseUrl.startsWith("https:"),
      },
    );
    const authorizationHeader = await extractPortalAuthorization(view);
    return {
      cookieHeader: handoff.header,
      cookieNames: handoff.summary.names,
      ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
      close: async () => {
        // The WebView is already closed in the finally block below; cookies were
        // extracted into memory. Nothing to release.
      },
    };
  } catch (error) {
    // Chrome's real death reason only exists on its stderr; classify it before surfacing the
    // opaque "Chrome process closed the pipe" so the operator gets a fix, not a stack.
    if (
      error instanceof WebViewError &&
      (error.code === "launch-failed" || error.code === "navigate-failed")
    ) {
      const diagnosis = await diagnoseChromeBackend({ env: config.env });
      if (!diagnosis.available) {
        throw new WebViewError(
          error.code,
          `${error.message}\n${chromeFailureAdvice(diagnosis).join("\n")}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    await view.close();
  }
}

/**
 * fantasy402's manager API authenticates with `Authorization: Bearer <jwt>`,
 * not with the session cookie (the cookie jar only holds Cloudflare clearance).
 * The JWT lives in page storage and is attached by the page's XHR layer; read it
 * into memory only. Never logged or persisted.
 */
async function extractPortalAuthorization(
  view: ManagedWebView,
): Promise<string | undefined> {
  try {
    const fromStorage = await view.evaluate(`(() => {
      const jwt = /eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/;
      for (const store of [sessionStorage, localStorage]) {
        for (const key of Object.keys(store)) {
          const value = store.getItem(key) || "";
          const match = value.match(jwt);
          if (match) return "Bearer " + match[0];
        }
      }
      return null;
    })()`);
    if (typeof fromStorage === "string" && fromStorage.startsWith("Bearer ")) {
      return fromStorage;
    }
  } catch {
    // Storage access can be denied by the page; fall through to XHR capture.
  }
  try {
    await view.evaluate(`(() => {
      window.__f402Auth = [];
      const proto = XMLHttpRequest.prototype;
      const setHeader = proto.setRequestHeader;
      proto.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === "authorization") {
          window.__f402Auth.push(String(value));
        }
        return setHeader.apply(this, arguments);
      };
      return true;
    })()`);
    // A read-only menu click triggers manager XHRs that carry the header.
    await view.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll("a,button,li,span,div"))
        .find((el) => (el.innerText || "").trim() === "Bet Ticker");
      target?.click();
      return Boolean(target);
    })()`);
    const deadline = Date.now() + 12_000;
    for (;;) {
      const captured = await view.evaluate(
        `(() => (window.__f402Auth || [])[0] ?? null)()`,
      );
      if (typeof captured === "string" && captured.startsWith("Bearer ")) {
        return captured;
      }
      if (Date.now() >= deadline) return undefined;
      await Bun.sleep(250);
    }
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function defaultRootDir(): string {
  return join(import.meta.dir, "..");
}

function defaultOutDir(rootDir: string): string {
  return join(rootDir, "docs", "evidence", "captures");
}

/**
 * `--proxy` overrides the HTTPS/HTTP proxy for this run. Bun ignores explicit
 * fetch proxy options, so the run applies it to the environment; the description
 * must reflect the override, not just what was already in the environment.
 */
function effectiveProxySettings(
  deps: CliDeps,
  explicitProxy: string | null,
): ProxySettings {
  const fromEnv = readProxyEnv(deps.env);
  if (explicitProxy === null) return fromEnv;
  const normalized = normalizeProxyUrl(explicitProxy);
  return {
    httpProxy: normalized,
    httpsProxy: normalized,
    noProxy: fromEnv.noProxy,
  };
}

function timestampFor(
  records: readonly CaptureRecord[],
  fallback: Date,
): string {
  if (records.length === 0) return fallback.toISOString();
  let latest = records[0]?.capturedAt ?? fallback.toISOString();
  for (const record of records) {
    if (record.capturedAt > latest) latest = record.capturedAt;
  }
  return latest;
}

interface MockBuildOutcome {
  record: CaptureRecord;
  warning: string | null;
  fixtureFile: string;
}

function findFixtureForOp(
  fixtures: readonly MockFixture[],
  op: ReadOnlyOp,
): MockFixture | undefined {
  const expectedPath = `/cloud/api/Manager/${op}`;
  return fixtures.find((fixture) => fixture.operation.path === expectedPath);
}

async function buildMockRecords(
  deps: CliDeps,
  ops: readonly ReadOnlyOp[],
): Promise<{ outcomes: MockBuildOutcome[]; warnings: string[] }> {
  const fixtureDir = join(deps.rootDir, "tests", "fixtures", "captures");
  const fixtures = await loadMockFixtures(fixtureDir);
  assertFixtureOperations(fixtures);
  const transport = new MockTransport(fixtures);
  const outcomes: MockBuildOutcome[] = [];
  const warnings: string[] = [];

  for (const op of ops) {
    const fixture = findFixtureForOp(fixtures, op);
    if (fixture === undefined) {
      throw new UsageError(
        `no mock fixture for "${op}" under ${fixtureDir} (expected ${op}.mock.json)`,
      );
    }
    const request = buildMockRequest(fixture);
    let response: RawHttpResponse | null = null;
    let warning: string | null = null;
    try {
      response = await transport.fetch(request);
    } catch (error) {
      if (
        error instanceof MockTransportError &&
        error.code === "missing-response"
      ) {
        warning = `${op}: fixture simulates a missing response; record will have response:null`;
        warnings.push(warning);
      } else {
        throw error;
      }
    }
    const operationId =
      fixture.operation.operationId ?? `postCloudApiManager${op}`;
    const record = buildCaptureRecord({
      mode: "mock",
      capturedAt: fixture.capturedAt,
      operation: {
        path: fixture.operation.path,
        method: fixture.operation.method,
        operationId,
      },
      request: {
        url: request.url,
        method: request.method,
        headers: request.headers ?? {},
        contentType: fixture.request.contentType,
        body: request.body ?? null,
      },
      response:
        response === null
          ? null
          : {
              status: response.status,
              headers: response.headers,
              contentType: response.contentType,
              bytes: response.bytes,
            },
      provenance: {
        portalHost: MOCK_PORTAL_HOST,
        proxy: "none",
        auth: "none",
        bunVersion: Bun.version,
      },
      samples: fixture.samples ?? 1,
    });
    outcomes.push({
      record,
      warning,
      fixtureFile: `${op}.mock.json`,
    });
  }
  return { outcomes, warnings };
}

interface StoreWriteResult {
  outDir: string;
  manifestPath: string;
  manifestHashValue: string;
  captures: WrittenCapture[];
  counts: CaptureManifest["counts"];
  generatedAt: string;
}

async function persistRecords(
  records: readonly CaptureRecord[],
  outDir: string,
): Promise<StoreWriteResult> {
  const fixedNow = timestampFor(records, new Date());
  const store = new CaptureStore({
    root: outDir,
    now: () => new Date(fixedNow),
  });
  const captures: WrittenCapture[] = [];
  for (const record of records) captures.push(await store.write(record));
  const manifest = await store.finalize();
  // Keep committed capture records formatter-clean (repo CI runs
  // `format:check` over docs/evidence/captures when the store is committed).
  Bun.spawnSync([process.execPath, "fmt", outDir], { cwd: outDir });
  return {
    outDir,
    manifestPath: join(outDir, "manifest.json"),
    manifestHashValue: manifestHash(manifest),
    captures,
    counts: manifest.counts,
    generatedAt: manifest.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

interface PlannedOpView {
  op: ReadOnlyOp;
  path: string;
  method: string;
  operationId: string;
  contentType: string;
  plannedUrl: string;
  requestBodySha256: string;
  responseStatus: number | null;
}

async function runDryRun(
  options: CliOptions,
  deps: CliDeps,
  ops: readonly ReadOnlyOp[],
): Promise<CliResult> {
  const outDir = options.out ?? defaultOutDir(deps.rootDir);
  const proxyDescription = describeProxy(
    effectiveProxySettings(deps, options.proxy),
  );
  const warnings: string[] = [];
  let targetHost: string | null = null;
  let plannedAt = deps.now().toISOString();
  let plannedOps: PlannedOpView[] = [];
  let liveGate: LiveGate | null = null;

  if (options.mode === "mock") {
    const fixtureDir = join(deps.rootDir, "tests", "fixtures", "captures");
    const fixtures = await loadMockFixtures(fixtureDir);
    assertFixtureOperations(fixtures);
    let plans;
    try {
      plans = planMockCaptures(fixtures, ops);
    } catch (error) {
      if (error instanceof MockTransportError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
    targetHost = MOCK_PORTAL_HOST;
    plannedAt = plans.reduce<string>(
      (latest, plan) =>
        plan.fixture.capturedAt > latest ? plan.fixture.capturedAt : latest,
      plans[0]?.fixture.capturedAt ?? deps.now().toISOString(),
    );
    plannedOps = plans.map((plan) => ({
      op: plan.op,
      path: plan.fixture.operation.path,
      method: plan.fixture.operation.method,
      operationId:
        plan.fixture.operation.operationId ?? `postCloudApiManager${plan.op}`,
      contentType: plan.fixture.request.contentType,
      plannedUrl: plan.request.url,
      requestBodySha256: plan.requestBodySha256,
      responseStatus: plan.responseStatus,
    }));
    if (plans.some((plan) => plan.responseStatus === null)) {
      warnings.push(
        "at least one fixture has response:null; the resulting record is not upgradeable",
      );
    }
  } else {
    liveGate = evaluateLiveGate(deps.env);
    if (!liveGate.enabled) {
      return {
        code: 2,
        payload: {
          ok: false,
          error: {
            code: "LIVE_GATE",
            message:
              liveGate.reason ??
              "live capture is disabled; set F402_LIVE_CAPTURE=1 plus credentials",
            missing: liveGate.missing,
          },
        },
        warnings: [],
      };
    }
    const baseUrl = normalizeBaseUrl(deps.env["F402_BASE_URL"] ?? "");
    targetHost = hostOf(baseUrl);
    const openapi = await loadOpenApiDocument(deps);
    const vars = resolveCaptureVars(deps.env, deps.now());
    plannedAt = deps.now().toISOString();
    plannedOps = ops.map((op) =>
      viewPlannedRequest(op, buildLiveRequest(op, baseUrl, vars, openapi)),
    );
    if (proxyDescription.present) {
      warnings.push(
        "WebView login does not honor HTTP(S)_PROXY (Chrome/system proxy only); the FetchSession data path does",
      );
    }
  }

  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    command: CLI_NAME,
    mode: options.mode,
    dryRun: true,
    writes: false,
    plannedAt,
    outDir,
    targetHost,
    proxy: proxyDescription,
    timeoutMs: options.timeoutMs,
    ops: plannedOps,
    ...(liveGate === null ? {} : { liveGate }),
    warnings,
  };
  return { code: 0, payload, warnings };
}

function viewPlannedRequest(
  op: ReadOnlyOp,
  planned: PlannedRequest,
): PlannedOpView {
  return {
    op,
    path: planned.operation.path,
    method: planned.method,
    operationId: planned.operation.operationId ?? `postCloudApiManager${op}`,
    contentType: planned.contentType,
    plannedUrl: redactUrlForLog(planned.url),
    requestBodySha256: sha256Hex(planned.body ?? ""),
    responseStatus: null,
  };
}

// ---------------------------------------------------------------------------
// Mock run
// ---------------------------------------------------------------------------

async function runMock(
  options: CliOptions,
  deps: CliDeps,
  ops: readonly ReadOnlyOp[],
): Promise<CliResult> {
  const outDir = options.out ?? defaultOutDir(deps.rootDir);
  const { outcomes, warnings } = await buildMockRecords(deps, ops);
  const persisted = await persistRecords(
    outcomes.map((outcome) => outcome.record),
    outDir,
  );
  const captures = persisted.captures.map((written, index) => ({
    file: written.file,
    operation: written.entry.operation,
    mode: written.entry.mode,
    responseStatus: written.entry.responseStatus,
    captureHash: written.captureHash,
    fixture: outcomes[index]?.fixtureFile ?? null,
  }));
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    command: CLI_NAME,
    mode: "mock",
    dryRun: false,
    outDir: persisted.outDir,
    manifest: persisted.manifestPath,
    manifestHash: persisted.manifestHashValue,
    generatedAt: persisted.generatedAt,
    counts: persisted.counts,
    captures,
    warnings,
  };
  return { code: 0, payload, warnings };
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function loadOpenApiDocument(deps: CliDeps): Promise<unknown> {
  if (deps.loadOpenApi !== undefined) return deps.loadOpenApi();
  const path = join(deps.rootDir, "docs", "openapi.json");
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    deps.stderr(
      `warning: could not read docs/openapi.json (${redactError(error)}); using observed request templates`,
    );
    return null;
  }
}

interface LiveRunContext {
  options: CliOptions;
  deps: CliDeps;
  ops: readonly ReadOnlyOp[];
  outDir: string;
  baseUrl: string;
  vars: CaptureVars;
  openapi: unknown;
  planned: PlannedRequest[];
  proxy: ProxyDescription;
}

async function runLive(
  options: CliOptions,
  deps: CliDeps,
  ops: readonly ReadOnlyOp[],
): Promise<CliResult> {
  const gate = evaluateLiveGate(deps.env);
  if (!gate.enabled) {
    return {
      code: 2,
      payload: {
        ok: false,
        error: {
          code: "LIVE_GATE",
          message:
            gate.reason ??
            "live capture is disabled; set F402_LIVE_CAPTURE=1 plus credentials",
          missing: gate.missing,
        },
      },
      warnings: [],
    };
  }
  const baseUrl = normalizeBaseUrl(deps.env["F402_BASE_URL"] ?? "");
  const openapi = await loadOpenApiDocument(deps);
  const vars = resolveCaptureVars(deps.env, deps.now());
  const planned = ops.map((op) => buildLiveRequest(op, baseUrl, vars, openapi));
  const proxy = describeProxy(effectiveProxySettings(deps, options.proxy));
  const outDir = options.out ?? defaultOutDir(deps.rootDir);

  const context: LiveRunContext = {
    options,
    deps,
    ops,
    outDir,
    baseUrl,
    vars,
    openapi,
    planned,
    proxy,
  };

  const restoreProxy =
    options.proxy === null ? () => {} : setProxyEnv(options.proxy, Bun.env);
  let auth: LiveAuthSession | null = null;
  let transport: HttpTransport | null = null;
  const warnings: string[] = [];
  if (proxy.present) {
    warnings.push(
      "WebView login does not honor HTTP(S)_PROXY (Chrome/system proxy only); the FetchSession data path does",
    );
  }
  try {
    const login = resolveLoginConfig(deps.env, baseUrl);
    const authFactory = deps.createAuthSession ?? authenticateWithWebView;
    auth = await authFactory({
      env: deps.env,
      baseUrl,
      login,
      timeoutMs: options.timeoutMs,
    });
    transport =
      deps.createTransport?.({ timeoutMs: options.timeoutMs }) ??
      new HttpSession({ timeoutMs: options.timeoutMs });
    const records: CaptureRecord[] = [];
    for (const request of context.planned) {
      const headers: Record<string, string> = {
        ...request.headers,
        cookie: auth.cookieHeader,
        ...(auth.authorizationHeader === undefined
          ? {}
          : { authorization: auth.authorizationHeader }),
      };
      let response: RawHttpResponse | null = null;
      try {
        response = await transport.fetch({
          url: request.url,
          method: request.method,
          headers,
          body: request.body,
          timeoutMs: options.timeoutMs,
          retryable: true,
        });
      } catch (error) {
        // A transport failure is evidence too: keep the request and record a
        // null response (never upgradeable) instead of discarding the run.
        if (error instanceof SessionError || error instanceof WebViewError) {
          const message = `${request.operation.operationId ?? request.operation.path}: ${redactError(error)}; recording response:null`;
          warnings.push(message);
          deps.stderr(`warning: ${message}`);
        } else {
          throw error;
        }
      }
      const record = buildCaptureRecord({
        mode: "live",
        capturedAt: deps.now().toISOString(),
        operation: request.operation,
        request: {
          url: request.url,
          method: request.method,
          headers,
          contentType: request.contentType,
          body: request.body,
        },
        response:
          response === null
            ? null
            : {
                status: response.status,
                headers: response.headers,
                contentType: response.contentType,
                bytes: response.bytes,
              },
        provenance: {
          portalHost: hostOf(baseUrl),
          proxy: proxy.present ? "env" : "none",
          auth: "cookie",
          bunVersion: Bun.version,
        },
        samples: 1,
      });
      records.push(record);
    }
    const persisted = await persistRecords(records, outDir);
    return {
      code: 0,
      payload: {
        schemaVersion: 1,
        command: CLI_NAME,
        mode: "live",
        dryRun: false,
        outDir: persisted.outDir,
        manifest: persisted.manifestPath,
        manifestHash: persisted.manifestHashValue,
        generatedAt: persisted.generatedAt,
        counts: persisted.counts,
        cookieNames: auth.cookieNames,
        proxy,
        captures: persisted.captures.map((written) => ({
          file: written.file,
          operation: written.entry.operation,
          mode: written.entry.mode,
          responseStatus: written.entry.responseStatus,
          captureHash: written.captureHash,
        })),
        warnings,
      },
      warnings,
    };
  } finally {
    await transport?.close?.();
    await auth?.close();
    restoreProxy();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function mergeDeps(overrides: Partial<CliDeps>): CliDeps {
  const rootDir = overrides.rootDir ?? defaultRootDir();
  return {
    env: overrides.env ?? Bun.env,
    now: overrides.now ?? (() => new Date()),
    stdout: overrides.stdout ?? ((line: string) => console.log(line)),
    stderr: overrides.stderr ?? ((line: string) => console.error(line)),
    rootDir,
    ...(overrides.createAuthSession === undefined
      ? {}
      : { createAuthSession: overrides.createAuthSession }),
    ...(overrides.createTransport === undefined
      ? {}
      : { createTransport: overrides.createTransport }),
    ...(overrides.loadOpenApi === undefined
      ? {}
      : { loadOpenApi: overrides.loadOpenApi }),
  };
}

export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps = mergeDeps(overrides);
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const wantsJson = argv.includes("--json");
    if (wantsJson) {
      deps.stdout(
        JSON.stringify({
          ok: false,
          command: CLI_NAME,
          error: { code: "USAGE", message: parsed.message },
        }),
      );
    } else {
      deps.stderr(`error: ${parsed.message}`);
      deps.stderr("run with --help for usage and examples");
    }
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    deps.stdout(HELP_TEXT);
    return 0;
  }

  let ops: ReadOnlyOp[];
  try {
    ops = parseOpsArgument(options.opsArg);
  } catch (error) {
    if (error instanceof AllowlistError) {
      if (options.json) {
        deps.stdout(
          JSON.stringify({
            ok: false,
            command: CLI_NAME,
            mode: options.mode,
            error: { code: "OFF_ALLOWLIST", message: error.message },
          }),
        );
      } else {
        deps.stderr(`error: ${error.message}`);
      }
      return 2;
    }
    throw error;
  }

  let result: CliResult;
  try {
    result = options.dryRun
      ? await runDryRun(options, deps, ops)
      : options.mode === "live"
        ? await runLive(options, deps, ops)
        : await runMock(options, deps, ops);
  } catch (error) {
    return reportFailure(error, options, deps);
  }

  if (result.payload !== null) {
    const refused = result.payload["ok"] === false;
    if (options.json) {
      deps.stdout(JSON.stringify(result.payload));
    } else if (refused) {
      const errorInfo = result.payload["error"];
      const message = isPlainObject(errorInfo)
        ? String(errorInfo["message"] ?? "capture refused")
        : "capture refused";
      const errorCode = isPlainObject(errorInfo)
        ? String(errorInfo["code"] ?? "REFUSED")
        : "REFUSED";
      deps.stderr(`error [${errorCode}]: ${message}`);
    } else {
      printHumanSummary(result.payload);
    }
  }
  for (const warning of result.warnings) deps.stderr(`warning: ${warning}`);
  if (result.code !== 0 && result.payload === null) {
    deps.stderr("error: capture failed");
  }
  return result.code;
}

function printHumanSummary(payload: Record<string, unknown>): void {
  const mode = String(payload["mode"] ?? "unknown");
  const dryRun = payload["dryRun"] === true;
  const outDir = String(payload["outDir"] ?? "");
  const targetHost = payload["targetHost"];
  process.stdout.write(
    `${dryRun ? "planned" : "captured"} mode=${mode} out=${outDir}${typeof targetHost === "string" ? ` target=${targetHost}` : ""}\n`,
  );
  const ops = payload["ops"];
  if (Array.isArray(ops)) {
    for (const entry of ops) {
      if (!isPlainObject(entry)) continue;
      process.stdout.write(
        `  ${String(entry["op"] ?? "?")} ${String(entry["method"] ?? "")} ${String(entry["path"] ?? "")} -> ${String(entry["plannedUrl"] ?? "")}\n`,
      );
    }
  }
  const captures = payload["captures"];
  if (Array.isArray(captures)) {
    for (const entry of captures) {
      if (!isPlainObject(entry)) continue;
      const operation = isPlainObject(entry["operation"])
        ? String(entry["operation"]["path"] ?? "?")
        : "?";
      process.stdout.write(
        `  ${String(entry["file"] ?? "?")} (${operation}, status ${String(entry["responseStatus"] ?? "none")})\n`,
      );
    }
  }
  const manifest = payload["manifest"];
  if (typeof manifest === "string")
    process.stdout.write(`manifest: ${manifest}\n`);
  const counts = payload["counts"];
  if (isPlainObject(counts)) {
    process.stdout.write(
      `counts: total=${String(counts["total"])} withResponse=${String(counts["withResponse"])} withSuccessResponse=${String(counts["withSuccessResponse"])} withErrorResponse=${String(counts["withErrorResponse"])} emptyResponse=${String(counts["emptyResponse"])} withoutResponse=${String(counts["withoutResponse"])} clean=${String(counts["clean"])}\n`,
    );
  }
}

function reportFailure(
  error: unknown,
  options: CliOptions,
  deps: CliDeps,
): number {
  let code = 1;
  let errorCode = "CAPTURE_FAILED";
  let message = redactError(error);
  if (error instanceof UsageError) {
    code = 2;
    errorCode = "USAGE";
  } else if (error instanceof AllowlistError) {
    code = 2;
    errorCode = "OFF_ALLOWLIST";
  } else if (error instanceof ProxyConfigError) {
    code = 2;
    errorCode = "PROXY_CONFIG";
  } else if (error instanceof PiiLeakError) {
    errorCode = "PII_LEAK";
  } else if (error instanceof SessionError) {
    errorCode = `SESSION_${error.code.toUpperCase().replace(/-/g, "_")}`;
  } else if (error instanceof WebViewError) {
    errorCode = `WEBVIEW_${error.code.toUpperCase().replace(/-/g, "_")}`;
  }
  if (options.json) {
    deps.stdout(
      JSON.stringify({
        ok: false,
        command: CLI_NAME,
        mode: options.mode,
        error: { code: errorCode, message },
      }),
    );
  } else {
    deps.stderr(`error [${errorCode}]: ${message}`);
  }
  return code;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
