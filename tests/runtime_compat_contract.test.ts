import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard rails for the runtime-compatibility notes that touch this repo.
 *
 * Measured on Bun 1.4.4:
 * - the isolated linker is the default for new monorepos and `bun.lock`
 *   records `configVersion: 1`; existing lockfiles keep the hoisted linker, and
 *   `linker` stays a machine-owned key (AGENTS.md, lib/pm_policy.ts);
 * - `res.writeHeader()` is gone from Node 26 — `writeHead()` is the API;
 * - NODE_MODULE_VERSION is 147 on Node 26, so prebuilt addons can't be selected
 *   by a hard-coded module version.
 *
 * The repository has no call sites today. These tests keep it that way: the
 * literals are assembled at runtime where they would otherwise match this file.
 */

const ROOT = process.cwd();
const SKIP_PREFIXES = [
  ".agents/",
  ".worktrees/",
  "dist/",
  "node_modules/",
  "scratch/",
  "Scratch/",
  "tests/fixtures/",
  "verification/",
];
const SELF = "tests/runtime_compat_contract.test.ts";

interface BunLock {
  readonly lockfileVersion?: number;
  readonly configVersion?: number;
}

describe("runtime compatibility contracts", () => {
  test("bun.lock records configVersion 1 and the project does not pin the machine-owned linker", async () => {
    // bun.lock is JSONC: trailing commas are legal there, so JSON.parse is not.
    const parsed = Bun.JSON5.parse(
      readFileSync(resolve(ROOT, "bun.lock"), "utf8"),
    ) as BunLock;
    expect(parsed.configVersion).toBe(1);
    expect(parsed.lockfileVersion).toBeGreaterThanOrEqual(2);

    const bunfig = Bun.TOML.parse(
      readFileSync(resolve(ROOT, "bunfig.toml"), "utf8"),
    ) as Record<string, unknown>;
    // `linker` is machine-owned (lib/pm_policy.ts); a project pin would silently
    // override the default isolated linker and must fail here.
    const install = bunfig["install"];
    const pinned =
      "linker" in bunfig ||
      (typeof install === "object" &&
        install !== null &&
        "linker" in (install as Record<string, unknown>));
    expect(pinned).toBe(false);
  });

  test("no tracked source uses the removed writeHeader API", async () => {
    const removed = ["write", "Header("].join("");
    const sources = await trackedSources();
    expect(sources.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of sources) {
      const text = await Bun.file(resolve(ROOT, file)).text();
      if (text.includes(removed)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("no tracked source hard-codes a Node module version", async () => {
    const needles = [
      ["NODE_MODULE", "VERSION"].join("_"),
      ["process.versions", "modules"].join("."),
    ];
    const sources = await trackedSources();

    const offenders: string[] = [];
    for (const file of sources) {
      const text = await Bun.file(resolve(ROOT, file)).text();
      if (needles.some((needle) => text.includes(needle))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("deploy_docs.sh loads credentials explicitly, because --bun no longer reads .env", () => {
    const script = readFileSync(
      resolve(ROOT, "scripts/deploy/deploy_docs.sh"),
      "utf8",
    );
    expect(script).toContain("cloudflare.env");
    expect(script).toContain("pages.env");
  });
});

async function trackedSources(): Promise<string[]> {
  const listed = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx", "*.js"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file !== "" && file !== SELF)
    .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)));
}
