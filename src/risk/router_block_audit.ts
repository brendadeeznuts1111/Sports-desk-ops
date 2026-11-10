/**
 * @file src/risk/router_block_audit.ts
 * @description Queries post-block accepted order counts from the order router
 * (NOT dashboard UI state) to determine `block_enforced` per slice.
 *
 * Contract:
 * - Non-zero post-block accepted orders => `block_enforced = false`.
 * - Per-slice `block_enforced` snapshots live in a derived `Uint32Array` bitset
 *   keyed by `SLICE_REGISTRY` index, exposed strictly through a predicate.
 */

import {
  deriveSliceBitsetPredicate,
  SLICE_REGISTRY,
  type SlicePredicate,
  type SliceSpec,
} from "./slice_registry.ts";

export interface SliceRouterOrderQuery {
  /**
   * Returns the number of orders accepted by the router after block policy
   * activation for `slice_id`. Any non-zero (or non-finite) value means the
   * block is NOT enforced.
   */
  countPostBlockAcceptedOrders(slice_id: string): number;
}

/**
 * Evaluates whether router block enforcement holds for `slice_id`.
 * Fails closed: returns `true` iff post-block accepted order count is strictly `0`.
 */
export function queryBlockEnforced(
  router: SliceRouterOrderQuery,
  slice_id: string,
): boolean {
  const acceptedOrders = router.countPostBlockAcceptedOrders(slice_id);
  return Number.isFinite(acceptedOrders) && acceptedOrders === 0;
}

/**
 * Derives an encapsulated registry-indexed `Uint32Array` bitset for `block_enforced`
 * across `registry` from a router telemetry query, exposing strictly a `(slice_id) => boolean`
 * predicate (never a `boolean[]`, never raw bitset buffers).
 */
export function deriveRouterBlockEnforcedPredicate(
  router: SliceRouterOrderQuery,
  registry: readonly SliceSpec[] = SLICE_REGISTRY,
): SlicePredicate {
  return deriveSliceBitsetPredicate(
    (spec) => queryBlockEnforced(router, spec.slice_id),
    registry,
  );
}

/**
 * Constructs a zero-allocation `SliceRouterOrderQuery` backed by an immutable
 * slice->postBlockAcceptedOrders snapshot record from router telemetry.
 */
export function createStaticRouterOrderQuery(
  postBlockOrdersBySlice: Readonly<Record<string, number>>,
): SliceRouterOrderQuery {
  return {
    countPostBlockAcceptedOrders(slice_id: string): number {
      if (Object.hasOwn(postBlockOrdersBySlice, slice_id)) {
        return postBlockOrdersBySlice[slice_id]!;
      }
      return 0;
    },
  };
}
