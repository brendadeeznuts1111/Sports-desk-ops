#!/usr/bin/env bun
/**
 * @file scripts/ci/check_oracle_frozen.ts
 * @description Contract-freeze gate: a schema change must be paired with an oracle change.
 *
 * The oracle is the frozen specification. If the committed snapshot or the Code Mode argument
 * schema changes without `tests/code_mode/oracle.ts` changing, the suite would silently follow the
 * new contract instead of failing — so this gate fails first.
 *
 * Contract inputs:
 *   - data/profile-snapshot.json    the 31-profile data contract
 *   - lib/profile_query_schema.ts   the Code Mode argument schema (Zod)
 *
 * Base selection: ORACLE_BASE_REF, then the push event's GITHUB_EVENT_BEFORE, then the PR base,
 * then origin/main, then HEAD^. A base that resolves to HEAD (a push-to-main checkout) falls
 * back to HEAD^ so the pushed commit is still compared with its parent.
 *
 *   bun run check:oracle-frozen
 *   ORACLE_BASE_REF=origin/main bun run check:oracle-frozen
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const ORACLE = "tests/code_mode/oracle.ts";
const CONTRACT_INPUTS = [
  "data/profile-snapshot.json",
  "lib/profile_query_schema.ts",
] as const;

const git = (args: readonly string[]): { ok: boolean; stdout: string } => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout.trim() };
};

const ZERO_SHA = /^0+$/;
const explicitBase = (process.env.ORACLE_BASE_REF ?? "").trim();
const eventBefore = (process.env.GITHUB_EVENT_BEFORE ?? "").trim();
const pullBase = (process.env.GITHUB_BASE_REF ?? "").trim();

const resolve = (ref: string): string => {
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok ? result.stdout : "";
};
const head = resolve("HEAD");

const candidates = [
  explicitBase,
  eventBefore !== "" && !ZERO_SHA.test(eventBefore) ? eventBefore : "",
  pullBase !== "" ? `origin/${pullBase}` : "",
  "origin/main",
].filter((candidate) => candidate !== "");

let baseRef = "";
for (const candidate of candidates) {
  const sha = resolve(candidate);
  if (sha === "") continue;
  if (sha === head) {
    // A push-to-main checkout has origin/main == HEAD; compare the pushed commit to its parent.
    if (resolve("HEAD^") !== "") baseRef = "HEAD^";
    continue;
  }
  baseRef = candidate;
  break;
}
if (baseRef === "" && resolve("HEAD^") !== "") baseRef = "HEAD^";

const committed = baseRef !== "" ? [`${baseRef}...HEAD`] : ["HEAD"];
const diff = git(["diff", "--name-only", ...committed]);
if (!diff.ok) {
  console.error(
    `check:oracle-frozen: cannot diff against ${committed.join(" ")}`,
  );
  process.exit(2);
}
// Include uncommitted changes so a local pre-commit run sees the same pairing the CI push does.
const working = git(["diff", "--name-only", "HEAD"]);
if (!working.ok) {
  console.error(
    "check:oracle-frozen: cannot diff the working tree against HEAD",
  );
  process.exit(2);
}

const changed = new Set(
  [diff.stdout, working.stdout]
    .flatMap((output) => (output === "" ? [] : output.split("\n")))
    .filter((path) => path !== ""),
);

// git diff cannot see an untracked contract input; say so instead of silently skipping it.
const untrackedInputs = CONTRACT_INPUTS.filter(
  (path) => existsSync(path) && !git(["ls-files", "--error-unmatch", path]).ok,
);
if (untrackedInputs.length > 0) {
  console.warn(
    "check:oracle-frozen: warning — untracked contract input(s); changes are invisible to this gate:",
  );
  for (const path of untrackedInputs) console.warn(`  untracked: ${path}`);
}
const contractChanges = CONTRACT_INPUTS.filter((path) => changed.has(path));
const oracleChanged = changed.has(ORACLE);

if (contractChanges.length > 0 && !oracleChanged) {
  console.error(
    "check:oracle-frozen: contract input changed without re-freezing the oracle",
  );
  for (const path of contractChanges) console.error(`  changed: ${path}`);
  console.error(`  missing: ${ORACLE}`);
  console.error(
    `Re-freeze deliberately: update ${ORACLE} (counts, sentinel ids, field map) in the same change.`,
  );
  process.exit(1);
}

const comparison = baseRef !== "" ? `${baseRef}...HEAD` : "HEAD (working tree)";
console.log(
  `check:oracle-frozen: ok — ${contractChanges.length} contract change(s) against ${comparison}, oracle ${oracleChanged ? "updated" : "unchanged"}`,
);
