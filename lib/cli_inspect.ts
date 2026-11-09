/**
 * @file lib/cli_inspect.ts
 * @description `Bun.inspect` options for human-readable operator reports.
 *
 * Machine output stays `JSON.stringify`; this is for the terminal view of the same report.
 */

/** Every `Bun.inspect` option set explicitly, so a report never depends on Bun's defaults. */
export type BunInspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

export type CliInspectOptions = Readonly<Required<BunInspectOptions>>;

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
