/**
 * @file tests/bun_check_semantics.test.ts
 * @description No package.json script may use `bun --check` where a check was meant.
 *
 * Measured on 1.4.4: `bun --check <file>` type-checks **and then runs** the target, and with more
 * than one path it checks only the first and passes the rest as argv. `schema:typecheck` was
 * `bun --check` followed by 43 paths, so it checked one file, executed it, and never saw a type
 * error injected into `lib/urls.ts` — the `preschema` hook meant every `bun run schema` ran a
 * gate that could not fail for 42 of its 43 inputs. `bun check <files…>` reports all of them.
 *
 * This pins the machine-readable surface. Prose that shows `--check` as an example is corrected
 * by hand (ROOT_LAYOUT.md, the schema CLI's usage text, the wagers runbook).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("bun --check is a gate before execution, not a check", () => {
  test("no script passes file paths to `bun --check`", () => {
    const offenders = Object.entries(pkg.scripts ?? {})
      .filter(([, command]) => /\bbun --check\s+[^-\s]/.test(command))
      .map(([name, command]) => `${name}: ${command.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  test("schema:typecheck uses the check-only form", () => {
    const command = pkg.scripts?.["schema:typecheck"] ?? "";
    expect(command.startsWith("bun check ")).toBe(true);
    // The gate was 43 paths long; a one-file form cannot regress in silently.
    expect(command.split(" ").length).toBeGreaterThan(10);
  });

  test("preschema still runs the typecheck", () => {
    expect(pkg.scripts?.preschema ?? "").toContain("schema:typecheck");
  });
});
