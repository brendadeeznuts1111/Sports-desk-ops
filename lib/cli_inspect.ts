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

/** Colour only on a terminal, and never under `NO_COLOR` (https://no-color.org). */
export function cliInspectOptions(
  target: InspectTarget = process.stdout,
  env: NodeJS.ProcessEnv = Bun.env,
): CliInspectOptions {
  return {
    colors: target.isTTY === true && (env.NO_COLOR ?? "") === "",
    depth: 4,
    sorted: false,
    compact: false,
  };
}

export function inspectReport(
  report: object,
  options: CliInspectOptions = cliInspectOptions(),
): string {
  return Bun.inspect(report, options);
}

/**
 * Pad a string to visual terminal column display width using Bun.stringWidth (ANSI & emoji safe).
 */
export function padDisplay(
  text: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const pad = Math.max(0, width - Bun.stringWidth(text));
  return align === "right"
    ? `${" ".repeat(pad)}${text}`
    : `${text}${" ".repeat(pad)}`;
}
