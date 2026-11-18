#!/usr/bin/env bun
import { checkProfileCodeModeHostAllowlist } from "./profile_code_mode_host_allowlist.ts";

const { violations, scanned } = await checkProfileCodeModeHostAllowlist();

if (violations.length > 0) {
  console.error("profile_code_mode_host allowlist: FAIL\n");
  for (const v of violations) console.error(`  • ${v}`);
  console.error(`\n(scanned ${scanned} files)`);
  process.exit(1);
}

console.log(
  `profile_code_mode_host allowlist: PASS (scanned ${scanned} files)`,
);
