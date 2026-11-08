#!/usr/bin/env bun
/**
 * @file scripts/audit_release.ts
 * @description Check `docs/releases.json` against the tags that actually exist.
 *
 *   bun run audit:release
 *   bun run audit:release --json
 *
 * The registry is the machine-readable form of "this tag is superseded and non-deployable". A tag
 * with no entry fails the gate, because the next deploy would have to guess.
 */

import {
  auditReleases,
  compareReleaseTags,
  parseReleases,
} from "../lib/ops_audit.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");

const tagsResult = Bun.spawnSync(["git", "tag", "--list", "docs-v*"], {
  env: {
    ...Bun.env,
    GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  },
});
if (tagsResult.exitCode !== 0) {
  console.error(
    `audit:release: git tag failed: ${tagsResult.stderr.toString().trim()}`,
  );
  process.exit(2);
}
const tags = tagsResult.stdout
  .toString()
  .split("\n")
  .map((tag) => tag.trim())
  .filter((tag) => tag !== "")
  .sort(compareReleaseTags);

let registry: ReturnType<typeof parseReleases>;
try {
  registry = parseReleases(await Bun.file("docs/releases.json").json());
} catch (error) {
  console.error(`audit:release: ${(error as Error).message}`);
  process.exit(2);
}

const errors = auditReleases(tags, registry);

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        current: registry.current,
        tags,
        errors,
      },
      null,
      2,
    ),
  );
} else {
  for (const tag of tags) {
    const entry = registry.tags[tag];
    const state = entry
      ? `${entry.status}${entry.deployable ? " (deployable)" : ""}`
      : "unregistered";
    console.log(`${tag.padEnd(20)} ${state}`);
  }
  for (const error of errors) console.error(`audit:release: ${error}`);
  console.error(
    errors.length === 0
      ? `audit:release: OK · current ${registry.current}`
      : `audit:release: ${errors.length} error(s)`,
  );
}

if (errors.length > 0) process.exit(1);
