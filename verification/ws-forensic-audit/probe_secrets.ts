#!/usr/bin/env bun
/** Probe: Bun.secrets.delete distinguishes true / false / throw, using a disposable service only. */
const service = "com.sportsdesk-ops.forensic-audit-probe";
const name = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const results: Record<string, unknown> = { service, name };

try {
  try {
    await Bun.secrets.set({ service, name, value: "probe-value" });
    results.set = "ok";
  } catch (err) {
    results.set = `throw: ${err instanceof Error ? err.message : String(err)}`;
  }
  results.get = await Bun.secrets.get({ service, name });
  const first = await Bun.secrets.delete({ service, name });
  results.deleteExisting = first; // must be true
  const second = await Bun.secrets.delete({ service, name });
  results.deleteMissing = second; // must be false, not an error
  results.getAfterDelete = await Bun.secrets.get({ service, name });

  // A malformed call is the closest reproducible throw on macOS: an empty name.
  try {
    const bad = await Bun.secrets.delete({ service, name: "" });
    results.deleteEmptyName = `returned ${bad}`;
  } catch (err) {
    results.deleteEmptyName = `throw: ${err instanceof Error ? err.message : String(err)}`;
  }
  results.contract = {
    trueMeansDeleted: first === true,
    falseMeansAbsent: second === false,
    throwIsDistinguishable: String(results.deleteEmptyName).startsWith("throw"),
  };
} finally {
  // Best-effort cleanup of the disposable entry.
  try {
    await Bun.secrets.delete({ service, name });
  } catch {
    /* probe keychain */
  }
}
console.log(JSON.stringify(results, null, 2));
