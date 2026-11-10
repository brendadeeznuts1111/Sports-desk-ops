/**
 * @file src/risk/router_block_audit.ts
 * @description Queries post-block accepted order counts from the order router
 * (NOT dashboard UI state) to determine `block_enforced` per slice.
 *
 * Contract: non-zero post-block accepted orders => `block_enforced = false`.
 */

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
