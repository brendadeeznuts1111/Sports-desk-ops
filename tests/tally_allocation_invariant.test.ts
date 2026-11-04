/**
 * The design docs claim "zero collection-heap allocations on the aggregation path" (no `Map`,
 * `Set`, `boolean[]`, dynamic `T[]`) in the TypedArray-arena design. The shipped
 * `lib/gslive_tally_rollup.ts` does not meet that yet: it allocates three `Map`s and one `Set`.
 *
 * A heap profile cannot attribute allocations to one call path (it snapshots retained objects), so
 * a "zero" claim needs either an allocation profiler plus an empty before/after delta or the arena
 * implementation. Until then this ratchet keeps the documented target falsifiable in the cheap
 * direction: the count may go down, never up. Removing the last collection turns the ratchet into
 * the real "zero" assertion without editing this test.
 */
import { describe, expect, test } from "bun:test";

const SOURCE = "lib/gslive_tally_rollup.ts";
const BASELINE_COLLECTION_ALLOCATIONS = 4;

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
