#!/usr/bin/env bun
/**
 * Standalone guest-boundary gate: run a cell inside the QuickJS realm and inspect the realm's own
 * globals. The probe returns native values from the guest; it never serializes the realm on the host.
 *
 *   bun run tests/code_mode/guest_probe.ts
 */

import { runGuestCell } from "../../lib/quickjs_code_mode.ts";

export const BANNED_GUEST_GLOBALS = [
  "Bun",
  "process",
  "require",
  "module",
] as const;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * The guest cell returns `Object.getOwnPropertyNames(globalThis)`; the host inspects the dumped
 * array directly (no JSON stringify/parse round trip).
 */
export async function probeGuestGlobals(): Promise<readonly string[]> {
  const names = await runGuestCell(
    "return Object.getOwnPropertyNames(globalThis)",
  );
  if (!isStringArray(names)) {
    throw new Error("guest probe: globalThis names is not a string array");
  }
  const leaked = BANNED_GUEST_GLOBALS.filter((name) => names.includes(name));
  if (leaked.length > 0) {
    throw new Error(
      `guest probe: sandbox leak — ${leaked.join(", ")} reachable in the guest`,
    );
  }
  if (!names.includes("tools")) {
    throw new Error(
      "guest probe: tools bridge is missing from the guest realm",
    );
  }
  return names;
}

if (import.meta.main) {
  const names = await probeGuestGlobals();
  console.log(
    `guest probe: ${names.length} globals, no ${BANNED_GUEST_GLOBALS.join("/")}`,
  );
  console.log(names.join(" "));
}
