/**
 * The dashboard CLI has three layers, and they are resolved in this order:
 *
 *   1. command — the verb: `ansi`, `html`, `markdown`, `watch`. A positional, not a flag.
 *   2. flags   — modifiers: `--rows`, `--columns`, `--out`, `--interval`, colour.
 *   3. runtime — whatever the process finds: TTY or pipe, terminal width, `NO_COLOR`,
 *                `SPORTSDESK_ADMIN_TOKEN`, and the clock.
 *
 * Keeping them apart means a flag cannot change what the command is, and a command cannot lie
 * about what the terminal can do. `--format` and `--watch <s>` remain accepted as aliases for the
 * old surface, but they resolve into the same command layer.
 */
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  type ParsedArgs,
} from "./cli_args.ts";

export type DashboardCommand = "ansi" | "html" | "markdown" | "watch";

export interface DashboardCommandSpec {
  /** One line for the command index. */
  readonly summary: string;
  /** Where the output goes, which drives the flag compatibility rules. */
  readonly output: "stdout" | "file" | "loop";
  readonly examples: readonly string[];
}

export const DASHBOARD_COMMANDS: Readonly<
  Record<DashboardCommand, DashboardCommandSpec>
> = {
  ansi: {
    summary: "Render the dashboard to this terminal (Bun.markdown.ansi)",
    output: "stdout",
    examples: [
      "bun run dashboard:view",
      "bun run dashboard:view ansi --rows 50",
      "bun run dashboard:view ansi --no-color --columns 0",
    ],
  },
  html: {
    summary: "Render a standalone HTML page (Bun.markdown.html)",
    output: "file",
    examples: [
      "bun run dashboard:view html --out dist/dashboard-view.html",
      "bun run dashboard:view html --out scratch/dashboard.html --rows 100",
    ],
  },
  markdown: {
    summary: "Render the shared GFM document for pipes and diffs",
    output: "file",
    examples: [
      "bun run dashboard:view markdown | less",
      "bun run dashboard:view markdown --out scratch/dashboard.md",
    ],
  },
  watch: {
    summary: "Re-render the terminal view on an interval",
    output: "loop",
    examples: [
      "bun run dashboard:watch",
      "bun run dashboard:view watch --interval 5",
      "bun run dashboard:view watch --interval 30 --no-color",
    ],
  },
};

export const DEFAULT_COMMAND: DashboardCommand = "ansi";

const VALUE_FLAGS = [
  "--format",
  "--url",
  "--rows",
  "--columns",
  "--out",
  "--interval",
  "--watch",
] as const;
const VALUE_FLAG_SET: ReadonlySet<string> = new Set(VALUE_FLAGS);
const SWITCH_FLAGS: ReadonlySet<string> = new Set([
  "--color",
  "--no-color",
  "--light",
  "--help",
  "-h",
]);

export interface DashboardFlags {
  readonly url: string;
  readonly rows: number;
  /** `null` means "ask the runtime"; `0` disables wrapping. */
  readonly columns: number | null;
  readonly out: string;
  readonly intervalSeconds: number;
  /** `null` means "ask the runtime" (TTY and `NO_COLOR`). */
  readonly color: boolean | null;
  readonly light: boolean;
  readonly help: boolean;
}

/** How the command was chosen; `default` means the caller asked for no command at all. */
export type DashboardCommandSource = "positional" | "legacy" | "default";

export interface DashboardInvocation {
  readonly command: DashboardCommand;
  readonly source: DashboardCommandSource;
  readonly flags: DashboardFlags;
}

export type CliResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

/** Accepts a command name in any case; unknown names get the full list. */
export function isDashboardCommand(value: string): value is DashboardCommand {
  return Object.hasOwn(DASHBOARD_COMMANDS, value);
}

export function parseDashboardInvocation(
  argv: readonly string[],
): CliResult<DashboardInvocation> {
  const args = parseCliArgs(argv, { valueFlags: VALUE_FLAGS });
  const command = resolveCommand(args);
  if (!command.ok) return command;
  const flags = decodeFlags(args);
  if (!flags.ok) return flags;
  const compatibility = checkCommandFlags(
    command.value.command,
    args,
    flags.value,
  );
  if (!compatibility.ok) return compatibility;
  return {
    ok: true,
    value: {
      command: command.value.command,
      source: command.value.source,
      flags: flags.value,
    },
  };
}

/** Layer 1: the verb. Positional wins; the old `--format` / `--watch` forms are aliases. */
function resolveCommand(args: ParsedArgs): CliResult<{
  readonly command: DashboardCommand;
  readonly source: DashboardCommandSource;
}> {
  const positional = args.positionals[0];
  const legacyFormat = args.values.get("--format")?.at(-1);
  const legacyWatch = args.values.get("--watch")?.at(-1);

  if (args.positionals.length > 1) {
    return fail(
      `expected one command, got ${args.positionals.length}: ${args.positionals.join(" ")}.\n` +
        `  bun run dashboard:view --help`,
    );
  }

  if (positional !== undefined) {
    if (!isDashboardCommand(positional)) {
      return fail(
        `unknown command "${positional}". Commands: ${Object.keys(DASHBOARD_COMMANDS).join(", ")}.\n` +
          `  bun run dashboard:view ${DEFAULT_COMMAND} --help`,
      );
    }
    if (legacyFormat !== undefined) {
      return fail(
        `command "${positional}" conflicts with --format ${legacyFormat}. ` +
          `Use the positional command alone:\n  bun run dashboard:view ${positional}`,
      );
    }
    if (legacyWatch !== undefined) {
      return fail(
        `command "${positional}" conflicts with the legacy --watch flag. ` +
          `Use:\n  bun run dashboard:view watch --interval ${legacyWatch}`,
      );
    }
    return {
      ok: true,
      value: { command: positional, source: "positional" },
    };
  }

  if (legacyWatch !== undefined) {
    if (legacyFormat !== undefined) {
      return fail(
        "--watch and --format cannot be combined. Use the command form:\n" +
          "  bun run dashboard:view watch --interval 10",
      );
    }
    return { ok: true, value: { command: "watch", source: "legacy" } };
  }
  if (legacyFormat !== undefined) {
    if (!isDashboardCommand(legacyFormat)) {
      return fail(
        `unknown --format "${legacyFormat}". Commands: ${Object.keys(DASHBOARD_COMMANDS).join(", ")}.\n` +
          `  bun run dashboard:view ${DEFAULT_COMMAND}`,
      );
    }
    return { ok: true, value: { command: legacyFormat, source: "legacy" } };
  }
  return {
    ok: true,
    value: { command: DEFAULT_COMMAND, source: "default" },
  };
}

/** Layer 2: the modifiers. Every numeric flag is range-checked here, not at render time. */
function decodeFlags(args: ParsedArgs): CliResult<DashboardFlags> {
  const unknown = findUnknownFlag(args);
  if (unknown !== null) return fail(unknown);

  const rawUrl = flagValue(args, "--url", "http://127.0.0.1:4020").trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(
      `--url "${rawUrl}" is not a URL.\n  bun run dashboard:view --url http://127.0.0.1:4020`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(
      `--url must be http or https, got "${url.protocol}".\n` +
        "  bun run dashboard:view --url http://127.0.0.1:4020",
    );
  }

  const rows = integerFlag(args, "--rows", { fallback: 25, min: 1, max: 200 });
  if (!rows.ok) return rows;
  const columns = optionalIntegerFlag(args, "--columns", {
    min: 0,
    max: 1_000,
    hint: 100,
  });
  if (!columns.ok) return columns;
  const interval = integerFlag(args, "--interval", {
    fallback: 10,
    min: 1,
    max: 3_600,
  });
  if (!interval.ok) return interval;
  if (args.values.has("--watch") && legacyWatchSeconds(args) === null) {
    return fail(
      `--watch expects seconds 1..3600, got "${args.values.get("--watch")?.at(-1)}". ` +
        `For a single render use the ansi command:\n  bun run dashboard:view ansi`,
    );
  }

  const colorSwitch = hasFlag(args, "--color");
  const noColor = hasFlag(args, "--no-color");
  if (colorSwitch && noColor) {
    return fail(
      "--color and --no-color are mutually exclusive.\n" +
        "  bun run dashboard:view --no-color",
    );
  }

  return {
    ok: true,
    value: {
      url: url.origin + url.pathname.replace(/\/+$/, ""),
      rows: rows.value,
      columns: columns.value,
      out: flagValue(args, "--out", "").trim(),
      intervalSeconds: legacyWatchSeconds(args) ?? interval.value,
      color: colorSwitch ? true : noColor ? false : null,
      light: hasFlag(args, "--light"),
      help: hasFlag(args, "--help", "-h"),
    },
  };
}

/** Typos fail here instead of being silently ignored. */
function findUnknownFlag(args: ParsedArgs): string | null {
  for (const name of args.switches) {
    if (VALUE_FLAG_SET.has(name)) {
      return `${name} expects a value.\n  bun run dashboard:view ${DEFAULT_COMMAND} ${name} 100`;
    }
    if (!SWITCH_FLAGS.has(name)) {
      return `unknown flag "${name}".\n  bun run dashboard:view --help`;
    }
  }
  for (const name of args.values.keys()) {
    if (!VALUE_FLAG_SET.has(name)) {
      return `unknown flag "${name}".\n  bun run dashboard:view --help`;
    }
  }
  return null;
}

/** `--watch <s>` is the legacy interval; it keeps the same bounds as `--interval`. */
function legacyWatchSeconds(args: ParsedArgs): number | null {
  const raw = args.values.get("--watch")?.at(-1);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3_600) {
    return null;
  }
  return value;
}

function integerFlag(
  args: ParsedArgs,
  name: string,
  options: {
    readonly fallback: number;
    readonly min: number;
    readonly max: number;
  },
): CliResult<number> {
  const raw = args.values.get(name)?.at(-1);
  if (raw === undefined) return { ok: true, value: options.fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    return fail(
      `${name} expects an integer ${options.min}..${options.max}, got "${raw}".\n` +
        `  bun run dashboard:view ${DEFAULT_COMMAND} ${name} ${options.fallback}`,
    );
  }
  return { ok: true, value };
}

function optionalIntegerFlag(
  args: ParsedArgs,
  name: string,
  options: {
    readonly min: number;
    readonly max: number;
    readonly hint: number;
  },
): CliResult<number | null> {
  const raw = args.values.get(name)?.at(-1);
  if (raw === undefined) return { ok: true, value: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    return fail(
      `${name} expects an integer ${options.min}..${options.max}, got "${raw}".\n` +
        `  bun run dashboard:view ${DEFAULT_COMMAND} ${name} ${options.hint}`,
    );
  }
  return { ok: true, value };
}

/**
 * Commands own their flags. `--out` on `ansi` would write nothing anyone asked for, and
 * `--interval` on `html` would quietly render once, so both are errors instead.
 */
function checkCommandFlags(
  command: DashboardCommand,
  args: ParsedArgs,
  flags: DashboardFlags,
): CliResult<true> {
  const spec = DASHBOARD_COMMANDS[command];
  if (flags.out !== "" && spec.output !== "file") {
    return fail(
      `--out is not valid for the ${command} command (${spec.output}).\n` +
        `  bun run dashboard:view html --out dist/dashboard-view.html`,
    );
  }
  if (spec.output !== "loop" && explicitInterval(args)) {
    return fail(
      `--interval is only valid for the watch command.\n` +
        `  bun run dashboard:view watch --interval ${flags.intervalSeconds}`,
    );
  }
  if (spec.output === "file" && wantsAnsiControls(args)) {
    return fail(
      `--columns, --light, --color and --no-color only apply to ansi/watch, not ${command}.\n` +
        `  bun run dashboard:view ${command}${flags.out === "" ? "" : ` --out ${flags.out}`}`,
    );
  }
  return { ok: true, value: true };
}

function explicitInterval(args: ParsedArgs): boolean {
  return args.values.has("--interval") || args.values.has("--watch");
}

function wantsAnsiControls(args: ParsedArgs): boolean {
  return (
    args.values.has("--columns") ||
    hasFlag(args, "--light", "--color", "--no-color")
  );
}

/** Layer 3: what the process can actually do. No CLI policy lives here. */
export interface DashboardRuntimeInput {
  readonly stdoutIsTTY: boolean;
  readonly stdoutColumns: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface DashboardRuntime {
  readonly tty: boolean;
  /** Resolved wrap width; `0` means no wrapping. */
  readonly columns: number;
  readonly color: boolean;
  readonly token: string;
}

export function resolveDashboardRuntime(
  command: DashboardCommand,
  flags: DashboardFlags,
  input: DashboardRuntimeInput,
): DashboardRuntime {
  const tty = input.stdoutIsTTY;
  const color =
    flags.color ??
    (command !== "ansi" && command !== "watch"
      ? false
      : tty && !hasNoColorEnv(input.env));
  const columns =
    flags.columns ??
    (Number.isInteger(input.stdoutColumns) && (input.stdoutColumns ?? 0) > 0
      ? input.stdoutColumns!
      : 100);
  return {
    tty,
    columns,
    color,
    token: input.env["SPORTSDESK_ADMIN_TOKEN"]?.trim() ?? "",
  };
}

function hasNoColorEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = env["NO_COLOR"];
  return value !== undefined && value !== "";
}

export function helpText(command: DashboardCommand | null): string {
  if (command !== null) {
    const spec = DASHBOARD_COMMANDS[command];
    return `
dashboard:view ${command} — ${spec.summary}

Usage:
  bun run dashboard:view ${command} [options]

${spec.output === "loop" ? "Options:" : "Options:"}
  --url <url>            Daemon base URL (default: http://127.0.0.1:4020)
  --rows <n>             Rows per table (default: 25, max: 200)
${
  spec.output === "loop"
    ? "  --interval <seconds>   Refresh interval (default: 10, max: 3600)\n"
    : ""
}${
      spec.output === "stdout" || spec.output === "loop"
        ? `  --columns <n>          Wrap width; 0 disables wrapping (default: terminal width or 100)
  --light                Light ANSI palette
  --color                Force ANSI colour and OSC 8 links
  --no-color             Disable ANSI colour and OSC 8 links
`
        : ""
    }${
      spec.output === "file"
        ? "  --out <path>           Write to a file instead of stdout\n"
        : ""
    }  -h, --help             This text

Examples:
${spec.examples.map((example) => `  ${example}`).join("\n")}
`.trim();
  }

  const commands = (
    Object.entries(DASHBOARD_COMMANDS) as readonly [
      DashboardCommand,
      DashboardCommandSpec,
    ][]
  )
    .map(([name, spec]) => `  ${name.padEnd(9)} ${spec.summary}`)
    .join("\n");

  return `
dashboard:view — SportsDesk/F402 dashboard to ANSI, HTML or Markdown

Usage:
  bun run dashboard:view [command] [options]
  bun run dashboard:view <command> --help

Commands:
${commands}

The command says what to render; flags only modify it; the runtime supplies TTY width, colour
support and SPORTSDESK_ADMIN_TOKEN. Without the token, PII panels render as LOCKED.

Examples:
  bun run dashboard:view
  bun run dashboard:view ansi --rows 50
  bun run dashboard:view html --out dist/dashboard-view.html
  bun run dashboard:view markdown | less
  bun run dashboard:watch
  bun run dashboard:view --no-color --columns 0
`.trim();
}
