# Fantasy402 Hierarchy Cold-Ingest Replacement Plan

**Status:** scaffold committed with the review caveats; production mount and
canonical replacement are still blocked. `lib/fantasy402_hierarchy_cold_ingest.ts`
in this checkout is a documented scaffold: it supplies the exports the route
handler imports, but its flag layout, row packing, key canonicalization, and
store builder are local choices. Do not treat the committed route as a daemon
feature.

## 1. Contract the route depends on

The route (`services/downline_risk_route.ts`) imports only this surface:

| Export                                               | Meaning                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `AgentRowIdx15`                                      | 15-bit row ordinal brand                                               |
| `Fantasy402HierarchyColumnStore`                     | `nodeCount`, `agentCount`, `loginKeyWords32Col`, `packedNodeWord32Col` |
| `MAX_DOWNLINE_MATCHES_15`                            | match-buffer capacity (scaffold: `32767`)                              |
| `NODE_STRUCT_FLAGS_SHIFT` / `NODE_STRUCT_FLAGS_MASK` | structure-kind bit slice (scaffold: `15` / `0x7`)                      |
| `STRUCT_NODE_CUSTOMER`                               | customer structure kind (scaffold: `0`)                                |
| `SUBACCT_ORD_WILDCARD`                               | no sub-account filter (scaffold: `0xffff`)                             |
| `canonicalizeAndEncodeLoginIntoRow`                  | canonical login → `[lo, hi]` key + ASCII/limb scratch                  |
| `findStandbyRowByLoginKeyBinarySearch`               | key lookup over the sorted row order                                   |

The canonical module must keep these names (or the handler import list must be
updated in the same commit). Any change to the packed-node layout must update
`SanitizedRequestAuditView`-style readers and the route's structure check.

## 2. Replacement checklist

1. **Drop in the canonical module** and delete the scaffold-only
   `buildHierarchyColumnStore` helper; tests should construct fixtures through
   the canonical writer/loader.
2. **Wire the production spine:** load the canonical hierarchy column artifact
   once per process, keep the sorted row order immutable, and fail closed with
   `503 ERR_COLD_INGEST_NOT_READY` if the artifact is missing or stale. Never
   build a store from unverified input at request time.
3. **Provide the real tier filter** (`filterFn`) for risk tiers `0..6` and the
   wildcard ordinal `0xffff`. The scaffold has no risk-tier semantics; the
   route must not be mounted with a stub filter.
4. **Bind the verifier:** map `__Host-bdo_ops_sid` to the canonical session
   verifier, refresh with `{ secure, httpOnly, sameSite: "strict", path: "/" }`
   and no `domain`, and keep the U+FFFD boundary rejection.
5. **Mount in the daemon:**
   - add the route to `lib/daemon_routes.ts` with the correct guard
     (`admin`/`pii`) and data class;
   - add the dispatch branch in `services/sportsdesk_webview_server.ts` before
     the fallback;
   - add the evidence-ledger row/surface, regenerate `docs/openapi.json` and
     `docs/api-reference.md`, and pass `check:route-surface`;
   - return an explicit `Response` on every path (non-upgrade route).
6. **Parity test:** run the canonical module and the scaffold over one fixture
   corpus and compare key words, binary-search hits (`-1` included), match
   buffers, counts, and every error status; delete scaffold-only expectations
   once parity is green.
7. **Mounted-route integration test:** start the daemon with a test spine and
   filter, request the mounted path, and assert the cookie verifier, binary
   `Uint16Array` body, `X-Match-Count`, and 401/400/404/422/503 matrix.
8. **Performance check:** confirm no per-request heap allocation inside the scan
   block; the response `.slice()` copy is the only allowed allocation (it
   detaches the per-worker scratch). Verify scratch isolation under concurrent
   requests.

## 3. Rollout boundary

- **Commit 1 (this change):** BunRequest alignment, the scaffold module, the
  standalone route + tests, the routing diagram/runbook bullets, and this plan.
  Caveats stay in the PR description: not mounted, scaffold cold-ingest.
- **Next PR:** add the daemon route-table entry and a mounted-route integration
  test; prove cookie flush and binary body intact through the real daemon.
- **Third PR:** replace the scaffold with the canonical module and run the parity
  test. Steps 1–7 above gate that PR, not the scaffold commit.
