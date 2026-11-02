#!/usr/bin/env bun
/**
 * @file catalog_probe.ts
 * @description Live Fantasy402 pregame catalog probe (Bun.WebView auth +
 * FetchSession wire capture). Captures `Manager/getSportsType` from the live
 * portal, stores a redacted capture record plus a value-carrying sports
 * snapshot (sport names are public catalog data), diffs the live sports list
 * against the committed fixture, and renders docs/evidence/pregame-catalog.md.
 *
 * Live mode is gated: requires F402_LIVE_CAPTURE=1 and the F402_* credentials
 * already used by `scripts/evidence_capture.ts`. Nothing here mutates the
 * portal; only one read-only POST is issued.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCaptureRecord,
  captureHash,
  captureRelativePath,
} from "./capture/recorder.ts";
import { HttpSession } from "./capture/session.ts";
import { sha256Hex, tryParseJson } from "./capture/json.ts";
import {
  authenticateWithWebView,
  evaluateLiveGate,
  type LiveAuthConfig,
  type LiveAuthSession,
} from "./evidence_capture.ts";
import { resolveLoginConfig } from "./capture/ops.ts";
import {
  describeProxy,
  normalizeProxyUrl,
  readProxyEnv,
  redactProxyUrl,
} from "./capture/proxy.ts";

const CLI_NAME = "catalog_probe";
const SPORTS_ENDPOINT = "/cloud/api/Manager/getSportsType";
const OBSERVED_BODY = "operation=getSportsType&agentID=&agentOwner=&RRO=1";
const OBSERVED_CONTENT_TYPE =
  "application/x-www-form-urlencoded; charset=UTF-8";
const DEFAULT_FIXTURE =
  "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json";
const DEFAULT_OUT = "docs/evidence/captures/catalog";
const REPORT_RELATIVE_PATH = "docs/evidence/pregame-catalog.md";

export interface CatalogArgs {
  dryRun: boolean;
  json: boolean;
  out: string;
  fixture: string;
  timeoutMs: number;
  /**
   * Proxy for the probe's own HTTP request.
   *
   * `undefined` leaves the environment in charge; `false` forces a direct
   * connection even when `HTTP(S)_PROXY` is set; a string is a normalized
   * `http(s)://host:port`.
   */
  proxy?: Bun.FetchProxyOption | undefined;
}

export interface SportsDiff {
  liveCount: number;
  fixtureCount: number;
  added: string[];
  removed: string[];
  unchanged: number;
}

export interface CatalogProbeDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  createAuth?: (config: LiveAuthConfig) => Promise<LiveAuthSession>;
  createTransport?: (options: {
    timeoutMs: number;
    proxy?: Bun.FetchProxyOption | undefined;
  }) => {
    fetch(request: {
      url: string;
      method: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string | null;
      timeoutMs?: number;
      retryable?: boolean;
    }): Promise<{
      status: number;
      headers: Record<string, string>;
      contentType: string;
      bytes: Uint8Array;
    }>;
    close?: () => Promise<void>;
  };
  writeFile?: (path: string, content: string) => Promise<void>;
}

export function parseCatalogArgs(argv: readonly string[]): CatalogArgs {
  const args: CatalogArgs = {
    dryRun: false,
    json: false,
    out: DEFAULT_OUT,
    fixture: DEFAULT_FIXTURE,
    timeoutMs: 20_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--out") args.out = argv[++i] ?? args.out;
    else if (arg === "--fixture") args.fixture = argv[++i] ?? args.fixture;
    else if (arg === "--timeout-ms") {
      const parsed = Number(argv[++i] ?? "");
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms requires a positive number");
      }
      args.timeoutMs = parsed;
    } else if (arg === "--proxy") {
      if (args.proxy === false) {
        throw new Error("--proxy and --no-proxy are mutually exclusive");
      }
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--proxy requires a value");
      // Normalizes and rejects empty values, non-http(s) schemes, paths and
      // query strings. An empty value would otherwise mean "read the
      // environment", which is the opposite of what the flag is for.
      args.proxy = normalizeProxyUrl(raw);
    } else if (arg === "--no-proxy") {
      if (args.proxy !== undefined) {
        throw new Error("--proxy and --no-proxy are mutually exclusive");
      }
      args.proxy = false;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        [
          "catalog_probe — live pregame sports catalog probe",
          "",
          "Usage: bun run scripts/catalog_probe.ts [options]",
          "",
          "  --dry-run            Print the plan and exit (no browser, no network)",
          "  --json               Machine-readable summary on stdout",
          "  --out <dir>          Capture output dir (default docs/evidence/captures/catalog)",
          "  --fixture <path>     Catalog fixture to diff against",
          "  --timeout-ms <n>     Per-request/login timeout (default 20000)",
          "  --proxy <url>        Send the probe request through this http(s) proxy",
          "  --no-proxy           Connect directly, ignoring HTTP(S)_PROXY for the request",
          "  --help               This help",
          "",
          "Live gate: F402_LIVE_CAPTURE=1 + F402_BASE_URL/F402_AGENT_ID/F402_PASSWORD",
        ].join("\n"),
      );
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

export function diffSports(
  live: readonly string[],
  fixture: readonly string[],
): SportsDiff {
  const liveSet = new Set(live.map((s) => s.trim()).filter(Boolean));
  const fixtureSet = new Set(fixture.map((s) => s.trim()).filter(Boolean));
  const added = [...liveSet].filter((s) => !fixtureSet.has(s)).sort();
  const removed = [...fixtureSet].filter((s) => !liveSet.has(s)).sort();
  return {
    liveCount: liveSet.size,
    fixtureCount: fixtureSet.size,
    added,
    removed,
    unchanged: [...liveSet].filter((s) => fixtureSet.has(s)).length,
  };
}

interface CatalogFixture {
  provider?: string;
  capturedAt?: string;
  periodsCapturedAt?: string;
  sportCount?: number;
  subSportCount?: number;
  sportPeriodCount?: number;
  collisions?: { code: string; sports: string[] }[];
  sports: { sport: string; subSports: unknown[]; periods: unknown[] }[];
}

export function loadFixture(path: string): CatalogFixture {
  const raw = tryParseJson(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`fixture is not a JSON object: ${path}`);
  }
  return raw as CatalogFixture;
}

export function renderCatalogReport(input: {
  fixture: CatalogFixture;
  fixturePath: string;
  liveSports: string[];
  diff: SportsDiff;
  capturedAt: string;
  captureSha256: string;
  endpoint: string;
  probeLease: "live" | "dry-run";
}): string {
  const subSports = input.fixture.sports.reduce(
    (n, s) => n + (Array.isArray(s.subSports) ? s.subSports.length : 0),
    0,
  );
  const periodMenus = input.fixture.sports.filter(
    (s) => Array.isArray(s.periods) && s.periods.length > 0,
  ).length;
  const lines: string[] = [
    "# Live pregame catalog probe (sports / sub-sports / periods)",
    "",
    `Generated by \`scripts/catalog_probe.ts\` on ${input.capturedAt} (${input.probeLease}).`,
    "",
    "## What was probed live",
    "",
    `- Endpoint: \`POST ${input.endpoint}\` (read-only, authenticated with the portal Bearer JWT).`,
    `- Response: \`{"LIST":[{"0":"<id>","sportType":"<name>"}...]} — ${input.diff.liveCount} sports captured.`,
    `- Capture record (value-free skeleton + sha256): \`${input.capturedAt.slice(0, 10)}/${"getSportsType.post.json"}\` (sha256 \`${input.captureSha256}\`).`,
    "- Sports names are public catalog data and are stored alongside the capture; no customer data is persisted.",
    "",
    "## Sports diff: live vs committed fixture",
    "",
    `Fixture: \`${input.fixturePath}\` (capturedAt ${input.fixture.capturedAt ?? "?"}).`,
    "",
    "| Metric | Fixture | Live |",
    "| --- | --- | --- |",
    `| Sports | ${input.diff.fixtureCount} | ${input.diff.liveCount} |`,
    `| Unchanged | ${input.diff.unchanged} | |`,
    `| Added (live only) | ${input.diff.added.length} | |`,
    `| Removed (fixture only) | ${input.diff.removed.length} | |`,
    "",
    input.diff.added.length > 0
      ? `Added: ${input.diff.added.map((s) => `\`${s}\``).join(", ")}`
      : "Added: none.",
    "",
    input.diff.removed.length > 0
      ? `Removed: ${input.diff.removed.map((s) => `\`${s}\``).join(", ")}`
      : "Removed: none.",
    "",
    "## Sub-sport lanes and period menus (pregame desk catalog)",
    "",
    "The live generic Manager API exposes the **sports list** only (`getSportsType`).",
    "Sub-sport lanes and per-sport period menus are desk-navigation catalog data,",
    "captured by the separate catalog fixture — not by an observed HTTP endpoint:",
    "",
    `- Fixture shape: ${input.fixture.sportCount ?? input.diff.fixtureCount} sports · ${input.fixture.subSportCount ?? subSports} sub-sports · ${input.fixture.sportPeriodCount ?? periodMenus} sports with period menus.`,
    `- Period menus capturedAt: ${input.fixture.periodsCapturedAt ?? "unknown"}.`,
    `- Desk-link collision ids: ${(input.fixture.collisions ?? []).map((c) => `\`${c.code}\` (${c.sports.join(" + ")})`).join(", ") || "none"}.`,
    "",
    "**Status:** live sports parity is verified above; live sub-sport/period capture",
    "still requires the Ticketwriter/board surface (headless navigation of that",
    "surface is not yet automated). Until then the fixture remains the source of",
    "sub-sport/period shapes, and this probe is the live sports check.",
    "",
    "## Reproduce",
    "",
    "```bash",
    "F402_LIVE_CAPTURE=1 bun run catalog:probe          # live capture + diff + report",
    "bun run catalog:probe --dry-run                    # plan only",
    "```",
    "",
  ];
  return lines.join("\n");
}

export async function runCatalogProbe(
  argv: readonly string[],
  deps: CatalogProbeDeps,
): Promise<number> {
  let args: CatalogArgs;
  try {
    args = parseCatalogArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args0WantsHelp(argv)) {
      deps.stdout(message);
      return 0;
    }
    deps.stderr(`error: ${message}`);
    return 2;
  }

  const baseUrl = (deps.env["F402_BASE_URL"] ?? "").replace(/\/$/, "");
  const gate = evaluateLiveGate(deps.env);
  if (!gate.enabled && !args.dryRun) {
    const payload = {
      ok: false,
      command: CLI_NAME,
      error: {
        code: "LIVE_GATE",
        message: gate.reason ?? "live capture is disabled",
        missing: gate.missing,
      },
    };
    if (args.json) deps.stdout(JSON.stringify(payload));
    else deps.stderr(`error [LIVE_GATE]: ${payload.error.message}`);
    return 2;
  }

  const fixture = loadFixture(args.fixture);
  const fixtureSports = fixture.sports.map((s) => s.sport);
  const capturedAt = deps.now().toISOString();
  const proxy = describeProxy(readProxyEnv(deps.env));

  if (args.dryRun) {
    const plan = {
      ok: true,
      command: CLI_NAME,
      dryRun: true,
      endpoint: SPORTS_ENDPOINT,
      targetHost: baseUrl.length > 0 ? new URL(baseUrl).host : null,
      auth: "Bearer JWT extracted by WebView login (memory only)",
      proxy: proxy.present,
      proxyOverride:
        args.proxy === false
          ? "direct"
          : typeof args.proxy === "string"
            ? redactProxyUrl(args.proxy)
            : null,
      fixture: args.fixture,
      fixtureSports: fixtureSports.length,
      out: args.out,
    };
    if (args.json) deps.stdout(JSON.stringify(plan));
    else {
      deps.stdout(
        `[catalog_probe] dry-run: POST ${SPORTS_ENDPOINT} via WebView auth → diff ${fixtureSports.length} fixture sports → ${args.out}`,
      );
    }
    return 0;
  }

  const login = resolveLoginConfig(deps.env as Record<string, string>, baseUrl);
  const authFactory = deps.createAuth ?? authenticateWithWebView;
  const auth = await authFactory({
    env: deps.env as Record<string, string>,
    baseUrl,
    login,
    timeoutMs: args.timeoutMs,
  });
  const transport =
    deps.createTransport?.({ timeoutMs: args.timeoutMs, proxy: args.proxy }) ??
    new HttpSession({ timeoutMs: args.timeoutMs, proxy: args.proxy });
  try {
    const requestHeaders: Record<string, string> = {
      "content-type": OBSERVED_CONTENT_TYPE,
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      ...(auth.cookieHeader.length > 0 ? { cookie: auth.cookieHeader } : {}),
      ...(auth.authorizationHeader === undefined
        ? {}
        : { authorization: auth.authorizationHeader }),
    };
    const response = await transport.fetch({
      url: `${baseUrl}${SPORTS_ENDPOINT}`,
      method: "POST",
      headers: requestHeaders,
      body: OBSERVED_BODY,
      timeoutMs: args.timeoutMs,
      retryable: true,
    });
    const text = new TextDecoder().decode(response.bytes);
    const parsed = tryParseJson(text);
    if (response.status !== 200) {
      deps.stderr(
        `error: ${SPORTS_ENDPOINT} returned HTTP ${response.status} (expected 200) the probe made no catalog changes.`,
      );
      return 1;
    }
    const list = isRecord(parsed) ? parsed["LIST"] : undefined;
    if (!Array.isArray(list)) {
      deps.stderr("error: getSportsType response has no LIST array");
      return 1;
    }
    const liveSports = list
      .map((item) => (isRecord(item) ? String(item["sportType"] ?? "") : ""))
      .filter((s) => s.length > 0);
    const diff = diffSports(liveSports, fixtureSports);
    const record = buildCaptureRecord({
      mode: "live",
      capturedAt,
      operation: {
        path: SPORTS_ENDPOINT,
        method: "POST",
        operationId: "catalogProbeGetSportsType",
      },
      request: {
        url: `${baseUrl}${SPORTS_ENDPOINT}`,
        method: "POST",
        headers: requestHeaders,
        contentType: OBSERVED_CONTENT_TYPE,
        body: OBSERVED_BODY,
      },
      response: {
        status: response.status,
        headers: response.headers,
        contentType: response.contentType,
        bytes: response.bytes,
      },
      provenance: {
        portalHost: new URL(baseUrl).host,
        proxy: proxy.present ? "env" : "none",
        auth: "cookie",
        bunVersion: Bun.version,
      },
    });
    const relPath = captureRelativePath(record);
    const dateDir = record.capturedAt.slice(0, 10);
    const capturePath = join(args.out, dateDir, "getSportsType.post.json");
    const sportsPath = join(args.out, dateDir, "sports.json");
    const manifestPath = join(args.out, "catalog-manifest.json");
    const write = deps.writeFile ?? (async (p, c) => Bun.write(p, c));
    await write(capturePath, `${JSON.stringify(record, null, 2)}\n`);
    await write(
      sportsPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          provider: "fantasy402",
          source: "live getSportsType probe",
          capturedAt,
          endpoint: SPORTS_ENDPOINT,
          sportCount: liveSports.length,
          sports: [...new Set(liveSports)].sort(),
        },
        null,
        2,
      )}\n`,
    );
    const digest = captureHash(record);
    const existing = existsSync(manifestPath)
      ? (tryParseJson(readFileSync(manifestPath, "utf8")) as Record<
          string,
          unknown
        >)
      : {};
    const captures = Array.isArray(existing["captures"])
      ? existing["captures"]
      : [];
    await write(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: capturedAt,
          provider: "fantasy402",
          captures: [
            ...(captures as unknown[]).filter(
              (c) => isRecord(c) && c["file"] !== relPath,
            ),
            {
              file: relPath,
              captureHash: digest,
              sha256: sha256Hex(JSON.stringify(record)),
              endpoint: SPORTS_ENDPOINT,
              capturedAt,
              sportCount: liveSports.length,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const report = renderCatalogReport({
      fixture,
      fixturePath: args.fixture,
      liveSports,
      diff,
      capturedAt,
      captureSha256: digest,
      endpoint: SPORTS_ENDPOINT,
      probeLease: "live",
    });
    await write(REPORT_RELATIVE_PATH, report);
    // Keep committed probe artifacts formatter-clean (CI runs format:check).
    Bun.spawnSync([process.execPath, "fmt", args.out], { cwd: args.out });
    Bun.spawnSync([process.execPath, "fmt", REPORT_RELATIVE_PATH]);
    const summary = {
      ok: true,
      command: CLI_NAME,
      endpoint: SPORTS_ENDPOINT,
      capturedAt,
      out: args.out,
      capture: capturePath,
      captureHash: digest,
      sports: liveSports.length,
      diff,
      report: REPORT_RELATIVE_PATH,
    };
    if (args.json) deps.stdout(JSON.stringify(summary));
    else {
      deps.stdout(
        `[catalog_probe] live sports=${diff.liveCount} fixture=${diff.fixtureCount} added=${diff.added.length} removed=${diff.removed.length}`,
      );
      deps.stdout(`[catalog_probe] capture ${capturePath} (sha256 ${digest})`);
      deps.stdout(`[catalog_probe] report  ${REPORT_RELATIVE_PATH}`);
    }
    return 0;
  } finally {
    await auth.close();
    await transport.close?.();
  }
}

function args0WantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  runCatalogProbe(process.argv.slice(2), {
    env: process.env,
    now: () => new Date(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
  })
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        `catalog_probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}
