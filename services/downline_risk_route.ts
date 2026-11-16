/**
 * @file downline_risk_route.ts
 * @description Typed downline-risk scan route over the hierarchy cold-ingest SoA.
 *
 * The scratch arrays are per-worker and are only touched by the synchronous scan
 * block after the session await, so concurrent requests cannot interleave inside
 * a scan. That is load-bearing: do not add an `await` inside the scan block.
 * The session verifier is injected: a present-but-invalid
 * `__Host-bdo_ops_sid` is rejected instead of trusting cookie presence.
 *
 * Agent logins are ASCII by contract: `canonicalizeAndEncodeLoginIntoRow`
 * rejects non-ASCII and U+FFFD, and this route length-guards the decoded param
 * before touching the scratch.
 */

import type { BunRequest, Server } from "bun";
import {
  type AgentRowIdx15,
  type Fantasy402HierarchyColumnStore,
  canonicalizeAndEncodeLoginIntoRow,
  findStandbyRowByLoginKeyBinarySearch,
  MAX_DOWNLINE_MATCHES_15,
  NODE_STRUCT_FLAGS_MASK,
  NODE_STRUCT_FLAGS_SHIFT,
  STRUCT_NODE_CUSTOMER,
  SUBACCT_ORD_WILDCARD,
} from "../lib/fantasy402_hierarchy_cold_ingest.ts";

/** Pre-allocated per-worker scratch buffers (no per-request heap on the scan path). */
const workerKeyWords32 = new Uint32Array(2);
const workerAsciiU8 = new Uint8Array(64);
const workerLenU8 = new Uint8Array(1);
const workerLimbU16 = new Uint16Array(8);
const workerOutMatchesU16 = new Uint16Array(MAX_DOWNLINE_MATCHES_15);

export type DownlineRiskFilter = (
  arena: Fantasy402HierarchyColumnStore,
  root: AgentRowIdx15,
  tier: number,
  ord: number,
  out: Uint16Array,
) => number;

export type DownlineSessionVerifier = (
  token: string,
) => boolean | Promise<boolean>;

const MAX_AGENT_LOGIN_LENGTH = 64;

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export function downlineRiskMethodNotAllowed(): Response {
  return errorResponse(
    405,
    { error: "ERR_METHOD_NOT_ALLOWED" },
    { Allow: "GET" },
  );
}

export async function handleDownlineRiskRoute(
  req: BunRequest<"/api/v1/hierarchy/:agentLogin/risk/:tier">,
  _server: Server<undefined>,
  activeSpine: Fantasy402HierarchyColumnStore,
  sortedRowOrderU16: Uint16Array,
  filterFn: DownlineRiskFilter,
  verifySession: DownlineSessionVerifier,
): Promise<Response> {
  const sessionToken = req.cookies.get("__Host-bdo_ops_sid");
  if (!sessionToken) {
    return errorResponse(401, { error: "ERR_AUTH_MISSING_HOST_COOKIE" });
  }
  if (!(await verifySession(sessionToken))) {
    // Bun appends Secure for the __Host- prefix; CookieStoreDeleteOptions
    // accepts path only, so the other invariants cannot be passed here.
    req.cookies.delete("__Host-bdo_ops_sid", { path: "/" });
    return errorResponse(401, { error: "ERR_AUTH_REJECTED" });
  }

  const { agentLogin, tier } = req.params;
  if (agentLogin.length > MAX_AGENT_LOGIN_LENGTH) {
    return errorResponse(400, { error: "ERR_INVALID_AGENT_LOGIN" });
  }
  if (!/^[0-6]$/.test(tier) || agentLogin.includes("\uFFFD")) {
    return errorResponse(400, { error: "ERR_BAD_ROUTE_PARAM" });
  }
  const tierCode = Number(tier);

  try {
    canonicalizeAndEncodeLoginIntoRow(
      agentLogin,
      false,
      0,
      workerKeyWords32,
      workerAsciiU8,
      workerLenU8,
      workerLimbU16,
    );
  } catch {
    return errorResponse(400, { error: "ERR_INVALID_AGENT_LOGIN" });
  }

  const matchedRow = findStandbyRowByLoginKeyBinarySearch(
    activeSpine.loginKeyWords32Col,
    sortedRowOrderU16,
    activeSpine.nodeCount,
    workerKeyWords32[0] ?? 0,
    workerKeyWords32[1] ?? 0,
  );

  if (matchedRow < 0 || matchedRow >= activeSpine.agentCount) {
    return errorResponse(404, { error: "ERR_AGENT_NOT_FOUND" });
  }

  const structKind =
    ((activeSpine.packedNodeWord32Col[matchedRow] ?? 0) >>>
      NODE_STRUCT_FLAGS_SHIFT) &
    NODE_STRUCT_FLAGS_MASK;
  if (structKind === STRUCT_NODE_CUSTOMER) {
    return errorResponse(422, { error: "ERR_CUSTOMER_NOT_AGENT_ROOT" });
  }

  const count = filterFn(
    activeSpine,
    matchedRow as AgentRowIdx15,
    tierCode,
    SUBACCT_ORD_WILDCARD,
    workerOutMatchesU16,
  );
  if (count < 0) {
    return errorResponse(503, { error: "ERR_SPINE_CONTENDED", code: count });
  }
  if (!Number.isInteger(count) || count > MAX_DOWNLINE_MATCHES_15) {
    return errorResponse(500, { error: "ERR_MATCH_COUNT_INVALID" });
  }

  // Refresh the origin-locked session cookie only after every request check
  // passed, so 400/404/422/503 replies do not extend the session.
  req.cookies.set("__Host-bdo_ops_sid", sessionToken, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });

  return new Response(workerOutMatchesU16.subarray(0, count).slice().buffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Match-Count": String(count),
    },
  });
}
