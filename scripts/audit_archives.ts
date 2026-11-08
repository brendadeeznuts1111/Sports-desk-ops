#!/usr/bin/env bun
/**
 * @file scripts/audit_archives.ts
 * @description Require provenance for every tracked archive.
 *
 *   bun run audit:archives
 *   bun run audit:archives --record gs-manager-cli.zip --origin "vendor upload 2026-10-20" --license Apache-2.0
 *
 * Untracked archives are reported but do not fail the gate: the common case is a local download that
 * was never meant to be committed. The gate exists so that committing one requires a checksum and a
 * statement of where it came from, not a guess made months later.
 */

import { basename } from "node:path";
import {
  type ArchiveFact,
  type ArchiveProvenance,
  auditArchives,
  parseProvenance,
} from "../lib/ops_audit.ts";

const ARCHIVE_PATTERNS = ["*.zip", "*.tar.gz", "*.tgz"] as const;

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : "";
}

function gitList(listArgs: readonly string[]): string[] {
  const result = Bun.spawnSync(["git", "ls-files", ...listArgs], {
    env: {
      ...Bun.env,
      GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) {
    console.error(
      `audit:archives: git ls-files failed: ${result.stderr.toString().trim()}`,
    );
    process.exit(2);
  }
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function hash(path: string): Promise<{ sha256: string; bytes: number }> {
  const buffer = await Bun.file(path).arrayBuffer();
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(buffer))
    .digest("hex");
  return { sha256, bytes: buffer.byteLength };
}

const args = process.argv.slice(2);
const record = flag(args, "--record");

if (record !== "") {
  const origin = flag(args, "--origin");
  const license = flag(args, "--license");
  if (
    origin.trim() === "" ||
    license.trim() === "" ||
    /^(unknown|tbd|n\/a)$/i.test(origin)
  ) {
    console.error(
      "audit:archives: --record needs a real --origin and --license",
    );
    process.exit(2);
  }
  const file = basename(record);
  const fact = await hash(record);
  const provenance: ArchiveProvenance = {
    version: 1,
    file,
    sha256: fact.sha256,
    bytes: fact.bytes,
    origin,
    license,
    recordedAt: new Date().toISOString().slice(0, 10),
  };
  await Bun.write(
    `provenance/${file}.json`,
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  console.error(
    `audit:archives: recorded provenance/${file}.json (${fact.sha256.slice(0, 12)}…)`,
  );
  process.exit(0);
}

const tracked = gitList([...ARCHIVE_PATTERNS]).filter(
  (path) => !path.startsWith("provenance/"),
);
const untracked = gitList([
  "--others",
  "--exclude-standard",
  ...ARCHIVE_PATTERNS,
]);

for (const path of untracked) {
  console.error(
    `audit:archives: warning: ${path} is untracked (no commit, no gate)`,
  );
}

if (tracked.length === 0) {
  console.error("audit:archives: OK · no tracked archives");
  process.exit(0);
}

const archives: ArchiveFact[] = [];
for (const path of tracked) {
  const fact = await hash(path);
  archives.push({ file: path, ...fact });
}

const sidecars = new Map<string, ArchiveProvenance | Error>();
for (const archive of archives) {
  const path = `provenance/${basename(archive.file)}.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) continue;
  try {
    sidecars.set(archive.file, parseProvenance(await file.json()));
  } catch (error) {
    sidecars.set(archive.file, error as Error);
  }
}

const errors = auditArchives(archives, sidecars);
for (const error of errors) console.error(`audit:archives: ${error}`);
console.error(
  errors.length === 0
    ? `audit:archives: OK · ${archives.length} tracked archive(s)`
    : `audit:archives: ${errors.length} error(s)`,
);

if (errors.length > 0) process.exit(1);
