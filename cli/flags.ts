#!/usr/bin/env bun
/**
 * Deterministic anomaly signatures over a getBetTicker capture.
 *
 *   bun run cli/flags.ts --file=captures/today.json
 *   bun run cli/flags.ts --file=captures/today.json --verbose
 *   bun run cli/flags.ts --rules
 *   bun run cli/flags.ts --file=captures/today.json --strict
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadCapture, type HtmlBetTicket } from "./html.ts";
import {
  DETERMINISTIC_RULES,
  normalizeEventName,
  toRuleTicket,
  type Anomaly,
  type RuleName,
  type RuleTicket,
} from "./rules.ts";
import {
  normalizeTicket,
  toSafeJson,
  type NormalizedTicket,
} from "../lib/live_ticket_view.ts";
import { readWagerListArtifact } from "../lib/live_wagers.ts";

const DEFAULT_FILE = "data/live-wagers.json";

const HELP = `flags — deterministic anomaly signatures over a ticket capture

Usage: bun run flags --file=<capture> [--verbose] [--json] [--strict]
       bun run flags --dir=<dir> [--week]
       bun run flags --rules

  --file <path>            JSON/JSONL/HTML capture (default: ${DEFAULT_FILE})
  --dir <path>             Every .json/.jsonl/.html capture in a directory
  --week                   With --dir: last 7 days (unless --since is set)
  --rule <name>            Run one rule
  --rules                  Print the rule catalog
  --verbose                Evidence per hit; show zero-hit rules and skipped rules
  --top <n>                Hits per rule in --verbose (default: 10)
  --since <24h|30m|7d>     Only wagers inserted after the cutoff
  --event-schedule <csv>   Enable past_post with event,start rows
  --strict                 Exit 1 when any flag fires
  --json                   Machine-readable safe view
  --quiet                  Suppress text output; preserve the exit code
  -h, --help               This text

Rules are deterministic signatures, not statistical scores. Customer and agent identities
stay in a private WeakMap; output uses hashed references and safe ticket fields only.`;

function usage(message: string): never {
  console.error(`flags: ${message}`);
  console.error(HELP);
  process.exit(2);
}

function fail(message: string): never {
  console.error(`flags: ${message}`);
  process.exit(1);
}

interface Options {
  file?: string;
  dir?: string;
  week: boolean;
  rule?: RuleName;
  rules: boolean;
  verbose: boolean;
  top: number;
  since?: string;
  schedule?: string;
  strict: boolean;
  json: boolean;
  quiet: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (
      [
        "--file",
        "--dir",
        "--rule",
        "--top",
        "--since",
        "--event-schedule",
      ].includes(arg)
    ) {
      const value = argv[index + 1];
      if (value === undefined) usage(`${arg} requires a value`);
      normalized.push(`${arg}=${value}`);
      index++;
    } else {
      normalized.push(arg);
    }
  }

  const options: Options = {
    week: false,
    rules: false,
    verbose: false,
    top: 10,
    strict: false,
    json: false,
    quiet: false,
  };
  for (const arg of normalized) {
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
    } else if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
    } else if (arg === "--week") {
      options.week = true;
    } else if (arg.startsWith("--rule=")) {
      const value = arg.slice("--rule=".length) as RuleName;
      if (!(value in DETERMINISTIC_RULES)) {
        usage(`unknown rule ${JSON.stringify(value)}; see --rules`);
      }
      options.rule = value;
    } else if (arg === "--rules") {
      options.rules = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--top=")) {
      const value = Number(arg.slice("--top=".length));
      if (!Number.isInteger(value) || value < 1) {
        usage("--top must be a positive integer");
      }
      options.top = value;
    } else if (arg.startsWith("--since=")) {
      options.since = arg.slice("--since=".length);
    } else if (arg.startsWith("--event-schedule=")) {
      options.schedule = arg.slice("--event-schedule=".length);
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

function parseSince(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/i.exec(value.trim());
  if (match === null) usage(`--since must look like 24h, 30m or 7d`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "h").toLowerCase();
  const factor =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return amount * factor;
}

function fromNormalized(ticket: NormalizedTicket): RuleTicket {
  return toRuleTicket(ticket);
}

function fromHtml(ticket: HtmlBetTicket): RuleTicket {
  return toRuleTicket(
    {
      wagerNumber: ticket.wagerNumber,
      insertedAt: null,
      stake: null,
      toWin: null,
      ticketWriter: ticket.source,
      legs: ticket.legs,
    },
    ticket,
  );
}

async function loadFile(path: string): Promise<RuleTicket[]> {
  const handle = Bun.file(path);
  if (!(await handle.exists())) {
    fail(`${path} not found; pass --file=<capture>`);
  }
  if (path.endsWith(".jsonl")) {
    const text = await handle.text();
    const tickets: RuleTicket[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch (error) {
        fail(
          `${path}: invalid JSONL line: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const artifact = readWagerListArtifact(payload);
      for (const wager of artifact.wagers) {
        tickets.push(fromNormalized(normalizeTicket(wager, { file: path })));
      }
    }
    return tickets;
  }

  const loaded = await loadCapture(path);
  return loaded.tickets.map((ticket) =>
    "insertedAt" in ticket ? fromNormalized(ticket) : fromHtml(ticket),
  );
}

async function loadDir(path: string): Promise<RuleTicket[]> {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    fail(`${path} is not a readable directory; pass --dir=<dir>`);
  }
  const tickets: RuleTicket[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(json|jsonl|html)$/i.test(entry.name)) continue;
    tickets.push(...(await loadFile(join(path, entry.name))));
  }
  return tickets;
}

function loadSchedule(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const schedule = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^event\s*,/i.test(trimmed)) continue;
    const comma = trimmed.lastIndexOf(",");
    if (comma <= 0) continue;
    const event = trimmed.slice(0, comma).trim();
    const start = trimmed.slice(comma + 1).trim();
    if (event !== "" && start !== "") {
      schedule.set(normalizeEventName(event), start);
    }
  }
  return schedule;
}

function ruleCatalog(): string {
  return [
    "Deterministic rules (default)",
    "  period_correlation              same customer · same event · 3+ periods · 60 min",
    "  opposite_sides_same_customer    same customer · opposite sides · 60 min",
    "  opposite_sides_across_customers different customers · opposite sides · 5 min",
    "  batch_replay                    2+ wagers · ≤100ms · same agent",
    "  clone_bet                       2+ identical tickets · 60 min",
    "  velocity_customer               10/5min · 30/30min · 100/60min",
    "  velocity_market                 5/30s · 20/5min · 100/30min",
    "  period_order_anomaly            later-then-earlier periods · >10 min gap",
    "  past_post                       *requires --event-schedule*",
    "",
    "Statistical rules are not part of this deterministic build.",
  ].join("\n");
}

function evidenceLine(anomaly: Anomaly): string {
  const evidence = anomaly.evidence;
  switch (anomaly.rule) {
    case "period_correlation":
      return `${evidence.periodCount} periods · ${evidence.event} · ${evidence.windowMinutes} min`;
    case "batch_replay":
      return `${evidence.count} wagers · ${evidence.spanMs}ms · ${evidence.agentRef}`;
    case "clone_bet":
      return `${evidence.cloneCount} clones · ${(evidence.writer as readonly string[]).join("/")}`;
    case "velocity_customer":
      return `${evidence.count} wagers · ${evidence.windowMinutes} min · ${evidence.customerRef}`;
    case "velocity_market":
      return `${evidence.count} wagers · ${evidence.windowSeconds}s · ${evidence.market} · ${evidence.distinctCustomers} customers`;
    case "opposite_sides_same_customer":
      return `${(evidence.sides as readonly string[]).join("/")} · ${evidence.event} · ${evidence.market}`;
    case "opposite_sides_across_customers":
      return `${(evidence.sides as readonly string[]).join("/")} · ${evidence.event} · ${evidence.distinctCustomers} customers`;
    case "period_order_anomaly":
      return `${evidence.period} after ${evidence.priorPeriod} (+${evidence.gapMinutes} min) · ${evidence.event}`;
    case "past_post":
      return `${evidence.wagerNumber} after ${evidence.scheduledStart} · ${evidence.event}`;
  }
}

function render(
  anomalies: readonly Anomaly[],
  total: number,
  options: Options,
  selected: ReadonlyArray<RuleName>,
  skippedPastPost: boolean,
): string {
  if (options.json) {
    return JSON.stringify(
      {
        wagerCount: total,
        generatedAt: new Date().toISOString(),
        items: anomalies.map((anomaly) => ({
          rule: anomaly.rule,
          severity: anomaly.severity,
          evidence: anomaly.evidence,
          wagerNumbers: anomaly.tickets.map((ticket) => ticket.wagerNumber),
          tickets: anomaly.tickets.map((ticket) =>
            toSafeJson(ticket as unknown as Record<string, unknown>),
          ),
        })),
      },
      null,
      2,
    );
  }

  if (anomalies.length === 0 && !options.verbose) return "";

  const byRule = new Map<RuleName, Anomaly[]>();
  for (const anomaly of anomalies) {
    const list = byRule.get(anomaly.rule) ?? [];
    list.push(anomaly);
    byRule.set(anomaly.rule, list);
  }

  const lines = [
    `${anomalies.length} flag${anomalies.length === 1 ? "" : "s"} from ${total.toLocaleString("en-US")} wagers`,
  ];
  for (const rule of selected) {
    const hits = byRule.get(rule) ?? [];
    if (hits.length === 0) {
      if (options.verbose) {
        lines.push(
          rule === "past_post" && skippedPastPost
            ? `⊘ past_post skipped (requires --event-schedule)`
            : `✓ ${rule} 0 hits`,
        );
      }
      continue;
    }
    if (!options.verbose) {
      lines.push(`  ⚠ ${rule}  ${hits.length} hits`);
      continue;
    }
    lines.push("", `⚠ ${rule} (${hits.length} hits)`);
    for (const hit of hits.slice(0, options.top)) {
      lines.push(`   ${evidenceLine(hit)}`);
      lines.push(
        `   Wagers: ${hit.tickets.map((ticket) => ticket.wagerNumber).join(", ")}`,
      );
    }
    if (hits.length > options.top) {
      lines.push(
        `   … +${hits.length - options.top} more (--top=N to show all)`,
      );
    }
  }
  if (!options.verbose && anomalies.length > 0) {
    lines.push("", "run with --verbose for evidence, --rules for the catalog");
  }
  return lines.join("\n");
}

const options = parseOptions(Bun.argv.slice(2));

if (options.rules) {
  console.log(ruleCatalog());
  process.exit(0);
}

const files: string[] = [];
if (options.file !== undefined) files.push(options.file);
if (options.dir !== undefined) files.push(options.dir);
if (
  files.length === 0 &&
  options.file === undefined &&
  options.dir === undefined
) {
  files.push(DEFAULT_FILE);
}

const tickets: RuleTicket[] = [];
for (const entry of files) {
  const path = resolve(process.cwd(), entry);
  if (options.dir !== undefined && entry === options.dir) {
    tickets.push(...(await loadDir(path)));
  } else {
    tickets.push(...(await loadFile(path)));
  }
}

let sinceMs: number | null = null;
if (options.since !== undefined) {
  sinceMs = Date.now() - parseSince(options.since);
} else if (options.week) {
  sinceMs = Date.now() - 7 * 86_400_000;
}
const filtered =
  sinceMs === null
    ? tickets
    : tickets.filter((ticket) => {
        if (ticket.insertedAt === null) return false;
        const at = Date.parse(ticket.insertedAt);
        return Number.isFinite(at) && at >= sinceMs;
      });

const schedule =
  options.schedule === undefined ? undefined : loadSchedule(options.schedule);
const selected = (
  options.rule === undefined
    ? (Object.keys(DETERMINISTIC_RULES) as RuleName[])
    : [options.rule]
) as readonly RuleName[];

const anomalies: Anomaly[] = [];
for (const rule of selected) {
  const fn = DETERMINISTIC_RULES[rule];
  try {
    anomalies.push(...fn(filtered, { schedule }));
  } catch (error) {
    if (options.verbose) {
      console.error(
        `rule ${rule} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

const output = render(
  anomalies,
  filtered.length,
  options,
  selected,
  schedule === undefined,
);
if (!options.quiet && output !== "") console.log(output);
process.exit(options.strict && anomalies.length > 0 ? 1 : 0);
