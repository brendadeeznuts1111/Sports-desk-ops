/**
 * The pinned runtime's CLI surface as data: which `bun` flags exist in 1.4.4, and which flags our
 * package scripts ask Bun itself to parse (before the entrypoint). A flag that only the script
 * receives (after the file) is not Bun's flag and is not checked here.
 */

/** Flags our tooling relies on; a runtime upgrade/downgrade must keep them. */
export const REQUIRED_BUN_CLI_FLAGS = [
  "--eval",
  "--print",
  "--port",
  "--env-file",
  "--no-env-file",
  "--no-orphans",
  "--parallel",
  "--sequential",
  "--no-exit-on-error",
  "--elide-lines",
  "--filter",
  "--silent",
  "--watch",
  "--watch-kill-signal",
  "--hot",
  "--no-clear-screen",
  "--check",
  "--smol",
  "--title",
  "--cron-title",
  "--cron-period",
  "--unhandled-rejections",
  "--inspect",
  "--inspect-wait",
  "--inspect-brk",
  "--cpu-prof",
  "--cpu-prof-md",
  "--cpu-prof-dir",
  "--cpu-prof-name",
  "--heap-prof",
  "--heap-prof-md",
  "--heap-prof-dir",
  "--heap-prof-name",
  "--console-depth",
  "--redirect-warnings",
] as const;

export const BUN_RUN_FLAG_CATEGORIES = [
  "control",
  "monitor",
  "workspace",
  "environment",
  "network",
  "transpiler",
] as const;

export type BunRunFlagCategory = (typeof BUN_RUN_FLAG_CATEGORIES)[number];

export interface BunRunHelpEntry {
  readonly short: string | null;
  readonly name: string;
  readonly valueHint: string | null;
  readonly description: string;
  readonly category: BunRunFlagCategory;
}

export interface BunCliSurface {
  readonly version: string;
  readonly helpText: string;
  /** Long flags declared in `bun --help`. */
  readonly flags: ReadonlySet<string>;
}

export interface BunRunCliSurface {
  readonly version: string;
  readonly usage: string;
  readonly helpText: string;
  /** Long flags declared in `bun run --help`. */
  readonly flags: ReadonlySet<string>;
  /** Structured flag declarations parsed directly from `bun run --help`. */
  readonly entries: readonly BunRunHelpEntry[];
  readonly byCategory: Readonly<
    Record<BunRunFlagCategory, readonly BunRunHelpEntry[]>
  >;
}

/**
 * One flag per declaration line, in either `-x, --long=<val>` or `--long=<val>` form. A line only
 * counts when a description column follows it: prose examples that merely start with `--` do not.
 */
export function parseBunHelpFlags(helpText: string): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const line of helpText.split("\n")) {
    const match = line.match(
      /^\s{2,}(?:-\w,\s*)?(--[a-z0-9][a-z0-9.-]*)(?:=\S+)?\s{2,}\S/i,
    );
    if (match?.[1] !== undefined) flags.add(match[1]);
  }
  return flags;
}

const CONTROL_FLAGS = new Set<string>([
  "--no-orphans",
  "--watch",
  "--watch-kill-signal",
  "--hot",
  "--no-clear-screen",
  "--smol",
  "--check",
  "--title",
  "--cron-title",
  "--cron-period",
  "--unhandled-rejections",
  "--shell",
  "--bun",
  "--expose-gc",
  "--zero-fill-buffers",
  "--interactive",
  "--eval",
  "--print",
]);

const MONITOR_FLAGS = new Set<string>([
  "--inspect",
  "--inspect-wait",
  "--inspect-brk",
  "--cpu-prof",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-md",
  "--cpu-prof-interval",
  "--heap-prof",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-md",
  "--heap-prof-interval",
  "--console-depth",
  "--no-warnings",
  "--trace-warnings",
  "--redirect-warnings",
  "--disable-warning",
  "--no-deprecation",
  "--throw-deprecation",
  "--trace-deprecation",
  "--pending-deprecation",
]);

const WORKSPACE_FLAGS = new Set<string>([
  "--silent",
  "--elide-lines",
  "--filter",
  "--workspaces",
  "--parallel",
  "--sequential",
  "--no-exit-on-error",
  "--if-present",
]);

const ENVIRONMENT_FLAGS = new Set<string>([
  "--env-file",
  "--no-env-file",
  "--cwd",
  "--config",
  "--preload",
  "--require",
  "--import",
  "--no-install",
  "--install",
  "-i",
  "--prefer-offline",
  "--prefer-latest",
]);

const NETWORK_FLAGS = new Set<string>([
  "--port",
  "--fetch-preconnect",
  "--experimental-http2-fetch",
  "--experimental-http3-fetch",
  "--max-http-header-size",
  "--insecure-http-parser",
  "--dns-result-order",
  "--use-system-ca",
  "--use-openssl-ca",
  "--use-bundled-ca",
  "--tls-min-v1.0",
  "--tls-min-v1.1",
  "--tls-min-v1.2",
  "--tls-min-v1.3",
  "--tls-max-v1.2",
  "--tls-max-v1.3",
  "--redis-preconnect",
  "--sql-preconnect",
  "--user-agent",
]);

export function classifyBunRunFlag(flagName: string): BunRunFlagCategory {
  if (CONTROL_FLAGS.has(flagName)) return "control";
  if (MONITOR_FLAGS.has(flagName)) return "monitor";
  if (WORKSPACE_FLAGS.has(flagName)) return "workspace";
  if (ENVIRONMENT_FLAGS.has(flagName)) return "environment";
  if (NETWORK_FLAGS.has(flagName)) return "network";
  return "transpiler";
}

/**
 * Parse every flag declaration row from `bun run --help` into structured data with its description
 * and operational category. Prose lines without a two-space description column are ignored.
 */
export function parseBunRunHelpEntries(
  helpText: string,
): readonly BunRunHelpEntry[] {
  const entries: BunRunHelpEntry[] = [];
  for (const line of helpText.split("\n")) {
    const longMatch = line.match(
      /^\s{2,}(?:(-\w),\s*)?(--[a-z0-9][a-z0-9.-]*)(?:=(\S+))?\s{2,}(.+)$/i,
    );
    if (longMatch?.[2] !== undefined && longMatch[4] !== undefined) {
      const name = longMatch[2];
      entries.push({
        short: longMatch[1] ?? null,
        name,
        valueHint: longMatch[3] ?? null,
        description: longMatch[4].trim(),
        category: classifyBunRunFlag(name),
      });
      continue;
    }
    const shortOnlyMatch = line.match(/^\s{2,}(-\w)\s{2,}(.+)$/);
    if (shortOnlyMatch?.[1] !== undefined && shortOnlyMatch[2] !== undefined) {
      const name = shortOnlyMatch[1];
      entries.push({
        short: name,
        name,
        valueHint: null,
        description: shortOnlyMatch[2].trim(),
        category: classifyBunRunFlag(name),
      });
    }
  }
  return entries;
}

/** Flags declared by one Bun help invocation, e.g. `readBunHelpFlags(["test", "--help"])`. */
export function readBunHelpFlags(
  args: readonly string[],
  bunPath = "bun",
): ReadonlySet<string> {
  const result = Bun.spawnSync([bunPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${bunPath} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 200)}`,
    );
  }
  return parseBunHelpFlags(result.stdout.toString());
}

/** Read the runtime's own help once; never hand-maintain the flag list. */
export function readBunCliSurface(bunPath = "bun"): BunCliSurface {
  const result = Bun.spawnSync([bunPath, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${bunPath} --help exited ${result.exitCode}: ${result.stderr.toString().slice(0, 200)}`,
    );
  }
  const helpText = result.stdout.toString();
  return { version: Bun.version, helpText, flags: parseBunHelpFlags(helpText) };
}

export function missingRequiredFlags(
  surface: BunCliSurface,
): readonly (typeof REQUIRED_BUN_CLI_FLAGS)[number][] {
  return REQUIRED_BUN_CLI_FLAGS.filter((flag) => !surface.flags.has(flag));
}

/**
 * Bun flags a package script asks the runtime to parse: the run of `--flags` right after `bun`,
 * before an entrypoint/command. `bun run script --x` passes `--x` to the script, so it is skipped.
 */
export function bunFlagsInScripts(
  scripts: Readonly<Record<string, string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const perScript = new Map<string, Set<string>>();
  for (const [name, command] of Object.entries(scripts)) {
    const flags = new Set<string>();
    for (const match of command.matchAll(
      /\bbun\s+((?:--[a-z0-9-]+(?:=\S*)?\s+)*)/gi,
    )) {
      const run = match[1] ?? "";
      for (const flag of run.matchAll(/--[a-z0-9-]+/gi)) {
        flags.add(flag[0]);
      }
    }
    if (flags.size > 0) perScript.set(name, flags);
  }
  return perScript;
}

/** Read the runtime's own `bun run --help` surface once; never hand-maintain the flag list. */
export function readBunRunCliSurface(bunPath = "bun"): BunRunCliSurface {
  const result = Bun.spawnSync([bunPath, "run", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${bunPath} run --help exited ${result.exitCode}: ${result.stderr.toString().slice(0, 200)}`,
    );
  }
  const helpText = result.stdout.toString();
  const usageLine =
    helpText
      .split("\n")
      .find((line) => line.trim().startsWith("Usage:"))
      ?.trim() ?? "Usage: bun run [flags] <file or script>";
  const entries = parseBunRunHelpEntries(helpText);
  const byCategory: Record<BunRunFlagCategory, BunRunHelpEntry[]> = {
    control: [],
    monitor: [],
    workspace: [],
    environment: [],
    network: [],
    transpiler: [],
  };
  for (const entry of entries) {
    byCategory[entry.category].push(entry);
  }
  return {
    version: Bun.version,
    usage: usageLine,
    helpText,
    flags: parseBunHelpFlags(helpText),
    entries,
    byCategory,
  };
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? i) + 1,
        (cur[j - 1] ?? j) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

export function suggestBunRunFlag(
  badFlag: string,
  surface: BunRunCliSurface,
): string | null {
  const normalized = badFlag.includes("=")
    ? badFlag.slice(0, badFlag.indexOf("="))
    : badFlag;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of surface.flags) {
    const d = editDistance(normalized, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return bestDist <= 3 ? best : null;
}

function formatEntryRow(entry: BunRunHelpEntry): string {
  const shortPart = entry.short ? `${entry.short}, ` : "    ";
  const valuePart = entry.valueHint ? `=${entry.valueHint}` : "";
  const left =
    entry.short === entry.name
      ? `  ${entry.name}`
      : `  ${shortPart}${entry.name}${valuePart}`;
  return `${left.padEnd(36)} ${entry.description}`;
}

export interface FormatConnectedBunRunHelpOptions {
  readonly full?: boolean | undefined;
  readonly category?: BunRunFlagCategory | undefined;
  readonly filter?: string | undefined;
  readonly raw?: boolean | undefined;
}

/**
 * Formats the live-connected `bun run --help` reference for `./bin/dx --help` and
 * `cli/sportsdesk_cli.ts --help`. All flag counts and descriptions are read live from the binary.
 */
export function formatConnectedBunRunHelp(
  surface: BunRunCliSurface,
  options: FormatConnectedBunRunHelpOptions = {},
): string {
  if (options.raw === true) {
    return surface.helpText.trimEnd();
  }

  const categoryCounts = BUN_RUN_FLAG_CATEGORIES.map(
    (cat) => `${cat}=${surface.byCategory[cat].length}`,
  ).join(", ");

  const filterNeedle = options.filter?.trim().toLowerCase() ?? "";
  if (
    options.full === true ||
    options.category !== undefined ||
    filterNeedle !== ""
  ) {
    const lines: string[] = [
      `Connected Bun Runtime CLI (${surface.usage} · Bun ${surface.version} · ${surface.entries.length} flags measured from \`bun run --help\`)`,
      `  Categories: ${categoryCounts}`,
      "",
    ];
    const cats =
      options.category !== undefined
        ? [options.category]
        : BUN_RUN_FLAG_CATEGORIES;
    let matchedCount = 0;
    for (const cat of cats) {
      const rows = surface.byCategory[cat].filter((entry) => {
        if (filterNeedle === "") return true;
        return (
          entry.name.toLowerCase().includes(filterNeedle) ||
          entry.description.toLowerCase().includes(filterNeedle) ||
          (entry.short?.toLowerCase().includes(filterNeedle) ?? false)
        );
      });
      if (rows.length === 0) continue;
      matchedCount += rows.length;
      lines.push(`  [${cat.toUpperCase()} — ${rows.length}]`);
      for (const row of rows) {
        lines.push(`  ${formatEntryRow(row)}`);
      }
      lines.push("");
    }
    if (matchedCount === 0) {
      lines.push(`  (no \`bun run --help\` flags matched "${options.filter}")`);
    }
    lines.push(
      '  Pass any flag above via `./bin/dx run [bun-flags] <script|file> [args...]` or `DX_BUN_FLAGS="..." ./bin/dx <cmd>`.',
    );
    return lines.join("\n").trimEnd();
  }

  const pick = (names: readonly string[]): readonly BunRunHelpEntry[] =>
    names
      .map((n) => surface.entries.find((e) => e.name === n))
      .filter((e): e is BunRunHelpEntry => e !== undefined);

  const keyControl = pick([
    "--no-orphans",
    "--watch",
    "--watch-kill-signal",
    "--hot",
    "--smol",
    "--check",
    "--title",
    "--unhandled-rejections",
  ]);
  const keyMonitor = pick([
    "--cpu-prof-md",
    "--heap-prof-md",
    "--inspect-wait",
    "--inspect-brk",
    "--console-depth",
    "--redirect-warnings",
  ]);
  const keyOrchestrate = pick([
    "--parallel",
    "--sequential",
    "--no-exit-on-error",
    "--filter",
    "--elide-lines",
    "--no-env-file",
  ]);

  const lines: string[] = [
    `  Bun Runtime Control & Monitoring (live \`bun run --help\` · Bun ${surface.version} · ${surface.entries.length} flags: ${categoryCounts})`,
    "    ./bin/dx run [presets|bun-flags] <script|file> [args...]   Controlled runner (--containment, --profile-cpu, --profile-heap, --low-mem, --isolated-env, --watch-safe, --debug)",
    "    ./bin/dx monitor [--watch] [--interval=N] [--offline] [--prune] [--json]   Monitor active Bun processes, daemon /health + /api/v2/live-bets, and scratch/profiles/",
    "    ./bin/dx live-bets [--source=db|file|fixture|none] [--fallback=strict|sample] [--path=P] [--daemon] [--watch] [--json]   Control & monitor v2 live-bets resolution",
    "    ./bin/dx help --bun [--category=control|monitor|workspace|environment|network|transpiler] [--filter=TEXT] [--raw]   Expand full live `bun run --help` catalog",
    "",
    "    Process Control (`bun run` flags, forwardable via `./bin/dx run` or `DX_BUN_FLAGS`):",
    ...keyControl.map((e) => `    ${formatEntryRow(e)}`),
    "",
    "    Profiling, Debugging & Telemetry (`bun run` flags):",
    ...keyMonitor.map((e) => `    ${formatEntryRow(e)}`),
    "",
    "    Orchestration & Isolation (`bun run` flags):",
    ...keyOrchestrate.map((e) => `    ${formatEntryRow(e)}`),
  ];
  return lines.join("\n");
}

/** Script flags the pinned runtime does not declare (a broken script would fail at startup). */
export function unsupportedScriptFlags(
  scripts: Readonly<Record<string, string>>,
  surface: BunCliSurface,
): readonly string[] {
  const unsupported = new Set<string>();
  for (const flags of bunFlagsInScripts(scripts).values()) {
    for (const flag of flags) {
      if (!surface.flags.has(flag)) unsupported.add(flag);
    }
  }
  return [...unsupported].sort();
}
