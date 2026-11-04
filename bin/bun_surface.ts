#!/usr/bin/env bun
/**
 * @file bin/bun_surface.ts
 * @description What this Bun build can actually do, and where its declarations disagree.
 *
 *   ./bin/dx bun
 *   ./bin/dx bun --url https://portal.example/api --json
 *   ./bin/dx bun --strict
 *
 * Read-only and offline: presence checks, a version comparison and a proxy
 * decision. Nothing here opens a socket or reads a credential.
 */

import * as nodeCrypto from "node:crypto";

import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  describeProxy,
  proxyForUrl,
  readProxyEnv,
  redactProxyUrl,
} from "../scripts/capture/proxy.ts";
import type { TypesReport } from "./bun_types.ts";

const HELP = `
dx bun — runtime surface, declaration drift and proxy routing

Options:
  --url <url>        Also report which proxy this URL would use (http/https only)
  --baseline <path>  Diff namespace surface against a probe baseline
                     (default: tests/bun_baseline.json when it exists)
  --no-baseline      Skip the baseline diff
  --types            Compare the declared surface with the runtime via the
                     TypeScript compiler API (~1 s; reports gaps, never fails)
  --json             One JSON object on stdout
  --strict           Exit 1 when @types/bun does not match Bun.version
  -h, --help         This text

The baseline diff reads the 'ns.own' probe from 'bun run probe:bun' output —
typeof and own property names per namespace — and compares it to this runtime.
A removed member or a changed typeof exits 1; a new member is reported as a note.
Run 'bun run probe:bun' for the full behaviour diff.

Checks are presence-only (typeof), grouped by the subsystem that needs them.
Exit codes: 0 surface intact, 1 a required API is missing or --strict failed, 2 usage.

Examples:
  ./bin/dx bun
  ./bin/dx bun --json | jq .missing
  ./bin/dx bun --url https://portal.example/cloud/api/Manager/getWebLog
`.trim();

type Group = "core" | "capture" | "storage" | "compat";

interface Check {
  readonly group: Group;
  readonly name: string;
  readonly read: () => unknown;
}

const CHECKS: readonly Check[] = [
  // Core: every CLI path assumes these.
  { group: "core", name: "fetch", read: () => Bun.fetch },
  { group: "core", name: "serve", read: () => Bun.serve },
  { group: "core", name: "file", read: () => Bun.file },
  { group: "core", name: "write", read: () => Bun.write },
  { group: "core", name: "spawn", read: () => Bun.spawn },
  { group: "core", name: "sleep", read: () => Bun.sleep },
  { group: "core", name: "which", read: () => Bun.which },
  { group: "core", name: "inspect.table", read: () => Bun.inspect.table },
  { group: "core", name: "semver.satisfies", read: () => Bun.semver.satisfies },
  { group: "core", name: "HTMLRewriter", read: () => HTMLRewriter },
  { group: "core", name: "JSON5", read: () => Bun.JSON5.parse },
  { group: "core", name: "JSONL.parse", read: () => Bun.JSONL.parse },
  { group: "core", name: "JSONL.parseChunk", read: () => Bun.JSONL.parseChunk },
  { group: "core", name: "CSRF", read: () => Bun.CSRF.generate },
  {
    group: "core",
    name: "isStandaloneExecutable",
    read: () => Bun.isStandaloneExecutable,
  },
  { group: "core", name: "sliceAnsi", read: () => Bun.sliceAnsi },
  { group: "core", name: "TOML", read: () => Bun.TOML.parse },
  { group: "core", name: "XML", read: () => Bun.XML.parse },
  { group: "core", name: "YAML", read: () => Bun.YAML.parse },
  { group: "core", name: "markdown", read: () => Bun.markdown.html },

  // Capture: the F402 / screenshot / catalog path.
  { group: "capture", name: "WebView", read: () => Bun.WebView },
  // Enumerable keys miss this one: class statics are non-enumerable, so a
  // capability check built on Object.keys(Bun.WebView) reports nothing.
  {
    group: "capture",
    name: "WebView.closeAll",
    read: () => Bun.WebView.closeAll,
  },
  { group: "capture", name: "Image", read: () => Bun.Image },
  { group: "capture", name: "FetchSession", read: () => Bun.FetchSession },
  { group: "capture", name: "CookieMap", read: () => Bun.CookieMap },
  { group: "capture", name: "connect", read: () => Bun.connect },
  { group: "capture", name: "listen", read: () => Bun.listen },
  { group: "capture", name: "udpSocket", read: () => Bun.udpSocket },
  { group: "capture", name: "dns.lookup", read: () => Bun.dns.lookup },
  // Present at runtime, absent from the 1.4.4 declarations — the cast is the
  // same one tests/bun_capabilities.test.ts uses, and the drift list explains it.
  {
    group: "capture",
    name: "dns.resolve",
    read: () => (Bun.dns as unknown as Record<string, unknown>)["resolve"],
  },
  { group: "capture", name: "secrets.get", read: () => Bun.secrets.get },
  { group: "capture", name: "Terminal", read: () => Bun.Terminal },
  { group: "capture", name: "Archive", read: () => Bun.Archive },

  // Storage: settlement and evidence paths.
  { group: "storage", name: "SQL", read: () => Bun.SQL },
  { group: "storage", name: "S3Client", read: () => Bun.S3Client },
  { group: "storage", name: "s3", read: () => Bun.s3 },
  { group: "storage", name: "RedisClient", read: () => Bun.RedisClient },
  { group: "storage", name: "cron", read: () => Bun.cron },

  // Compatibility: Web/Node surfaces this repo can adopt, pinned so a runtime downgrade
  // cannot remove them silently before adoption. They are presence-only like the rest; no
  // source path calls them yet, so a missing one is a review item, not a broken capture.
  {
    group: "compat",
    // node:crypto declares argon2Sync from Node 20.12; the cast keeps this check about the
    // binary, not about the @types/node copy installed today.
    name: "node:crypto.argon2Sync",
    read: () =>
      (nodeCrypto as unknown as Record<string, unknown>)["argon2Sync"],
  },
  {
    group: "compat",
    // Bun extension on the WHATWG client socket (pause/resume backpressure); lib.dom has no
    // declaration for it, so read it off the prototype rather than a typed value.
    name: "WebSocket.pause",
    read: () =>
      (WebSocket.prototype as unknown as Record<string, unknown>)["pause"],
  },
];

interface Drift {
  readonly id: string;
  readonly note: string;
}

const DEFAULT_BASELINE = "tests/bun_baseline.json";

type BaselineSeverity = "removed" | "type" | "added";

interface BaselineDiff {
  readonly severity: BaselineSeverity;
  /** Member name, or `Member.prop` for a property change. */
  readonly member: string;
  readonly note: string;
}

interface BaselineReport {
  readonly path: string;
  readonly members: number;
  /** Namespace split derived from the baseline rows, not a second list. */
  readonly namespaces: { value: string[]; typeOnly: string[] };
  readonly diffs: BaselineDiff[];
}

interface BaselineRow {
  readonly k: string;
  readonly t: string;
  readonly own: string[] | null;
}

/** Throws on any row that is not `{ k: string, t: string, own: string[] | null }`. */
function parseBaselineRows(value: unknown): BaselineRow[] {
  if (!Array.isArray(value)) throw new Error("ns.own is not an array");
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null) throw new Error("bad row");
    const { k, t, own } = row as Record<string, unknown>;
    const ownOk =
      own === null ||
      (Array.isArray(own) && own.every((p) => typeof p === "string"));
    if (typeof k !== "string" || typeof t !== "string" || !ownOk) {
      throw new Error("bad row");
    }
    return { k, t, own: own as string[] | null };
  });
}

/**
 * Diff the `ns.own` probe against the live runtime.
 *
 * Deliberately a subset of `bun run probe:bun`: one file read, no child
 * processes, so it can run in <50 ms before a capture. The full probe is still
 * the authority on eval/crash behaviour.
 */
async function baselineReport(
  path: string,
  required: boolean,
): Promise<BaselineReport | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (required) {
      console.error(`error: baseline not found: ${path}`);
      process.exit(2);
    }
    return null;
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    console.error(`error: baseline is not JSON: ${path}`);
    process.exit(2);
  }
  const probe =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["ns.own"]
      : undefined;
  const stdout =
    typeof probe === "object" && probe !== null
      ? (probe as Record<string, unknown>)["stdout"]
      : undefined;
  if (typeof stdout !== "string") {
    if (required) {
      console.error(
        `error: ${path} has no ns.own probe (not a probe:bun baseline)`,
      );
      process.exit(2);
    }
    return null;
  }

  let rows: BaselineRow[];
  try {
    rows = parseBaselineRows(JSON.parse(stdout));
  } catch {
    console.error(`error: ${path} has an unreadable ns.own probe`);
    process.exit(2);
  }

  const bun = Bun as unknown as Record<string, unknown>;
  const diffs: BaselineDiff[] = [];
  for (const row of rows) {
    const live = bun[row.k];
    const liveType = typeof live;
    if (live === undefined && row.t !== "undefined") {
      diffs.push({
        severity: "removed",
        member: row.k,
        note: `Bun.${row.k} was ${row.t} at baseline and is undefined now.`,
      });
      continue;
    }
    if (live !== undefined && liveType !== row.t) {
      diffs.push({
        severity: "type",
        member: row.k,
        note: `Bun.${row.k} was ${row.t} at baseline and is ${liveType} now.`,
      });
      continue;
    }
    if (row.own === null || live === undefined) continue;

    const liveOwn = new Set(Object.getOwnPropertyNames(live as object));
    for (const prop of row.own) {
      if (!liveOwn.has(prop)) {
        diffs.push({
          severity: "removed",
          member: `${row.k}.${prop}`,
          note: `Bun.${row.k}.${prop} existed at baseline and is gone.`,
        });
      }
    }
    for (const prop of liveOwn) {
      if (!row.own.includes(prop)) {
        diffs.push({
          severity: "added",
          member: `${row.k}.${prop}`,
          note: `Bun.${row.k}.${prop} is new since the baseline.`,
        });
      }
    }
  }
  return {
    path,
    members: rows.length,
    namespaces: {
      value: rows.filter((r) => r.t !== "undefined").map((r) => r.k),
      typeOnly: rows.filter((r) => r.t === "undefined").map((r) => r.k),
    },
    diffs,
  };
}

/**
 * Known declaration/runtime disagreements, measured rather than assumed.
 * Each one is a place where reading only one layer gives the wrong answer.
 */
function collectDrift(
  typesVersion: string | null,
  computedTypes: boolean,
): Drift[] {
  const drift: Drift[] = [];
  const bun = Bun as unknown as Record<string, unknown>;

  if (
    bun["WebSocket"] === undefined &&
    typeof globalThis.WebSocket === "function"
  ) {
    drift.push({
      id: "websocket-global",
      note: "WebSocket is a global, not Bun.WebSocket; bun.com/reference lists it under Bun.",
    });
  }
  if (typesVersion !== null && typesVersion !== Bun.version) {
    drift.push({
      id: "types-version",
      note: `@types/bun ${typesVersion} does not match Bun ${Bun.version}.`,
    });
  }
  if (!computedTypes) {
    drift.push({
      id: "dns-resolve",
      note: "Bun.dns.resolve is present at runtime but absent from the 1.4.4 type surface.",
    });
  }
  return drift;
}

interface SurfaceReport {
  readonly runtime: {
    version: string;
    revision: string;
    typesVersion: string | null;
    typesMatch: boolean | null;
  };
  readonly checks: { name: string; group: Group; ok: boolean }[];
  /** Derived from the baseline; null when there is no baseline. */
  readonly namespaces: { value: string[]; typeOnly: string[] } | null;
  readonly baseline: BaselineReport | null;
  /** Present only with --types. */
  readonly types: TypesReport | null;
  readonly missing: string[];
  readonly drift: Drift[];
  readonly proxy: ReturnType<typeof proxyReport> | null;
}

async function typesVersion(): Promise<string | null> {
  const file = Bun.file("node_modules/@types/bun/package.json");
  if (!(await file.exists())) return null;
  try {
    const pkg = (await file.json()) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function proxyReport(url: string | null) {
  const env = describeProxy(readProxyEnv());
  if (url === null) {
    return { url: null, mode: null, proxy: null, reason: null, env };
  }
  const decision = proxyForUrl(url);
  return {
    url,
    mode: decision.mode,
    proxy: decision.proxy === null ? null : redactProxyUrl(decision.proxy),
    reason: decision.reason,
    env,
  };
}

const VALUE_FLAGS = ["--url", "--baseline"];
const SWITCHES = new Set([
  "--json",
  "--strict",
  "--types",
  "--no-baseline",
  "-h",
  "--help",
]);
const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}
const usageErrors = [
  ...[...parsed.switches]
    .filter((flag) => !SWITCHES.has(flag))
    .map((flag) =>
      VALUE_FLAGS.includes(flag)
        ? `${flag} needs a value`
        : `unknown flag ${flag}`,
    ),
  ...[...parsed.values.keys()]
    .filter((flag) => !VALUE_FLAGS.includes(flag))
    .map((flag) => `unknown flag ${flag}`),
  ...parsed.positionals.map((arg) => `unexpected argument ${arg}`),
];
if (usageErrors.length > 0) {
  console.error(`error: ${usageErrors.join("; ")} (see --help)`);
  process.exit(2);
}

const rawUrl = flagValue(parsed, "--url", "");
let url: string | null = null;
if (rawUrl.length > 0) {
  let candidate: URL;
  try {
    candidate = new URL(rawUrl);
  } catch {
    console.error(`error: --url is not a valid URL: ${rawUrl}`);
    process.exit(2);
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    console.error(`error: --url must be http(s), got ${candidate.protocol}`);
    process.exit(2);
  }
  url = candidate.href;
}

const types = await typesVersion();
const explicitBaseline = hasFlag(parsed, "--baseline");
const baselinePath = hasFlag(parsed, "--no-baseline")
  ? null
  : flagValue(parsed, "--baseline", DEFAULT_BASELINE);
const baseline =
  baselinePath === null
    ? null
    : await baselineReport(baselinePath, explicitBaseline);
const namespaces = baseline?.namespaces ?? null;
const typesReport = hasFlag(parsed, "--types")
  ? await (
      await import("./bun_types.ts")
    ).declarationDrift(namespaces?.value ?? [])
  : null;
const results = CHECKS.map((check) => {
  let ok = false;
  try {
    ok = check.read() !== undefined && check.read() !== null;
  } catch {
    ok = false;
  }
  return { name: check.name, group: check.group, ok };
});

const report: SurfaceReport = {
  runtime: {
    version: Bun.version,
    revision: Bun.revision.slice(0, 10),
    typesVersion: types,
    typesMatch: types === null ? null : types === Bun.version,
  },
  checks: results,
  namespaces,
  baseline,
  types: typesReport,
  missing: results.filter((r) => !r.ok).map((r) => r.name),
  drift: collectDrift(
    types,
    typesReport !== null && typesReport.error === null,
  ),
  proxy: proxyReport(url),
};

if (hasFlag(parsed, "--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const counts = (group: Group) => {
    const rows = results.filter((r) => r.group === group);
    const ok = rows.filter((r) => r.ok).length;
    return `${ok}/${rows.length}`;
  };
  console.log(
    `Bun ${report.runtime.version} (${report.runtime.revision}) · @types/bun ${types ?? "not installed"}`,
  );
  console.log(
    `  surface   core ${counts("core")}   capture ${counts("capture")}   storage ${counts("storage")}   compat ${counts("compat")}`,
  );
  if (namespaces !== null) {
    console.log(
      `  namespace ${namespaces.value.length} value · ${namespaces.typeOnly.length} type-only (${namespaces.typeOnly.join(", ")})`,
    );
  }
  if (baseline !== null) {
    console.log(
      `  baseline  ${baseline.members} members · ${baseline.diffs.length} diff(s) (${baseline.path})`,
    );
    for (const diff of baseline.diffs) {
      console.log(`  ${diff.severity.padEnd(9)} ${diff.note}`);
    }
  }
  if (typesReport !== null) {
    if (typesReport.error !== null) {
      console.log(`  types     unavailable: ${typesReport.error}`);
    } else {
      console.log(
        `  types     declared ${typesReport.declared} · runtime ${typesReport.runtime} · ${typesReport.absent.length} absent · ${typesReport.undeclared.length} undeclared`,
      );
      if (typesReport.absent.length > 0) {
        console.log(`  absent    ${typesReport.absent.join(", ")}`);
      }
      if (typesReport.undeclared.length > 0) {
        console.log(`  undecl    ${typesReport.undeclared.join(", ")}`);
      }
      for (const gap of typesReport.namespaces) {
        if (gap.absent.length === 0 && gap.undeclared.length === 0) continue;
        const parts: string[] = [];
        if (gap.undeclared.length > 0)
          parts.push(`${gap.undeclared.length} undeclared`);
        if (gap.absent.length > 0) parts.push(`${gap.absent.length} absent`);
        console.log(`  gap       ${gap.name}: ${parts.join(" · ")}`);
      }
    }
  }
  if (report.missing.length > 0) {
    console.log(`  missing   ${report.missing.join(", ")}`);
  }
  for (const note of report.drift) console.log(`  drift     ${note.note}`);
  if (url !== null && report.proxy !== null) {
    const p = report.proxy;
    console.log(
      `  proxy     ${p.mode === "proxy" ? p.proxy : "direct"} (${p.reason}) for ${p.url}`,
    );
    const env = p.env;
    console.log(
      `  env       ${env.present ? `${env.http ?? "-"} / ${env.https ?? "-"}` : "no HTTP(S)_PROXY"} · NO_PROXY ${env.noProxyCount} entr${env.noProxyCount === 1 ? "y" : "ies"}`,
    );
  }
}

const strict = hasFlag(parsed, "--strict");
const baselineFailures =
  baseline?.diffs.filter((d) => d.severity !== "added") ?? [];
if (report.missing.length > 0 || baselineFailures.length > 0) process.exit(1);
if (strict && report.runtime.typesMatch === false) process.exit(1);
