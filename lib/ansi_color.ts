/**
 * @file lib/ansi_color.ts
 * @description Shared TTY-aware ANSI color gate honoring `FORCE_COLOR`, `NO_COLOR`, and `Bun.enableANSIColors`.
 */

export interface UseColorOptions {
  readonly isTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly enableANSIColors?: boolean;
  readonly wantColor?: boolean;
}

/**
 * Resolves whether ANSI color escapes should be emitted.
 *
 * Precedence (matching `scripts/render_tasks.ts` and Bun 1.4.4's internal behavior):
 * 1. `FORCE_COLOR` (`"1"`, `"true"`, `"2"`, `"3"` -> `true`; `"0"` -> `false`) — wins over `NO_COLOR`.
 * 2. `NO_COLOR` present in env -> `false`.
 * 3. `wantColor` -> `true` if explicitly requested.
 * 4. Otherwise `isTTY && enableANSIColors` (defaulting to `process.stdout.isTTY === true` and `Bun.enableANSIColors`).
 */
export function useColor(options: UseColorOptions = {}): boolean {
  const env = options.env ?? Bun.env;
  const forceColor = env.FORCE_COLOR;
  if (
    forceColor === "1" ||
    forceColor === "true" ||
    forceColor === "2" ||
    forceColor === "3"
  ) {
    return true;
  }
  if (forceColor === "0") {
    return false;
  }
  if ("NO_COLOR" in env) {
    return false;
  }
  if (options.wantColor) {
    return true;
  }
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const enableANSIColors =
    options.enableANSIColors ??
    (typeof Bun !== "undefined" ? Bun.enableANSIColors : false);
  return isTTY && enableANSIColors;
}
