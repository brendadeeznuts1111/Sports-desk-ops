/**
 * The design docs claim "zero collection-heap allocations on the aggregation path" (no `Map`,
 * `Set`, `boolean[]`, dynamic `T[]`) in the TypedArray-arena design. The shipped
 * `lib/gslive_tally_rollup.ts` now meets the collection half of that target: fixed-capacity
 * gid/cell radix tables, SoA TypedArray columns, fixed label tables and Uint32 bitsets.
 *
 * This ratchet is the enforceable zero: a new `Map`/`Set` in the projection module fails it.
 * JS still gives no stack-allocation guarantee; "inline capacity" here means fixed capacity and
 * no growth, not a language-level stack object.
 */
import { describe, expect, test } from "bun:test";

const SOURCE = "lib/gslive_tally_rollup.ts";
const BASELINE_COLLECTION_ALLOCATIONS = 0;

const source = await Bun.file(SOURCE).text();

function countCollectionAllocations(text: string): readonly string[] {
  const pattern = /\bnew\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/g;
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

describe("tally aggregation allocation invariant (design target)", () => {
  test(`the projection module keeps its collection allocations at or below ${BASELINE_COLLECTION_ALLOCATIONS}`, async () => {
    const allocations = countCollectionAllocations(source);
    // If this starts failing with a higher count, a `Map`/`Set` was added to the aggregation path:
    // either restore the arena discipline or move the allocation out of the projection.
    expect(allocations.length).toBeLessThanOrEqual(
      BASELINE_COLLECTION_ALLOCATIONS,
    );
  });

  test("no boolean[] on the aggregation path; flags are Uint32 bitsets", () => {
    expect(source).not.toMatch(/\bboolean\s*\[\s*\]/);
    expect(source).not.toMatch(/Array<\s*boolean\s*>/);
    expect(source).toContain("new Uint32Array");
  });

  test("the design docs state the measured status instead of implying the invariant holds", async () => {
    for (const path of [
      "docs/design/bridge3b_f402_pending.md",
      "docs/design/bridge3c_gslive_tally.md",
      "docs/design/bridge3d_f402_graded.md",
    ]) {
      const doc = await Bun.file(path).text();
      expect(doc).toContain("Status (measured 2026-11-04)");
      expect(doc).toContain("tally_allocation_invariant.test.ts");
    }
  });
});
