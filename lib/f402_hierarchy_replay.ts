/**
 * Dry / replay / oracle scaffolding for `POST /cloud/api/Manager/getListAgenstByAgent`.
 * No parser — oracle mode feeds GENERAL into the pinned portal extraction only.
 */

import { buildHierarchyFormBody } from "./f402_hierarchy_envelope.ts";
import { MANAGER_RRO, PROBE_HOST } from "./f402_hierarchy_config.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "./f402_replay_transport.ts";
import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";
import {
  oracleSnapshot,
  runPortalHierarchyOracle,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";

export const LIST_AGENTS_URL_PATH = "/cloud/api/Manager/getListAgenstByAgent";

export interface AccountInfoOwnerFixture {
  readonly agentID: string;
  readonly accountInfo: {
    readonly AgentType: string;
    readonly AgentMenuStyle?: string;
    readonly Login?: string;
    [key: string]: unknown;
  };
}

export interface ListAgentsRequestFixture {
  readonly agentID?: string;
  readonly agentType?: string;
  readonly agentOwner?: string;
  readonly RRO?: number;
}

export interface HierarchyReplayPlan {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: URLSearchParams;
  readonly bodyRecord: Record<string, string>;
}

export function loadAccountInfoOwnerFixture(
  raw: unknown,
): AccountInfoOwnerFixture {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("account fixture must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const agentID = String(obj.agentID ?? "").trim();
  if (agentID === "") throw new Error("account fixture missing agentID");
  const accountInfo = obj.accountInfo;
  if (typeof accountInfo !== "object" || accountInfo === null) {
    throw new Error("account fixture missing accountInfo");
  }
  const agentType = String(
    (accountInfo as Record<string, unknown>).AgentType ?? "",
  ).trim();
  if (agentType === "")
    throw new Error("account fixture missing accountInfo.AgentType");
  return {
    agentID,
    accountInfo: accountInfo as AccountInfoOwnerFixture["accountInfo"],
  };
}

export function loadListAgentsRequestFixture(
  raw: unknown,
): ListAgentsRequestFixture {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object")
    throw new Error("list-agents body fixture must be an object");
  return raw as ListAgentsRequestFixture;
}

export function buildListAgentsReplayPlan(
  account: AccountInfoOwnerFixture,
  bodyFixture: ListAgentsRequestFixture = {},
  options?: { readonly host?: string | undefined; readonly rro?: number },
): HierarchyReplayPlan {
  const host = (options?.host ?? PROBE_HOST).replace(/\/$/, "");
  const rro = bodyFixture.RRO ?? options?.rro ?? MANAGER_RRO;
  const body = buildHierarchyFormBody(
    {
      agentID: bodyFixture.agentID ?? account.agentID,
      agentType: bodyFixture.agentType ?? account.accountInfo.AgentType,
      agentOwner: bodyFixture.agentOwner,
    },
    rro,
  );
  return {
    url: `${host}${LIST_AGENTS_URL_PATH}`,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    body,
    bodyRecord: Object.fromEntries(body),
  };
}

export function assertHierarchyHttpResponse(
  res: Response,
  bodyText: string,
): void {
  if (res.status === 401) {
    throw new Error(
      "getListAgenstByAgent returned 401 — session expired or missing cookie (client would console.log and leave hierarchy empty). Auth: F402_WEBVIEW_PROFILE + WebView login (bun run hierarchy:probe -- --login), F402_SESSION_FILE, or F402_REPLAY_PROXY_URL",
    );
  }
  if (res.redirected || (res.status >= 300 && res.status < 400)) {
    throw new Error(
      `getListAgenstByAgent redirected (HTTP ${res.status}) url=${res.url} — not a JSON envelope`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `getListAgenstByAgent HTTP error ${res.status} url=${res.url}: ${bodyText.slice(0, 200)}`,
    );
  }
}

/** HTTP + JSON wire boundary (validates envelope shape). */
export function parseHierarchyFetchResponse(
  res: Response,
  bodyText: string,
): ListAgentsByAgentEnvelope {
  assertHierarchyHttpResponse(res, bodyText);
  return parseListAgentsByAgentWireText(bodyText);
}

export function assertHierarchyFetchResponse(
  res: Response,
  bodyText: string,
): void {
  parseHierarchyFetchResponse(res, bodyText);
}

export async function fetchListAgentsEnvelope(
  plan: HierarchyReplayPlan,
  transport: F402ReplayTransport,
): Promise<{
  readonly res: Response;
  readonly envelopeText: string;
  readonly envelope: ListAgentsByAgentEnvelope;
}> {
  const res = await transport.fetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body: plan.body.toString(),
    redirect: "manual",
  });
  const bodyText = await res.text();
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `getListAgenstByAgent redirect (${res.status}) Location=${res.headers.get("location") ?? "?"} — session or host mismatch`,
    );
  }
  const envelope = parseHierarchyFetchResponse(res, bodyText);
  return { res, envelopeText: bodyText, envelope };
}

export async function runHierarchyOracleOnEnvelope(
  envelope: ListAgentsByAgentEnvelope,
): Promise<{
  readonly generalLength: number;
  readonly oracleSnapshot: string;
}> {
  const result = await runPortalHierarchyOracle(
    envelope.GENERAL as PortalGeneralRow[],
    { runSetComplete: true },
  );
  return {
    generalLength: envelope.GENERAL.length,
    oracleSnapshot: oracleSnapshot(result.nested),
  };
}

/** Parse at wire boundary, then oracle (for fixture text / one-off callers). */
export async function runHierarchyOracleOnEnvelopeText(
  envelopeText: string,
): Promise<{
  readonly generalLength: number;
  readonly oracleSnapshot: string;
}> {
  return runHierarchyOracleOnEnvelope(
    parseListAgentsByAgentWireText(envelopeText),
  );
}

export type HierarchyReplayMode = "dry" | "replay" | "oracle";

export interface HierarchyReplayOutcome {
  readonly mode: HierarchyReplayMode;
  readonly plan: HierarchyReplayPlan;
  readonly envelopeText?: string;
  readonly oracle?: {
    readonly generalLength: number;
    readonly oracleSnapshot: string;
  };
}

export async function runHierarchyReplay(options: {
  readonly mode: HierarchyReplayMode;
  readonly account: AccountInfoOwnerFixture;
  readonly bodyFixture?: ListAgentsRequestFixture;
  readonly host?: string | undefined;
  readonly profileDir?: string | undefined;
  readonly proxyUrl?: string | undefined;
}): Promise<HierarchyReplayOutcome> {
  const plan = buildListAgentsReplayPlan(options.account, options.bodyFixture, {
    host: options.host,
  });
  if (options.mode === "dry") {
    return { mode: "dry", plan };
  }
  const transport = await createF402ReplayTransport({
    profileDir: options.profileDir,
    proxyUrl: options.proxyUrl,
  });
  try {
    const { envelopeText, envelope } = await fetchListAgentsEnvelope(
      plan,
      transport,
    );
    if (options.mode === "replay") {
      return { mode: "replay", plan, envelopeText };
    }
    const oracle = await runHierarchyOracleOnEnvelope(envelope);
    return { mode: "oracle", plan, envelopeText, oracle };
  } finally {
    await transport.close();
  }
}
