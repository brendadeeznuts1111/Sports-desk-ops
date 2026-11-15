#!/usr/bin/env bun
/**
 * @file scripts/project_rankings_summary.ts
 * @description Projects the rankings artifact down to the fields a browser may see.
 *
 * The full artifact carries 6,228 `customerId` / `playerLogin` / `agentId` rows, so it cannot be
 * served to the dashboard (#242). The dashboard needs the population and the digest — the two things
 * that make a headline checkable — and neither identifies a customer.
 *
 * The projection is an allowlist, not a redaction: the output is built field by field from a fixed
 * list, so a new field in the artifact cannot leak by being copied along. A denylist would fail open
 * on exactly that case.
 *
 *   bun run scripts/project_rankings_summary.ts           # write the projection
 *   bun run scripts/project_rankings_summary.ts --check   # fail if it is stale
 *
 * Refuses to project an artifact with no `populationRestriction`: pre-#234 numbers must not reach a
 * dashboard where they would read as current.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ARTIFACT = "scratch/f402-customer-decision-rankings.json";
const OUT = "packages/ui/src/data/rankings-summary.json";
const CHECK = Bun.argv.includes("--check");

/** Keys that must never appear in the projection, kept as a post-condition on the output. */
const FORBIDDEN_KEY =
  /^(login|customerid|customer|agent|agentid|agentlogin|ticket|ticketnumber|wagernumber|betgroupid|ipaddress|ip|userid|playername|team1|team2)$/i;

interface Projection {
  readonly schemaVersion: 1;
  readonly sourceArtifact: string;
  readonly sourceSha256: string;
  readonly population: {
    readonly rule: string;
    readonly summaryCustomerCount: number;
    readonly gradedRowsBefore: number;
    readonly gradedRowsAfter: number;
    readonly droppedRows: number;
    readonly droppedCustomers: number;
  };
}

function fail(message: string): never {
  console.error(`project_rankings_summary: ${message}`);
  process.exit(1);
}

function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key))
      fail(`forbidden key "${key}" at ${path} — the projection leaked`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function main(): void {
  if (!existsSync(ARTIFACT)) {
    fail(
      `artifact not found at ${ARTIFACT}. Regenerate with ` +
        `bun run scripts/generate_customer_decision_rankings.ts`,
    );
  }

  const bytes = readFileSync(ARTIFACT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`artifact is not valid JSON: ${String(error)}`);
  }

  const restriction = (parsed as { populationRestriction?: unknown })
    .populationRestriction;
  if (typeof restriction !== "object" || restriction === null) {
    fail(
      "artifact has no populationRestriction — it predates #234, so its headline describes a " +
        "different population than the current one. Refusing to publish it to the dashboard.",
    );
  }

  const r = restriction as Record<string, unknown>;
  const num = (key: string): number => {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v))
      fail(`populationRestriction.${key} is not a number`);
    return v;
  };
  const rule = r["rule"];
  if (typeof rule !== "string" || rule.trim() === "")
    fail("populationRestriction.rule is empty");

  const projection: Projection = {
    schemaVersion: 1,
    sourceArtifact: ARTIFACT.split("/").pop() ?? ARTIFACT,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    population: {
      rule,
      summaryCustomerCount: num("summaryCustomerCount"),
      gradedRowsBefore: num("gradedRowsBefore"),
      gradedRowsAfter: num("gradedRowsAfter"),
      droppedRows: num("droppedRows"),
      droppedCustomers: num("droppedCustomers"),
    },
  };

  // Post-condition: the allowlist above is the guarantee, this is the check that it held.
  assertNoForbiddenKeys(projection);

  const serialized = `${JSON.stringify(projection, null, 2)}\n`;

  if (CHECK) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== serialized) {
      fail(`${OUT} is stale — rerun without --check`);
    }
    console.log(
      `project_rankings_summary: ok — ${OUT} matches ${projection.sourceSha256.slice(0, 16)}…`,
    );
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, serialized);
  console.log(
    `project_rankings_summary: wrote ${OUT} — ${projection.population.summaryCustomerCount} customers, ` +
      `${projection.population.gradedRowsAfter}/${projection.population.gradedRowsBefore} rows, ` +
      `digest ${projection.sourceSha256.slice(0, 16)}…`,
  );
}

main();
