/**
 * @file lib/cli_inspect.ts
 * @description `Bun.inspect` options for human-readable operator reports.
 *
 * Machine output stays `JSON.stringify`; this is for the terminal view of the same report.
 */

/** Every `Bun.inspect` option set explicitly, so a report never depends on Bun's defaults. */
export type CliInspectOptions = Readonly<
  Required<NonNullable<Parameters<typeof Bun.inspect>[1]>>
>;

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
