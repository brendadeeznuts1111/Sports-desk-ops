import { subtreeKeys, type AgentTree } from "./agent_tree.ts";
import { agentKeyOf, type AgentKey } from "./live_bets.ts";

export type ProfileLookupScope = "self" | "children" | "downline";
export type AgentMatchStatus = "found" | "not_in_tree" | "disconnected";

export interface AttributedProfileRow<
  TRow,
  TAgentId extends string = string,
  TCustomerId extends string = string,
> {
  agentId: TAgentId;
  customerId?: TCustomerId;
  row: TRow;
}

export interface AgentRowGroup<TRow, TAgentId extends string = string> {
  agentId: TAgentId;
  rows: TRow[];
  rowCount: number;
}

export interface AgentProfileLookupDiagnostics {
  emptyAgentCount: number;
  uniqueCustomerIdCount?: number;
  duplicateCustomerIdCount?: number;
  cycleGuardTriggered?: boolean;
  excludedNodeCount?: number;
}

export interface AgentProfileLookupMeta<TCustomerId extends string = string> {
  snapshotId?: string;
  capturedAt?: string | null;
  accountId?: string | null;
  customerIds?: TCustomerId[];
  diagnostics?: AgentProfileLookupDiagnostics;
}

export interface AgentProfileLookupQuery<TAgentId extends string = string> {
  rawAgentId?: string;
  agentId: TAgentId;
  scope: ProfileLookupScope;
}

export interface AgentProfileLookupResult<
  TRow,
  TAgentId extends string = string,
  TCustomerId extends string = string,
> {
  agentId: TAgentId;
  scope: ProfileLookupScope;
  agentStatus: AgentMatchStatus;
  agentIds: TAgentId[];
  agentCount: number;
  profileRowCount: number;
  rows: TRow[];
  query?: AgentProfileLookupQuery<TAgentId>;
  byAgent?: AgentRowGroup<TRow, TAgentId>[];
  attributedRows?: AttributedProfileRow<TRow, TAgentId, TCustomerId>[];
  meta?: AgentProfileLookupMeta<TCustomerId>;
}

/** Build once per loaded tree and profile snapshot. Only root-reachable agents are queryable. */
export function createAgentProfileLookup<
  TRow,
  TCustomerId extends string = string,
>(
  tree: AgentTree,
  profiles: readonly TRow[],
  getAgentId: (row: TRow) => string,
  getCustomerId?: (row: TRow) => TCustomerId | undefined,
  provenance: Pick<
    AgentProfileLookupMeta,
    "snapshotId" | "accountId" | "capturedAt"
  > = {},
) {
  const reachable = new Set<AgentKey>();
  for (const root of tree.roots) {
    for (const id of subtreeKeys(tree, root)) reachable.add(id);
  }
  const index = new Map<AgentKey, TRow[]>();
  for (const row of profiles) {
    const id = agentKeyOf({ AgentID: getAgentId(row) });
    const group = index.get(id);
    if (group) group.push(row);
    else index.set(id, [row]);
  }

  return function lookup(
    rawAgentId: string,
    scope: ProfileLookupScope,
  ): AgentProfileLookupResult<TRow, AgentKey, TCustomerId> {
    const agentId = agentKeyOf({ AgentID: rawAgentId });
    const node = tree.nodes.get(agentId);
    let agentStatus: AgentMatchStatus = "not_in_tree";
    let agentIds: AgentKey[] = [];
    if (node) {
      agentStatus = reachable.has(agentId) ? "found" : "disconnected";
      if (agentStatus === "found") {
        switch (scope) {
          case "self":
            agentIds = [agentId];
            break;
          case "children":
            agentIds = [...node.children];
            break;
          case "downline": {
            const descendants = subtreeKeys(tree, agentId);
            descendants.delete(agentId);
            agentIds = [...descendants];
            break;
          }
        }
      }
    }
    const byAgent = agentIds.map((id) => {
      const rows = [...(index.get(id) ?? [])];
      return { agentId: id, rows, rowCount: rows.length };
    });
    const customerIds: TCustomerId[] = [];
    const attributedRows = byAgent.flatMap((group) =>
      group.rows.map((row) => {
        const customerId = getCustomerId?.(row);
        if (customerId === undefined) return { agentId: group.agentId, row };
        customerIds.push(customerId);
        return { agentId: group.agentId, customerId, row };
      }),
    );
    const rows = attributedRows.map((entry) => entry.row);
    const diagnostics: AgentProfileLookupDiagnostics = {
      emptyAgentCount: byAgent.filter((group) => !group.rowCount).length,
      excludedNodeCount: tree.nodes.size - reachable.size,
    };
    if (getCustomerId) {
      diagnostics.uniqueCustomerIdCount = new Set(customerIds).size;
      diagnostics.duplicateCustomerIdCount =
        customerIds.length - diagnostics.uniqueCustomerIdCount;
    }
    return {
      agentId,
      scope,
      agentStatus,
      agentIds,
      agentCount: agentIds.length,
      profileRowCount: rows.length,
      rows,
      byAgent,
      attributedRows,
      query: { agentId, scope, ...(rawAgentId !== agentId && { rawAgentId }) },
      meta: {
        ...provenance,
        ...(getCustomerId && { customerIds }),
        diagnostics,
      },
    };
  };
}
