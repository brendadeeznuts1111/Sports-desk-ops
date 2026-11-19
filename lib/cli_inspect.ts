/**
 * @file lib/cli_inspect.ts
 * @description `Bun.inspect` options for human-readable operator reports.
 *
 * Machine output stays `JSON.stringify`; this is for the terminal view of the same report.
 */

/** Every `Bun.inspect` option set explicitly, so a report never depends on Bun's defaults. */
export type BunInspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

export type CliInspectOptions = Readonly<Required<BunInspectOptions>>;

/**
 * What Bun actually hands `[Bun.inspect.custom]` — not the options the caller passed.
 *
 * Measured on 1.4.4: the third argument is exactly `{ colors, depth, stylize }`. `sorted` and
 * `compact` are **inputs to** `Bun.inspect` and are never forwarded, so typing the custom hook
 * with `BunInspectOptions` promises `options.sorted` that is `undefined` at runtime. `stylize`
 * is present but returned its text unchanged in both the `colors: true` and `colors: false`
 * probes, so a report must not rely on it for colour.
 */
export interface CliInspectContext {
  /** Resolved from the caller's `colors` option (terminal detection happens in Bun). */
  readonly colors: boolean;
  /**
   * Remaining depth. `Bun.inspect(x)` passes `8`, `Bun.inspect(x, { depth: 0 })` passes `0`,
   * and a negative depth is never passed; `<= 0` is therefore the shallow branch.
   */
  readonly depth: number;
  /** Bun's styling hook; measured as a no-op on 1.4.4. */
  readonly stylize?: ((text: string, style: string) => string) | undefined;
  /** Bun may forward more keys in a later version; never assume one is absent. */
  readonly [key: string]: unknown;
}

/** The typed `[Bun.inspect.custom]` contract for a CLI report. */
export interface CliInspectable {
  [Bun.inspect.custom](
    depth: number,
    options: CliInspectContext,
    inspect: typeof Bun.inspect,
  ): string;
}

/** True when a value renders itself in `Bun.inspect` rather than by field dumping. */
export function isCliInspectable(value: unknown): value is CliInspectable {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return (
    typeof (value as { [Bun.inspect.custom]?: unknown })[Bun.inspect.custom] ===
    "function"
  );
}

/**
 * Base class for an operator report card.
 *
 * The depth convention lives here once instead of in every report: `depth <= 0` renders the
 * label (so a card nested in another inspected object does not dump its whole table), and a
 * positive depth renders the body. Subclasses implement `inspectLabel` and `inspectBody`; the
 * body receives only the context Bun really passes, never the caller's full options.
 */
export abstract class CliInspectCard implements CliInspectable {
  /** One-line name used when the card is inspected at depth `0`. */
  abstract readonly inspectLabel: string;

  abstract inspectBody(options: CliInspectContext): string;

  [Bun.inspect.custom](depth: number, options: CliInspectContext): string {
    return depth <= 0 ? this.inspectLabel : this.inspectBody(options);
  }
}

export interface InspectTarget {
  readonly isTTY?: boolean | undefined;
}

/** `auto` resolves against the terminal and `NO_COLOR`; the explicit modes force a decision. */
export type CliInspectColorMode = "auto" | "always" | "never";

/** Flags every inspect-capable command accepts, parsed from its own argv slice. */
export interface CliInspectFlags {
  /** `Bun.inspect` depth, 0..8. */
  readonly depth?: number | undefined;
  readonly sorted?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly color?: CliInspectColorMode | undefined;
}

/** The highest depth `Bun.inspect` documents; a larger value is clamped by Bun, not by us. */
export const CLI_INSPECT_MAX_DEPTH = 8;

/**
 * Pull the shared inspect flags out of an argv slice.
 *
 * Recognised: `--inspect-depth=<0..8>`, `--inspect-sorted`, `--inspect-compact`,
 * `--inspect-no-compact`, `--inspect-color=auto|always|never`. The returned `rest` keeps every
 * argument the command still needs, so a handler can pass its whole `args` here and continue.
 *
 * @throws when a flag is malformed, so a typo never silently falls back to defaults.
 */
export function parseInspectFlags(args: readonly string[]): {
  readonly flags: CliInspectFlags;
  readonly rest: readonly string[];
} {
  let depth: number | undefined;
  let sorted: boolean | undefined;
  let compact: boolean | undefined;
  let color: CliInspectColorMode | undefined;
  const rest: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--inspect-depth=")) {
      const raw = arg.slice("--inspect-depth=".length);
      const value = Number(raw);
      if (
        raw.trim() === "" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > CLI_INSPECT_MAX_DEPTH
      ) {
        throw new Error(
          `--inspect-depth must be an integer 0..${CLI_INSPECT_MAX_DEPTH}, got ${JSON.stringify(raw)}`,
        );
      }
      depth = value;
    } else if (arg === "--inspect-sorted") {
      sorted = true;
    } else if (arg === "--inspect-compact") {
      compact = true;
    } else if (arg === "--inspect-no-compact") {
      compact = false;
    } else if (arg.startsWith("--inspect-color=")) {
      const raw = arg.slice("--inspect-color=".length);
      if (raw !== "auto" && raw !== "always" && raw !== "never") {
        throw new Error(
          `--inspect-color must be auto, always or never, got ${JSON.stringify(raw)}`,
        );
      }
      color = raw;
    } else if (arg.startsWith("--inspect-")) {
      throw new Error(`unknown inspect flag ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  return {
    flags: {
      ...(depth === undefined ? {} : { depth }),
      ...(sorted === undefined ? {} : { sorted }),
      ...(compact === undefined ? {} : { compact }),
      ...(color === undefined ? {} : { color }),
    },
    rest,
  };
}

/**
 * Resolve the full option set: explicit flags first, then the terminal/`NO_COLOR` default.
 *
 * `--inspect-color=always` is the only way to colour under `NO_COLOR`; `never` always wins.
 */
export function cliInspectOptionsFor(
  flags: CliInspectFlags = {},
  target: InspectTarget = process.stdout,
  env: NodeJS.ProcessEnv = Bun.env,
): CliInspectOptions {
  const noColor = (env.NO_COLOR ?? "") !== "";
  const colors =
    flags.color === "never"
      ? false
      : flags.color === "always"
        ? true
        : target.isTTY === true && !noColor;
  return {
    colors,
    depth: flags.depth ?? 4,
    sorted: flags.sorted ?? false,
    compact: flags.compact ?? false,
  };
}

/** Colour only on a terminal, and never under `NO_COLOR` (https://no-color.org). */
export function cliInspectOptions(
  target: InspectTarget = process.stdout,
  env: NodeJS.ProcessEnv = Bun.env,
): CliInspectOptions {
  return cliInspectOptionsFor({}, target, env);
}

export function inspectReport(
  report: unknown,
  options: CliInspectOptions = cliInspectOptions(),
): string {
  return Bun.inspect(report, options);
}

/**
 * `Bun.inspect.table` with the same option source as `inspectReport`.
 *
 * `columns` narrows and orders the columns; an empty row set renders a single stated line rather
 * than a header-only grid, so a report never looks like it has data.
 */
export function inspectTableRows<const R extends Record<string, unknown>>(
  rows: readonly R[],
  columns?: readonly (keyof R & string)[],
  options: CliInspectOptions = cliInspectOptions(),
): string {
  if (rows.length === 0) return "(no rows)";
  return Bun.inspect.table(rows as R[], columns as string[] | undefined, {
    colors: options.colors,
  });
}

/**
 * Pad to terminal columns. Re-exported from `lib/terminal_format.ts`, where the width, wrap and
 * clip primitives live so a report cannot measure with one rule and wrap with another.
 */
export { padDisplay } from "./terminal_format.ts";
