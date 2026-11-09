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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUNDLES = readdirSync(ROOT, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && /^dsh-plugin(?:-|$)/.test(entry.name),
  )
  .map((entry) => entry.name)
  .sort();

const INVARIANT_FILES = [
  "package.json",
  "cordis.patch.yml",
  "verify-load.mjs",
] as const;

const isCI = Boolean(Bun.env.CI);
const VERIFY_LOAD_FIXTURES = "tests/fixtures/verify-load";
const hasEnrichedCustomers = existsSync(
  join(ROOT, "enriched_customers_full.json"),
);

describe("DSH plugin bundles", () => {
  test("discovers at least one dsh-plugin* bundle at repository root", () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
  });

  if (BUNDLES.length === 0) {
    throw new Error(
      `No dsh-plugin* directories discovered in ${ROOT}; refusing vacuous pass`,
    );
  }

  for (const bundle of BUNDLES) {
    test(`${bundle} declares required bundle manifest files`, () => {
      const bundleDir = join(ROOT, bundle);
      for (const file of INVARIANT_FILES) {
        expect(
          existsSync(join(bundleDir, file)),
          `${bundle} is missing required ${file}`,
        ).toBe(true);
      }
    });

    // dsh-plugin verify-load against the operator book is optional locally; CI pins fixtures.
    const shouldSkip =
      bundle === "dsh-plugin" && !isCI && !hasEnrichedCustomers;
    const verifyLabel = `${bundle} verify-load passes`;

    test.skipIf(shouldSkip)(
      verifyLabel,
      async () => {
        const liveBetsPath = join(ROOT, "data/live-bets.json");
        const liveBetsBefore = existsSync(liveBetsPath)
          ? await Bun.file(liveBetsPath).text()
          : null;

        const bundleDir = join(ROOT, bundle);
        const harness = join(bundleDir, "verify-load.mjs");
        expect(existsSync(harness), `${bundle} has no verify-load.mjs`).toBe(
          true,
        );

        const child = Bun.spawn([process.execPath, harness], {
          cwd: bundleDir,
          env: {
            ...process.env,
            ...(isCI && bundle === "dsh-plugin"
              ? { VERIFY_LOAD_FIXTURES }
              : {}),
          },
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

        if (isCI && bundle === "dsh-plugin") {
          const liveBetsAfter = existsSync(liveBetsPath)
            ? await Bun.file(liveBetsPath).text()
            : null;
          expect(
            liveBetsAfter,
            "verify-load must not write data/live-bets.json at repo root",
          ).toBe(liveBetsBefore);
        }
      },
      60_000,
    );
  }
});
