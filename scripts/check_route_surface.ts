#!/usr/bin/env bun
/**
 * Fail when the daemon's served surface and the documented surface disagree.
 *
 *   bun run scripts/check_route_surface.ts
 *
 * The three views (if-chain arms, ledger surfaces, spec paths) are hand-maintained; this is the
 * only thing that compares them. Reports; never edits.
 */

import { resolve } from "node:path";
import { DAEMON_PATHS, DAEMON_PREFIX_PATHS } from "../lib/daemon_routes.ts";
import {
  compareRouteSurfaces,
  readRouteSurfaceInputs,
} from "../lib/route_surface.ts";

const root = resolve(import.meta.dir, "..");
// The table is the source. `readRouteSurfaceInputs` still reads the chain, but only so the test
// can compare it with the table; its `served` set is deliberately not used here, or a prefix arm
// the extractor cannot see would silently drop out of the comparison again.
const { declared, spec } = await readRouteSurfaceInputs(root);
const served = new Set([...DAEMON_PATHS, ...DAEMON_PREFIX_PATHS]);
const findings = compareRouteSurfaces({ served, declared, spec });

if (findings.length === 0) {
  let localDeclaredCount = 0;
  let upstreamDeclaredCount = 0;
  let unimplementedDeclaredCount = 0;
  for (const d of declared.values()) {
    if (d.category === "local-route") localDeclaredCount++;
    else if (d.category === "upstream-route") upstreamDeclaredCount++;
    else if (d.category === "documented-not-implemented")
      unimplementedDeclaredCount++;
  }
  const uiAliasCount = served.size - localDeclaredCount;
  console.log(
    `check:route-surface: ok — ${served.size} served path(s) (${localDeclaredCount}/${localDeclaredCount} local-route + ${uiAliasCount} UI aliases), ${declared.size} declared (${localDeclaredCount} local-route, ${upstreamDeclaredCount} upstream-route, ${unimplementedDeclaredCount} documented-not-implemented)`,
  );
  process.exit(0);
}

// Wired into CI (`ci.yml`, after verify:docs) only once this could be green: the eight routes the
// spec did not publish now have surface operations in scripts/generate_openapi.ts, so a new finding
// means real drift rather than a known backlog.

console.error(
  `check:route-surface: ${findings.length} disagreement(s) between served (${served.size}) and declared (${declared.size})`,
);
for (const finding of findings) {
  console.error(`  [${finding.kind}] ${finding.path} — ${finding.detail}`);
}
process.exit(1);
