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

export function downlineRiskMethodNotAllowed(): Response {
  return Response.json(
    { error: "ERR_METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: "GET" } },
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
    return Response.json(
      { error: "ERR_AUTH_MISSING_HOST_COOKIE" },
      { status: 401 },
    );
  }
  if (!(await verifySession(sessionToken))) {
    req.cookies.delete("__Host-bdo_ops_sid", { path: "/" });
    return Response.json({ error: "ERR_AUTH_REJECTED" }, { status: 401 });
  }

  // Refresh the origin-locked session cookie with the full __Host- invariants:
  // no Domain attribute, Path=/, Secure, HttpOnly, SameSite=Strict.
  req.cookies.set("__Host-bdo_ops_sid", sessionToken, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });

  const { agentLogin, tier } = req.params;
  if (agentLogin.length > MAX_AGENT_LOGIN_LENGTH) {
    return Response.json({ error: "ERR_INVALID_AGENT_LOGIN" }, { status: 400 });
  }
  const tierCode = Number(tier);
  if (
    !Number.isInteger(tierCode) ||
    tierCode < 0 ||
    tierCode > 6 ||
    agentLogin.includes("\uFFFD")
  ) {
    return Response.json({ error: "ERR_BAD_ROUTE_PARAM" }, { status: 400 });
  }

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
    return Response.json({ error: "ERR_INVALID_AGENT_LOGIN" }, { status: 400 });
  }

  const matchedRow = findStandbyRowByLoginKeyBinarySearch(
    activeSpine.loginKeyWords32Col,
    sortedRowOrderU16,
    activeSpine.nodeCount,
    workerKeyWords32[0] ?? 0,
    workerKeyWords32[1] ?? 0,
  );

  if (matchedRow < 0 || matchedRow >= activeSpine.agentCount) {
    return Response.json({ error: "ERR_AGENT_NOT_FOUND" }, { status: 404 });
  }

  const structKind =
    ((activeSpine.packedNodeWord32Col[matchedRow] ?? 0) >>>
      NODE_STRUCT_FLAGS_SHIFT) &
    NODE_STRUCT_FLAGS_MASK;
  if (structKind === STRUCT_NODE_CUSTOMER) {
    return Response.json(
      { error: "ERR_CUSTOMER_NOT_AGENT_ROOT" },
      { status: 422 },
    );
  }

  const count = filterFn(
    activeSpine,
    matchedRow as AgentRowIdx15,
    tierCode,
    SUBACCT_ORD_WILDCARD,
    workerOutMatchesU16,
  );
  if (count < 0) {
    return Response.json(
      { error: "ERR_SPINE_CONTENDED", code: count },
      { status: 503 },
    );
  }
  if (count > MAX_DOWNLINE_MATCHES_15) {
    return Response.json({ error: "ERR_MATCH_OVERFLOW" }, { status: 500 });
  }

  return new Response(workerOutMatchesU16.subarray(0, count).slice().buffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Match-Count": String(count),
    },
  });
}
