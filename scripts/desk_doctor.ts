#!/usr/bin/env bun
/**
 * @file scripts/desk_doctor.ts
 * @description One command that answers "is the desk telling the truth?" for a human and for an
 * agent. It reads the daemon's own routes, resolves every data panel to a basis
 * (capture / paste / fixture / derived) plus an age, and prints the exact command that would
 * refresh a panel that is pasted, stale or unread.
 *
 *   bun run desk:doctor                human report; exit 1 only when the verdict is FAIL
 *   bun run desk:doctor --json         machine-readable document (schemaVersion 1)
 *   bun run desk:doctor --check        exit 1 on an error issue (stale, unread, unclassified)
 *   bun run desk:doctor --check --strict
 *                                      exit 1 on any warning too (paste, fixture, bridge job)
 *   bun run desk:doctor --max-age 3600 add an age budget where a route sends no stale flag
 *
 * Exit codes: 0 healthy (or report-mode warning), 1 check failed or verdict FAIL, 2 no service or
 * bad invocation. The document is read-only: it never writes an artifact and never reads a
 * credential; the routes it uses are loopback-readable and aggregate-only.
 *
 * Measured 2026-11-04 at 127.0.0.1:4020: /api/kpis carries provenance.basis for its four cards,
 * while the board, scoreboard, contests, catalog and analysis routes carry only a source and a
 * date; this command is what turns those into the same vocabulary without changing any route.
 *
 * For the rendered dashboard (ANSI/HTML/Markdown) use `bun run dashboard:view`; this command is
 * the data-health gate, not the view.
 */

import {
  checkFailed,
  collectDeskHealth,
  formatAge,
  DESK_HEALTH_SCHEMA_VERSION,
  DEFAULT_DESK_BASE_URL,
  DEFAULT_PROBE_TIMEOUT_MS,
  type DeskHealth,
} from "../lib/desk_health.ts";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  type ParsedArgs,
} from "../lib/cli_args.ts";

const VALUE_FLAGS = ["--url", "--max-age", "--timeout"] as const;
const SWITCH_FLAGS = ["--json", "--check", "--strict", "--help", "-h"] as const;

export interface DeskDoctorInvocation {
  readonly baseUrl: string;
  readonly json: boolean;
  readonly check: boolean;
  readonly strict: boolean;
  readonly maxAgeSeconds: number | null;
  readonly timeoutMs: number;
  readonly help: boolean;
}

export type DeskDoctorParse =
  | { readonly ok: true; readonly value: DeskDoctorInvocation }
  | { readonly ok: false; readonly error: string };

export const DESK_DOCTOR_HELP = `
desk:doctor — data health for the SportsDesk desk panels

Usage:
  bun run desk:doctor [options]

Options:
  --url <url>        Daemon origin (default: ${DEFAULT_DESK_BASE_URL})
  --json             Print the machine-readable document (schemaVersion ${DESK_HEALTH_SCHEMA_VERSION})
  --check            Exit 1 when an error issue is present; 0 otherwise
  --strict           With --check, treat warnings (paste, fixture, bridge job) as failures
  --max-age <s>      Mark a panel stale when its age exceeds this; no budget is invented otherwise
  --timeout <ms>     Per-request bound (default: ${DEFAULT_PROBE_TIMEOUT_MS})
  -h, --help         This text

Exit codes:
  0  healthy, or report mode with warnings only
  1  --check failed, or the verdict is FAIL in report mode
  2  no desk service at --url, or a bad invocation

Panels are read from the daemon's own routes; nothing is written and no credential is read.
Token-gated panels (watchlist, Telegram) are out of scope by design, and this is not a CI gate:
it needs a running daemon, so it belongs in an operator or agent pre-flight, not the CI chain.
Basis vocabulary: capture (API), paste (operator transcription), fixture (demo data), derived.
The rendered dashboard is a different command: bun run dashboard:view.
`.trim();

function integerFlag(
  args: ParsedArgs,
  name: string,
  options: {
    readonly fallback: number | null;
    readonly min: number;
    readonly max: number;
  },
):
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly error: string } {
  const raw = args.values.get(name)?.at(-1);
  if (raw === undefined) return { ok: true, value: options.fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    return {
      ok: false,
      error: `${name} expects an integer ${options.min}..${options.max}, got "${raw}".\n  bun run desk:doctor --help`,
    };
  }
  return { ok: true, value };
}

export function parseDeskDoctorArgs(argv: readonly string[]): DeskDoctorParse {
  const args = parseCliArgs(argv, { valueFlags: VALUE_FLAGS });
  for (const name of args.switches) {
    if (!SWITCH_FLAGS.includes(name as (typeof SWITCH_FLAGS)[number])) {
      return {
        ok: false,
        error: `unknown flag "${name}".\n  bun run desk:doctor --help`,
      };
    }
  }
  for (const name of args.values.keys()) {
    if (!VALUE_FLAGS.includes(name as (typeof VALUE_FLAGS)[number])) {
      return {
        ok: false,
        error: `unknown flag "${name}".\n  bun run desk:doctor --help`,
      };
    }
  }
  if (args.positionals.length > 0) {
    return {
      ok: false,
      error: `desk:doctor takes no positional arguments, got "${args.positionals.join(" ")}".\n  bun run desk:doctor --help`,
    };
  }

  const url = flagValue(args, "--url", DEFAULT_DESK_BASE_URL).trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      error: `--url "${url}" is not a URL.\n  bun run desk:doctor --url ${DEFAULT_DESK_BASE_URL}`,
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      error: `--url must be http or https, got "${parsedUrl.protocol}".\n  bun run desk:doctor --url ${DEFAULT_DESK_BASE_URL}`,
    };
  }

  const maxAge = integerFlag(args, "--max-age", {
    fallback: null,
    min: 1,
    max: 31_536_000,
  });
  if (!maxAge.ok) return maxAge;
  const timeout = integerFlag(args, "--timeout", {
    fallback: DEFAULT_PROBE_TIMEOUT_MS,
    min: 100,
    max: 30_000,
  });
  if (!timeout.ok) return timeout;

  return {
    ok: true,
    value: {
      baseUrl: parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, ""),
      json: hasFlag(args, "--json"),
      check: hasFlag(args, "--check"),
      strict: hasFlag(args, "--strict"),
      maxAgeSeconds: maxAge.value,
      timeoutMs: timeout.value ?? DEFAULT_PROBE_TIMEOUT_MS,
      help: hasFlag(args, "--help", "-h"),
    },
  };
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/** Human report: service line, verdict, panel table, issues, next commands. */
export function renderDeskHealthReport(health: DeskHealth): string {
  const lines: string[] = [];
  const service = health.service;
  lines.push(`desk:doctor — data health for ${health.baseUrl}`);
  if (!service.reachable) {
    lines.push(
      `service: UNREACHABLE${service.httpStatus === null ? "" : ` (HTTP ${service.httpStatus})`}`,
    );
  } else {
    const up = formatAge(service.uptimeSeconds);
    const runtime =
      service.runtime === null ? "unknown runtime" : service.runtime;
    lines.push(
      `service: ${service.status ?? "answered"} · pid ${service.pid ?? "—"} · up ${up} · ${runtime}`,
    );
  }
  const counts = {
    error: health.issues.filter((issue) => issue.severity === "error").length,
    warn: health.issues.filter((issue) => issue.severity === "warn").length,
  };
  lines.push(
    `verdict: ${health.verdict.toUpperCase()}${
      health.verdict === "ok"
        ? ""
        : ` (${counts.error} error, ${counts.warn} warning)`
    }`,
  );
  lines.push("");

  if (health.panels.length > 0) {
    const widths = {
      label: Math.max(5, ...health.panels.map((panel) => panel.label.length)),
      basis: Math.max(5, ...health.panels.map((panel) => panel.basis.length)),
      state: Math.max(5, ...health.panels.map((panel) => panel.state.length)),
    };
    lines.push(
      `  ${pad("PANEL", widths.label)}  ${pad("BASIS", widths.basis)}  ${pad("AGE", 6)}  ${pad("STATE", widths.state)}  SOURCE`,
    );
    for (const panel of health.panels) {
      lines.push(
        `  ${pad(panel.label, widths.label)}  ${pad(panel.basis, widths.basis)}  ${pad(formatAge(panel.ageSeconds), 6)}  ${pad(panel.state, widths.state)}  ${panel.source ?? "—"}`,
      );
    }
    lines.push("");
  }

  if (health.issues.length === 0) {
    lines.push("issues: none");
  } else {
    lines.push("issues:");
    for (const issue of health.issues) {
      lines.push(
        `  ${issue.severity.padEnd(5)} ${issue.panel}: ${issue.message}`,
      );
    }
  }

  if (health.nextCommands.length > 0) {
    lines.push("", "next commands:");
    for (const command of health.nextCommands) {
      lines.push(`  ${command}`);
    }
  }
  return lines.join("\n");
}

/** Exit code policy; kept separate so it can be asserted without spawning a process. */
export function deskDoctorExitCode(
  health: DeskHealth,
  options: { readonly check: boolean; readonly strict: boolean },
): number {
  if (!health.service.reachable) return 2;
  if (options.check)
    return checkFailed(health, { strict: options.strict }) ? 1 : 0;
  return health.verdict === "fail" ? 1 : 0;
}

async function main(): Promise<number> {
  const parsed = parseDeskDoctorArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const invocation = parsed.value;
  if (invocation.help) {
    process.stdout.write(`${DESK_DOCTOR_HELP}\n`);
    return 0;
  }

  const health = await collectDeskHealth({
    baseUrl: invocation.baseUrl,
    timeoutMs: invocation.timeoutMs,
    maxAgeSeconds: invocation.maxAgeSeconds,
  });
  if (invocation.json) {
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDeskHealthReport(health)}\n`);
  }
  return deskDoctorExitCode(health, {
    check: invocation.check,
    strict: invocation.strict,
  });
}

if (import.meta.main) {
  process.exit(await main());
}
