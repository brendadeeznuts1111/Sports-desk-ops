/**
 * Probe boundary: wire envelope → GENERAL only (never retain PLAYERS for callers).
 */

import { join } from "node:path";

import {
  buildListAgentsReplayPlan,
  fetchListAgentsEnvelope,
  loadAccountInfoOwnerFixture,
  type AccountInfoOwnerFixture,
} from "./f402_hierarchy_replay.ts";
import { createF402ReplayTransport } from "./f402_replay_transport.ts";
import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";
import {
  parsePortalGeneralRows,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";

export interface ListAgentsGeneralProbe {
  readonly general: readonly PortalGeneralRow[];
  readonly generalRowCount: number;
  readonly playersRowCount: number;
  readonly extra: boolean | undefined;
}

export function generalProbeFromWireText(text: string): ListAgentsGeneralProbe {
  const envelope = parseListAgentsByAgentWireText(text);
  return {
    general: parsePortalGeneralRows(envelope.GENERAL),
    generalRowCount: envelope.GENERAL.length,
    playersRowCount: envelope.PLAYERS.length,
    extra: envelope.EXTRA,
  };
}

export async function fetchListAgentsGeneralProbe(options: {
  readonly account: AccountInfoOwnerFixture;
  readonly profileDir?: string | undefined;
  readonly proxyUrl?: string | undefined;
  readonly host?: string | undefined;
}): Promise<ListAgentsGeneralProbe> {
  const plan = buildListAgentsReplayPlan(
    options.account,
    {},
    { host: options.host },
  );
  const transport = await createF402ReplayTransport({
    profileDir: options.profileDir,
    proxyUrl: options.proxyUrl,
  });
  try {
    const { envelope } = await fetchListAgentsEnvelope(plan, transport);
    return {
      general: parsePortalGeneralRows(envelope.GENERAL),
      generalRowCount: envelope.GENERAL.length,
      playersRowCount: envelope.PLAYERS.length,
      extra: envelope.EXTRA,
    };
  } finally {
    await transport.close();
  }
}

export async function loadAccountForGeneralProbe(
  accountPath: string,
): Promise<AccountInfoOwnerFixture> {
  const resolved = accountPath.startsWith("/")
    ? accountPath
    : join(process.cwd(), accountPath);
  return loadAccountInfoOwnerFixture(await Bun.file(resolved).json());
}

export function masterContextFromAccount(account: AccountInfoOwnerFixture): {
  readonly masterId: string;
  readonly masterLogin: string;
} {
  const login = account.accountInfo.Login?.trim();
  return {
    masterId: account.agentID,
    masterLogin: login !== undefined && login !== "" ? login : account.agentID,
  };
}
