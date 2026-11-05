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
 * Invalid or non-positive values are skipped, matching a server that ignores them.
 */
export function resolveBunServePort(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  for (const name of BUN_SERVE_PORT_NAMES) {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return 3000;
}
