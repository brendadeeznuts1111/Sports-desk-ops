import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Generated schemas cite a declaration, not a line range.
 *
 * They used to say `Parsed from simulate_bettor_churn_suite.ts:106-115`. Adding four harmless
 * lines above the interface invalidated every citation and changed the spec, so `verify:docs`
 * failed for a line offset — twice in one afternoon. A symbol citation survives the edit.
 *
 * The hardcoded prose citations in the spec are not covered here (many name handlers with no
 * exported symbol); this pins the generator's own output.
 */

const ROOT = resolve(import.meta.dir, "..");
const spec = JSON.parse(
  readFileSync(resolve(ROOT, "docs/openapi.json"), "utf8"),
) as { components?: { schemas?: Record<string, { description?: string }> } };

const schemas = Object.entries(spec.components?.schemas ?? {});

describe("generated schema citations", () => {
  test("every 'Parsed from' citation names a file and a symbol", () => {
    const citations = schemas
      .map(([name, schema]) => ({ name, text: schema.description ?? "" }))
      .filter((entry) => entry.text.includes("Parsed from"));
    expect(citations.length).toBeGreaterThan(5);
    for (const entry of citations) {
      const match = /Parsed from (\S+?)\.$/.exec(entry.text);
      expect(match, `${entry.name}: no "Parsed from" tail`).not.toBeNull();
      expect(match?.[1]).toMatch(/^[a-z0-9_]+\.ts#[A-Za-z0-9_]+$/);
    }
  });

  test("no generated citation carries a line number", () => {
    const offenders = schemas
      .filter(([, schema]) => /Parsed from [a-z0-9_]+\.ts:\d/.test(schema.description ?? ""))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("the WeblogEntry prose cites its declaration too", () => {
    // This one was already stale: it named :117-123 after the interface had moved to 130.
    const weblog = schemas.find(([name]) => name === "WeblogEntry")?.[1];
    expect(weblog?.description ?? "").toContain("simulate_bettor_churn_suite.ts#RawWebLogEntry");
    expect(weblog?.description ?? "").not.toMatch(/simulate_bettor_churn_suite\.ts:\d/);
  });
});
