#!/usr/bin/env bun
/**
 * @file scripts/env_audit.ts
 * @description Audit `.env`: secret classification, leak scan across tracked files, file mode.
 *
 *   bun run env:audit
 *   bun run env:audit --json
 *
 * Bun auto-loads `.env` for every command, so a value that reaches a tracked file is exposed on every
 * checkout. Secret values are compared in memory and never printed; only names and paths appear.
 */

import {
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  type TrackedFile,
  auditEnv,
  parseEnvFile,
  permissionWarning,
} from "../lib/env_audit.ts";

const HELP = `
env:audit — check .env classification, leaks and permissions

Options:
  --json     Machine-readable output
  -h, --help This text

Examples:
  bun run env:audit
  bun run env:audit --json

Secret values are never printed. Exit 1 when a secret appears in a tracked file or .env is tracked.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2));
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const envFile = Bun.file(".env");
if (!(await envFile.exists())) {
  console.error("env:audit: no .env in this directory.");
  process.exit(0);
}

const entries = parseEnvFile(await envFile.text());
const stat = await envFile.stat();

const tracked: TrackedFile[] = [];
const list = Bun.spawnSync(["git", "ls-files", "-z"], {
  env: {
    ...Bun.env,
    GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  },
});
if (list.exitCode !== 0) {
  console.error("env:audit: git ls-files failed; run inside the repository.");
  process.exit(2);
}
for (const path of list.stdout.toString().split("\0")) {
  if (path === "" || path === ".env") continue;
  const file = Bun.file(path);
  if (!(await file.exists())) continue;
  if (file.size > 512 * 1024) continue;
  const text = await file.text().catch(() => "");
  if (text.includes("\u0000")) continue;
  tracked.push({ path, text });
}

const result = auditEnv(entries, tracked);
const modeWarning = permissionWarning(stat.mode);
const json = hasFlag(parsed, "--json");

if (json) {
  console.log(
    JSON.stringify(
      {
        ok:
          result.leaks.length === 0 &&
          !result.envTracked &&
          modeWarning === null,
        secrets: result.secretNames,
        nonSecrets: result.nonSecretNames,
        leaks: result.leaks,
        envTracked: result.envTracked,
        modeWarning,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `keys: ${entries.length} · secret ${result.secretNames.length} · other ${result.nonSecretNames.length}`,
  );
  console.log(`secret names: ${result.secretNames.join(", ") || "(none)"}`);
  if (result.envTracked) console.error("env:audit: .env is tracked by git");
  if (modeWarning !== null) console.error(`env:audit: ${modeWarning}`);
  for (const leak of result.leaks) {
    console.error(`env:audit: ${leak.name} appears in ${leak.path}`);
  }
  if (result.leaks.length === 0 && !result.envTracked && modeWarning === null) {
    console.error(`env:audit: OK · ${tracked.length} tracked file(s) scanned`);
  }
}

if (result.leaks.length > 0 || result.envTracked) process.exit(1);
