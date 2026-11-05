/**
 * Every DSH plugin bundle must keep its dependency-free verify-load harness green.
 *
 * The harnesses are the bundles' own smoke tests: they load the Host half with a fake context,
 * assert the frozen tool/slot registrations, and check the manifest, locale keys and client
 * safety rules. None of them needs a running Host, network access or the real repo data, so they
 * belong in the normal `bun test tests/` gate rather than an operator's memory.
 *
 * The harnesses are run with the Bun binary executing this suite: the packages are Bun/Node
 * ESM scripts, and the larger ones (dsh-plugin) import the checkout's TypeScript.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUNDLES = [
  "dsh-plugin",
  "dsh-plugin-sidebar",
  "dsh-plugin-ui",
  "dsh-plugin-watchlist-autobet",
  "dsh-plugin-security",
] as const;

describe("DSH plugin bundles", () => {
  for (const bundle of BUNDLES) {
    test(`${bundle} verify-load passes`, async () => {
      const harness = join(ROOT, bundle, "verify-load.mjs");
      expect(existsSync(harness), `${bundle} has no verify-load.mjs`).toBe(
        true,
      );

      const child = Bun.spawn([process.execPath, harness], {
        cwd: join(ROOT, bundle),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
      ]);
      const exitCode = await child.exited;
      const report = [stderr.trim(), stdout.trim()]
        .filter((part) => part !== "")
        .join("\n");
      expect(exitCode, `${bundle} verify-load failed:\n${report}`).toBe(0);
    }, 60_000);
  }
});
