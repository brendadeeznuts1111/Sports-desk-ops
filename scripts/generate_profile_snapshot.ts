#!/usr/bin/env bun
/**
 * @file scripts/generate_profile_snapshot.ts
 * @description Emit the committed profile snapshot fixture, or project the operator book locally.
 *
 * The committed data/profile-snapshot.json is SYNTHETIC: 27 pseudonymous profiles plus 4 SYNTH_*
 * sentinels. It carries no customer login, agent id or P/L from the operator book, so it can be
 * tested in CI and shipped in the repository.
 *
 * For a deployment that needs real profiles, project the gitignored book to a local file and point
 * PROFILE_SNAPSHOT_PATH at it:
 *
 *   bun run scripts/generate_profile_snapshot.ts --from-book --out data/profile-snapshot.real.json
 *
 *   bun run scripts/generate_profile_snapshot.ts            # write the synthetic fixture
 *   bun run scripts/generate_profile_snapshot.ts --check    # fail when the fixture is stale
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ProfileRecord {
  readonly id: string;
  readonly vol: number;
  readonly clv: number;
  readonly sharp: number;
  readonly flags: readonly string[];
}

const REPO = resolve(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const checkOnly = argv.includes("--check");
const fromBook = argv.includes("--from-book");
const outIndex = argv.indexOf("--out");
const outArg = outIndex === -1 ? "" : (argv[outIndex + 1] ?? "");
const outPath = resolve(
  REPO,
  outArg !== ""
    ? outArg
    : fromBook
      ? "data/profile-snapshot.real.json"
      : "data/profile-snapshot.json",
);

const REGULAR_COUNT = 27;
const SENTINEL_COUNT = 4;

/** Deterministic, tenant-free fixture: stable ids, finite values, a few ties. */
function syntheticProfiles(): readonly ProfileRecord[] {
  const profiles: ProfileRecord[] = [];
  for (let index = 0; index < REGULAR_COUNT; index += 1) {
    profiles.push({
      id: "P" + String(index + 1).padStart(3, "0"),
      vol: index % 4 === 0 ? 0 : (index * 7919) % 500_000,
      clv: ((index * 97) % 4000) - 2000,
      sharp: ((index * 37) % 1000) / 10,
      flags: index % 5 === 0 ? ["FIXTURE", "SAMPLE"] : ["FIXTURE"],
    });
  }
  for (let index = 0; index < SENTINEL_COUNT; index += 1) {
    profiles.push({
      id: "SYNTH_" + String(index + 1).padStart(2, "0"),
      vol: 1_000_000 + index * 250_000,
      clv: 40 + index * 20,
      sharp: 80 + index,
      flags: ["SYNTHETIC"],
    });
  }
  return profiles;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("profile-snapshot: " + where + " is not a finite number");
  }
  return value;
};

const stringFlags = (value: unknown, where: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((flag) => typeof flag !== "string")) {
    throw new Error("profile-snapshot: " + where + " is not a string array");
  }
  const flags: string[] = [];
  for (const flag of value) {
    if (typeof flag !== "string") {
      throw new Error("profile-snapshot: " + where + " is not a string array");
    }
    flags.push(flag);
  }
  return flags;
};

/** Local-only projection of the gitignored operator book; never written to the committed path by default. */
function profilesFromBook(): readonly ProfileRecord[] {
  const source = resolve(REPO, "data/customer-profiles.json");
  if (!existsSync(source)) {
    console.error(
      "profile-snapshot: " +
        source.replace(REPO, ".") +
        " is absent (gitignored operator book); cannot use --from-book",
    );
    process.exit(2);
  }
  const document = JSON.parse(readFileSync(source, "utf8")) as unknown;
  if (!isRecord(document) || !Array.isArray(document.profiles)) {
    throw new Error("profile-snapshot: " + source + " has no profiles array");
  }
  const profiles: ProfileRecord[] = document.profiles.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.customerId !== "string") {
      throw new Error(
        "profile-snapshot: profile #" + index + " has no customerId",
      );
    }
    const id = entry.customerId.trim();
    if (id === "" || id !== entry.customerId) {
      throw new Error(
        "profile-snapshot: profile #" + index + " has an untrimmed id",
      );
    }
    const book = isRecord(entry.book) ? entry.book : {};
    return {
      id,
      vol: finite(book.lifetimeVolumeUsd, id + ".vol"),
      clv: finite(book.clvBps, id + ".clv"),
      sharp: finite(book.sharpScore, id + ".sharp"),
      flags: stringFlags(entry.flags, id + ".flags"),
    };
  });
  return profiles;
}

const profiles = fromBook ? profilesFromBook() : syntheticProfiles();
const document = {
  schemaVersion: 1,
  generatedFrom: fromBook
    ? "data/customer-profiles.json (local; do not commit)"
    : "synthetic fixture; no operator or customer data",
  fieldMap: {
    clv: "book.clvBps",
    vol: "book.lifetimeVolumeUsd",
    sharp: "book.sharpScore",
  },
  profiles,
};
const serialized = JSON.stringify(document, null, 2) + "\n";

if (checkOnly) {
  if (fromBook) {
    console.error(
      "profile-snapshot: --check compares the synthetic fixture; do not pass --from-book",
    );
    process.exit(2);
  }
  const committed = Bun.file(outPath);
  if (!(await committed.exists())) {
    console.error(
      "profile-snapshot: committed fixture " +
        outPath.replace(REPO, ".") +
        " is missing",
    );
    process.exit(1);
  }
  if ((await committed.text()) !== serialized) {
    console.error(
      "profile-snapshot: " +
        outPath.replace(REPO, ".") +
        " is stale — regenerate and re-freeze oracle.ts",
    );
    process.exit(1);
  }
  console.log(
    "profile-snapshot: ok — " +
      profiles.length +
      " synthetic profile(s) match " +
      outPath.replace(REPO, "."),
  );
  process.exit(0);
}

await Bun.write(outPath, serialized);
console.log(
  "profile-snapshot: wrote " +
    profiles.length +
    " " +
    (fromBook ? "real" : "synthetic") +
    " profile(s) to " +
    outPath.replace(REPO, "."),
);
