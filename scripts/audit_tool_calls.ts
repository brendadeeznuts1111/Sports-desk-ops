#!/usr/bin/env bun
/**
 * @file scripts/audit_tool_calls.ts
 * @description Reproduce the "which tool calls fail, and why" audit from DSH session traces.
 *
 * DSH persists each session as a zstd-compressed JSONL event log. This script reads those logs
 * read-only, joins `tool/call` with `tool/result`, and reports error rates per tool, normalized
 * error codes/messages, bash non-zero exits, sandbox denials and duplicate calls. It never writes,
 * never contacts the network, and never reads file contents the model saw — only the event log.
 *
 *   bun run audit:tool-calls                 # this project, last 48h
 *   bun run audit:tool-calls --since-hours 24 --json
 *   bun run audit:tool-calls --project /Users/me/code/other-repo --max-files 10
 *
 * The default project root is the main checkout (git common dir), because linked worktrees share
 * the session bucket with it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Call {
  readonly name: string;
  readonly args: string;
  readonly time: number;
  readonly step: number;
}

interface ResultRow {
  readonly session: string;
  readonly name: string;
  readonly args: string;
  readonly isError: boolean;
  readonly code: string | null;
  readonly text: string;
  readonly start: number;
  readonly time: number;
}

export interface AuditReport {
  readonly sessions: number;
  readonly results: number;
  readonly errors: number;
  readonly tools: readonly {
    name: string;
    calls: number;
    errors: number;
  }[];
  readonly codes: readonly { code: string; count: number }[];
  readonly messages: readonly { message: string; count: number }[];
  readonly bash: {
    calls: number;
    nonZero: number;
    top: readonly { key: string; count: number }[];
  };
  readonly sandboxLines: number;
  readonly duplicates: { groups: number; wasted: number };
  readonly slowest: readonly { name: string; ms: number; label: string }[];
}

function parseArgs(argv: readonly string[]): {
  project: string;
  sinceHours: number;
  maxFiles: number;
  json: boolean;
} {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const num = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    project: value("--project") ?? mainCheckoutRoot() ?? process.cwd(),
    sinceHours: num("--since-hours", 48),
    maxFiles: num("--max-files", 200),
    json: argv.includes("--json"),
  };
}

function mainCheckoutRoot(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const dir = path.resolve(result.stdout.toString().trim());
    if (path.basename(dir) !== ".git") return null;
    return path.dirname(dir);
  } catch {
    return null;
  }
}

/** DSH names a project bucket `--<absolute path with / replaced by ->--`. */
export function sessionRootFor(project: string): string {
  const absolute = path.resolve(project);
  const encoded = absolute.replace(/^\/+/, "").split(path.sep).join("-");
  const bucket = `--${encoded}--`;
  return path.join(os.homedir(), ".dsh", "sessions", bucket);
}

function readJsonLines(text: string): unknown[] {
  // Intentional hand-rolled JSONL loop; DSH session files can have bad MIDDLE lines (crashed
  // mid-write), not just a partial final line, so `Bun.JSONL.parseChunk` would drop everything
  // after the first bad row. See `docs/bun-upstream-reference.md` "When NOT to migrate to Bun.JSONL".
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partially written final line is normal while a session is live.
    }
  }
  return events;
}

async function decompress(file: string): Promise<string | null> {
  try {
    const stream = Bun.file(file)
      .stream()
      .pipeThrough(new DecompressionStream("zstd"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const row = record(part);
      return typeof row?.text === "string" ? row.text : "";
    })
    .join("\n");
}

export function normalize(text: string): string {
  return text
    .replace(/\/Users\/[^\s"']+/g, "<path>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 140);
}

/** Parse one session's decompressed JSONL into joined tool calls/results. */
export function parseSession(session: string, text: string): ResultRow[] {
  const calls = new Map<string, Call>();
  const rows: ResultRow[] = [];
  for (const event of readJsonLines(text)) {
    const row = record(event);
    if (row === null) continue;
    const data = record(row.data);
    if (row.type === "tool/call" && data !== null) {
      const callId = typeof data.callId === "string" ? data.callId : null;
      if (callId === null) continue;
      calls.set(callId, {
        name: typeof data.name === "string" ? data.name : "?",
        args: typeof data.arguments === "string" ? data.arguments : "{}",
        time: typeof row.time === "number" ? row.time : 0,
        step: typeof data.step === "number" ? data.step : 0,
      });
      continue;
    }
    if (row.type !== "tool/result" || data === null) continue;
    const message = record(data.message);
    if (message === null) continue;
    const source = record(message.source);
    const callId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof source?.callId === "string"
          ? source.callId
          : null;
    if (callId === null) continue;
    const call = calls.get(callId);
    const error = record(data.error);
    rows.push({
      session,
      name: call?.name ?? "?",
      args: call?.args ?? "{}",
      isError: message.isError === true,
      code:
        error === null
          ? null
          : `${String(error.name ?? "?")}/${String(error.code ?? "?")}`,
      text: messageText(message),
      start: call?.time ?? (typeof row.time === "number" ? row.time : 0),
      time: typeof row.time === "number" ? row.time : 0,
    });
  }
  return rows;
}

function parseArgsAsRecord(args: string): Record<string, unknown> {
  try {
    return record(JSON.parse(args)) ?? {};
  } catch {
    return {};
  }
}

/** Aggregate rows into the report the runbook quotes. */
export function summarize(rows: readonly ResultRow[]): AuditReport {
  const sessions = new Set(rows.map((row) => row.session)).size;
  const errors = rows.filter((row) => row.isError);
  const byTool = new Map<string, { calls: number; errors: number }>();
  for (const row of rows) {
    const bucket = byTool.get(row.name) ?? { calls: 0, errors: 0 };
    bucket.calls += 1;
    if (row.isError) bucket.errors += 1;
    byTool.set(row.name, bucket);
  }
  const codeCounts = new Map<string, number>();
  for (const row of errors) {
    const code = row.code ?? "no-code";
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }
  const messageCounts = new Map<string, number>();
  for (const row of errors) {
    const message = normalize(row.text.split("\n")[0] ?? "");
    messageCounts.set(message, (messageCounts.get(message) ?? 0) + 1);
  }
  const bashRows = rows.filter((row) => row.name === "bash");
  const bashExits = bashRows.map((row) =>
    Number(row.text.match(/\[exit code: (\d+)\]/)?.[1] ?? 0),
  );
  const nonZero = bashExits.filter((code) => code !== 0).length;
  const bashTop = new Map<string, number>();
  for (const row of bashRows) {
    const exit = Number(row.text.match(/\[exit code: (\d+)\]/)?.[1] ?? 0);
    if (exit === 0) continue;
    const args = parseArgsAsRecord(row.args);
    const key = `exit ${exit} :: ${normalize(String(args.description ?? args.command ?? ""))}`;
    bashTop.set(key, (bashTop.get(key) ?? 0) + 1);
  }
  let sandboxLines = 0;
  for (const row of rows) {
    for (const line of row.text.split("\n")) {
      if (/Operation not permitted|\[sandbox:/.test(line)) sandboxLines += 1;
    }
  }
  // Duplicates are per session: the same command in two sessions is two legitimate calls,
  // while a repeated call inside one session is a retry/poll that may be waste.
  const duplicates = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.session}|${row.name}|${row.args}`;
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  }
  const duplicateCounts = [...duplicates.values()].filter((count) => count > 1);
  const slowest = [...rows]
    .sort((a, b) => b.time - b.start - (a.time - a.start))
    .slice(0, 8)
    .map((row) => {
      const args = parseArgsAsRecord(row.args);
      return {
        name: row.name,
        ms: row.time - row.start,
        label: normalize(
          String(args.description ?? args.command ?? args.url ?? ""),
        ),
      };
    });
  const bySort = <T extends { count: number }>(map: Map<string, T>): T[] =>
    [...map.values()].sort((a, b) => b.count - a.count);
  return {
    sessions,
    results: rows.length,
    errors: errors.length,
    tools: [...byTool.entries()]
      .map(([name, bucket]) => ({ name, ...bucket }))
      .sort((a, b) => b.calls - a.calls),
    codes: bySort(
      new Map(
        [...codeCounts.entries()].map(([code, count]) => [
          code,
          { code, count },
        ]),
      ),
    ),
    messages: bySort(
      new Map(
        [...messageCounts.entries()].map(([message, count]) => [
          message,
          { message, count },
        ]),
      ),
    ),
    bash: {
      calls: bashRows.length,
      nonZero,
      top: bySort(
        new Map(
          [...bashTop.entries()].map(([key, count]) => [key, { key, count }]),
        ),
      ).slice(0, 10),
    },
    sandboxLines,
    duplicates: {
      groups: duplicateCounts.length,
      wasted: duplicateCounts.reduce((sum, count) => sum + count - 1, 0),
    },
    slowest,
  };
}

export function renderReport(report: AuditReport): string {
  const rate = (errors: number, calls: number): string =>
    calls === 0 ? "0.0" : ((100 * errors) / calls).toFixed(1);
  const lines = [
    `tool-call audit · ${report.sessions} sessions · ${report.results} tool results · ${report.errors} errors (${rate(report.errors, report.results)}%)`,
    "",
    "== by tool ==",
    ...report.tools
      .filter((tool) => tool.calls >= 3)
      .map(
        (tool) =>
          `${tool.name.padEnd(28)} n=${String(tool.calls).padStart(4)} err=${String(tool.errors).padStart(3)} ${rate(tool.errors, tool.calls).padStart(5)}%`,
      ),
    "",
    "== error codes ==",
    ...report.codes.map(
      (code) => `${String(code.count).padStart(4)} ${code.code}`,
    ),
    "",
    "== normalized error messages ==",
    ...report.messages
      .slice(0, 10)
      .map(
        (message) => `${String(message.count).padStart(4)} ${message.message}`,
      ),
    "",
    `== bash: ${report.bash.calls} calls · ${report.bash.nonZero} non-zero (${rate(report.bash.nonZero, report.bash.calls)}%) ==`,
    ...report.bash.top.map(
      (entry) => `${String(entry.count).padStart(4)} ${entry.key}`,
    ),
    "",
    `sandbox/permission lines: ${report.sandboxLines}`,
    `duplicate call groups: ${report.duplicates.groups} · wasted calls: ${report.duplicates.wasted}`,
    "",
    "== slowest ==",
    ...report.slowest.map(
      (row) =>
        `${String(row.ms).padStart(8)}ms ${row.name.padEnd(24)} ${row.label}`,
    ),
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  const root = sessionRootFor(options.project);
  let files: { file: string; mtimeMs: number }[] = [];
  try {
    files = fs
      .readdirSync(root)
      .map((entry) => {
        const file = path.join(root, entry, "session.v4.jsonl.zstd");
        try {
          return { file, mtimeMs: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is { file: string; mtimeMs: number } => entry !== null,
      );
  } catch {
    console.error(`audit:tool-calls: no session bucket at ${root}`);
    return 2;
  }
  const cutoff = Date.now() - options.sinceHours * 3_600_000;
  const selected = files
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(-options.maxFiles);
  const rows: ResultRow[] = [];
  for (const entry of selected) {
    const text = await decompress(entry.file);
    if (text === null) continue;
    rows.push(...parseSession(path.basename(path.dirname(entry.file)), text));
  }
  if (rows.length === 0) {
    console.error(
      `audit:tool-calls: 0 tool results in ${selected.length} sessions under ${root}`,
    );
    return 2;
  }
  const report = summarize(rows);
  console.log(
    options.json ? JSON.stringify(report, null, 2) : renderReport(report),
  );
  console.log(`\nsource: ${root} · ${selected.length} session files`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
