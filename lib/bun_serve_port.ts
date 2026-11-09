/**
 * @fileoverview `Bun.serve`'s documented default-port cascade, for callers that only
 * have the environment — not the running `Server` handle.
 *
 * Prefer `server.port` / `server.url` when you do have the handle (for example after
 * `Bun.serve({ port: 0 })`); this module is for supervisors and diagnostics that must
 * predict the port a child process will bind.
 */

/** Precedence from the Bun server docs; `--port` outranks all three but is argv, not env. */
export const BUN_SERVE_PORT_NAMES = ["BUN_PORT", "PORT", "NODE_PORT"] as const;

/**
 * Resolve the port Bun would pick: `BUN_PORT` → `PORT` → `NODE_PORT` → 3000.
 *
 * `0` is a valid value: it asks the OS for a random port and stops the cascade.
 * Negative or non-numeric values are skipped. Measured on 1.4.4, an environment
 * variable also wins over the `--port` CLI flag (the docs list the flag first);
 * this helper covers the environment half only.
 */
export function resolveBunServePort(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  return resolveSportsdeskDaemonPort(environment, 3000);
}

/**
 * Resolve the Sportsdesk Ops daemon port (`:4020` by default) while honoring
 * the full Bun-native port cascade (`BUN_PORT` → `PORT` → `NODE_PORT` → `defaultPort`).
 */
export function resolveSportsdeskDaemonPort(
  environment: Readonly<Record<string, string | undefined>>,
  defaultPort = 4020,
): number {
  for (const name of BUN_SERVE_PORT_NAMES) {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return defaultPort;
}

