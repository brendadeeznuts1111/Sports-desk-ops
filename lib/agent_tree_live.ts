/**
 * Live agent-tree refresh. Fetches the portal downline through the replay
 * transport and stamps the tree as a capture. A missing account fixture or
 * manager session throws before any file is written, so the scratch graph
 * cannot be republished as today's book.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentGraph,
  fetchHierarchyEnvelopeForGraph,
  loadAccountFixtureFromFile,
} from "./f402_agent_graph.ts";
import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";
import { createF402ReplayTransport } from "./f402_replay_transport.ts";
import { readF402Session, resolveF402SessionPath } from "./f402_session.ts";
import type { AgentTreeFile } from "./agent_tree.ts";
import { buildAgentTreeFileFromGraph } from "./agent_tree_build.ts";

export const LIVE_AGENT_TREE_SOURCE = "live:f402-list-agents-by-agent";

/**
 * Levels above 12 never enter the portal agent map. A live tree built from that
 * map is a partial capture when any such row was in the envelope.
 */
export function liveTreeOverflow(
  skippedOverflow: readonly { readonly level: number }[],
): { partial: boolean; omittedCount: number } {
  const omittedCount = skippedOverflow.length;
  return { partial: omittedCount > 0, omittedCount };
}

export function resolveLiveAccountPath(
  argvAccount: string | null,
  env: NodeJS.ProcessEnv = Bun.env,
): string {
  const fromArg = argvAccount?.trim() ?? "";
  if (fromArg !== "") return fromArg;
  return env.F402_GRAPH_ACCOUNT?.trim() ?? "";
}

export function missingLiveAccountMessage(): string {
  return "--live requires --account <getAccountInfoOwner json> or F402_GRAPH_ACCOUNT. Refusing to rewrite data/agent-tree.json from scratch/agent-graph.json.";
}

export function missingLiveSessionMessage(): string {
  return "live agent tree needs a manager session. Set F402_SESSION_FILE (bun run session:login) or F402_REPLAY_PROXY_URL. Refusing to rewrite data/agent-tree.json from scratch/agent-graph.json.";
}

/** Local-graph source stamped by `--allow-fixture`. The `fixture:` prefix keeps KPI basis fixture. */
export function fixtureEscapeSource(graphPath: string): string {
  return `fixture:${graphPath}`;
}

/** Refusal text plus the operator escape hatch. The hourly job does not pass that flag. */
export function liveRefusalWithEscapeHatch(reason: string): string {
  return `${reason} Escape hatch: re-run with --allow-fixture to write the local graph as a fixture.`;
}

/** Named reason to stop, or null when a session, proxy, or deprecated cookie is configured. */
export function liveAgentTreeRefusal(
  env: NodeJS.ProcessEnv = Bun.env,
): string | null {
  const proxy = env.F402_REPLAY_PROXY_URL?.trim() ?? "";
  const cookie = env.F402_COOKIE?.trim() ?? "";
  const session = readF402Session({ path: resolveF402SessionPath(env) });
  if (session === null && proxy === "" && cookie === "") {
    return missingLiveSessionMessage();
  }
  return null;
}

/**
 * Fetch the downline and return the tree file. Does not write it: the caller
 * writes only after this resolves, so a failed fetch leaves the previous file.
 */
export async function fetchLiveAgentTree(
  accountPath: string,
  env: NodeJS.ProcessEnv = Bun.env,
): Promise<{ file: AgentTreeFile; hierarchy: unknown }> {
  const refusal = liveAgentTreeRefusal(env);
  if (refusal !== null) throw new Error(refusal);

  const account = await loadAccountFixtureFromFile(accountPath);
  const transport = await createF402ReplayTransport({ env });
  const dbPath = join(
    mkdtempSync(join(tmpdir(), "agent-tree-live-")),
    "graph.sqlite",
  );
  try {
    console.error(
      `[build:agent-tree] live transport=${transport.label} account=${accountPath}`,
    );
    const { envelopeText } = await fetchHierarchyEnvelopeForGraph(
      transport,
      account,
      { agentOwner: account.agentID },
    );
    const envelope = parseListAgentsByAgentWireText(envelopeText);
    const result = await buildAgentGraph({
      dbPath,
      parserContext: { masterId: "MASTER1", masterLogin: "MASTER1" },
      rootAgentId: account.agentID,
      envelope: { GENERAL: envelope.GENERAL },
    });
    const capturedAt = new Date().toISOString();
    const overflow = liveTreeOverflow(result.ingest.skippedOverflow);
    const file = buildAgentTreeFileFromGraph({
      graph: result.graph,
      hierarchy: envelope,
      source: LIVE_AGENT_TREE_SOURCE,
      capturedAt,
      ...overflow,
    });
    console.error(
      `[build:agent-tree] live capturedAt=${capturedAt} agents=${file.agentCount} generalRows=${envelope.GENERAL.length} omittedLevel13Plus=${overflow.omittedCount}`,
    );
    return { file, hierarchy: envelope };
  } finally {
    await transport.close();
  }
}
