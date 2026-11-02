#!/usr/bin/env bun
/**
 * GENERAL tree → SQLite → Cytoscape JSON. Live fetches use F402ReplayTransport only.
 *
 *   bun run graph:agent
 *   bun run graph:agent -- --envelope scratch/raw-f402-list-agents.json
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  agentGraphArtifactPathsFromJsonOut,
  atomicWrite,
  isAgentGraphBuildFresh,
  resolveDefaultAgentGraphEnvelope,
  sha256HexFile,
  writeAgentGraphBuildManifest,
} from "../lib/f402_agent_graph_artifacts.ts";
import {
  F402_AGENT_SECURITY_WARNING_AGAIN_MARKDOWN,
  F402_AGENT_SECURITY_WARNING_MARKDOWN,
} from "../lib/f402_agent_policy.ts";
import {
  buildAgentGraph,
  fetchHierarchyEnvelopeForGraph,
  loadAccountFixtureFromFile,
} from "../lib/f402_agent_graph.ts";
import type { ListAgentsByAgentEnvelope } from "../lib/f402_list_agents_by_agent.ts";
import { parseListAgentsByAgentWireText } from "../lib/f402_list_agents_wire_boundary.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";

const REPO = join(import.meta.dir, "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    live: { type: "boolean" },
    envelope: { type: "string" },
    account: { type: "string" },
    db: { type: "string" },
    out: { type: "string" },
    weekly: { type: "boolean" },
    force: { type: "boolean" },
    "master-id": { type: "string", default: "MASTER1" },
    "master-login": { type: "string", default: "MASTER1" },
    "show-security-notice": { type: "boolean", default: true },
    "no-show-security-notice": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`graph:agent — hierarchy ingest + Cytoscape export (no token flags)

${F402_AGENT_SECURITY_WARNING_MARKDOWN}

Options:
  --envelope <path>   Offline envelope (default: F402_RAW_ENVELOPE or scratch/raw-f402-list-agents.json)
  --live              Live: FetchSession / WebView profile (requires --account fixture). Saves the
                      response to the --envelope default path (previous copy kept as .prev) and
                      writes the manifest from it, so views/image/verify check live data too
  --account <path>    getAccountInfoOwner-shaped JSON (agentID + accountInfo.AgentType)
  --db <path>         SQLite (default scratch/agent-graph.sqlite)
  --out <path>        Graph JSON (default scratch/agent-graph.json)
  --force             Rebuild even when manifest matches envelope sha256
  --weekly            Also fetch getWeeklyFigureByAgentLite for root agent (live only)
  --master-id         Parser context (default MASTER1)
  --master-login      Parser context (default MASTER1)
  --no-show-security-notice  Omit security banner on stderr
  -h, --help

Idempotent: skips when scratch/agent-graph.manifest.json matches envelope SHA-256 and outputs exist.

Doc: docs/evidence/agent-graph-operator.md
`);
  process.exit(0);
}

const showSecurityNotice =
  !Bun.argv.includes("--no-show-security-notice") &&
  values["show-security-notice"] !== false;

if (showSecurityNotice) {
  console.error(F402_AGENT_SECURITY_WARNING_MARKDOWN);
  console.error("");
}

const dbPath = values.db?.trim() || join(REPO, "scratch/agent-graph.sqlite");
const outPath = values.out?.trim() || join(REPO, "scratch/agent-graph.json");
const artifactPaths = agentGraphArtifactPathsFromJsonOut(outPath);
const parserContext = {
  masterId: values["master-id"] ?? "MASTER1",
  masterLogin: values["master-login"] ?? "MASTER1",
};

/**
 * A live envelope goes where offline runs and every downstream script read it, so their SHA
 * checks cover live data too. A differing previous file is kept as `<path>.prev`.
 */
async function saveLiveEnvelope(text: string): Promise<string> {
  const dest = resolveDefaultAgentGraphEnvelope(REPO);
  const previous = Bun.file(dest);
  if ((await previous.exists()) && (await previous.text()) !== text) {
    await atomicWrite(`${dest}.prev`, previous);
  }
  await atomicWrite(dest, text);
  return dest;
}

async function main(): Promise<void> {
  const live = values.live === true;
  const envelopePath = live
    ? undefined
    : resolveDefaultAgentGraphEnvelope(REPO, values.envelope);
  const accountPath = values.account?.trim();

  if (live && values.envelope) {
    throw new Error("Use --live or --envelope, not both");
  }
  if (!live && envelopePath && !(await Bun.file(envelopePath).exists())) {
    throw new Error(`Envelope not found: ${envelopePath}`);
  }
  if (live && !accountPath) {
    throw new Error("--live requires --account <getAccountInfoOwner fixture>");
  }

  let envelopeSha256 = "";
  if (!live && envelopePath) {
    envelopeSha256 = await sha256HexFile(envelopePath);
    if (
      values.force !== true &&
      (await isAgentGraphBuildFresh({
        manifestPath: artifactPaths.manifest,
        artifactPaths,
        envelopeSha256,
      }))
    ) {
      console.error(
        `[graph:agent] up-to-date (envelope sha256=${envelopeSha256.slice(0, 12)}…) — use --force to rebuild`,
      );
      return;
    }
  }

  let rootAgentId = "";
  let accountFixture:
    Awaited<ReturnType<typeof loadAccountFixtureFromFile>> | undefined;
  let transport:
    Awaited<ReturnType<typeof createF402ReplayTransport>> | undefined;
  let envelopeGeneral: Pick<ListAgentsByAgentEnvelope, "GENERAL"> | undefined;
  let envelopeGeneralRows = 0;
  let resolvedEnvelopePath = envelopePath ?? "";

  try {
    if (live) {
      accountFixture = await loadAccountFixtureFromFile(accountPath!);
      rootAgentId = accountFixture.agentID;
      transport = await createF402ReplayTransport({});
      console.error(
        `[graph:agent] live transport=${transport.label} agentID=${rootAgentId}`,
      );
      const { envelopeText } = await fetchHierarchyEnvelopeForGraph(
        transport,
        accountFixture,
        { agentOwner: rootAgentId },
      );
      resolvedEnvelopePath = await saveLiveEnvelope(envelopeText);
      envelopeSha256 = await sha256HexFile(resolvedEnvelopePath);
    }

    // Live and offline both build from the envelope file, so the manifest SHA names what was built.
    const envelope = parseListAgentsByAgentWireText(
      await Bun.file(resolvedEnvelopePath).text(),
    );
    envelopeGeneralRows = envelope.GENERAL.length;
    if (!live) {
      rootAgentId =
        String(
          envelope.GENERAL[0]?.AgentID ?? Bun.env.F402_GRAPH_ROOT_AGENT_ID ?? "",
        ).trim() || "UNKNOWN_ROOT";
    }
    envelopeGeneral = { GENERAL: envelope.GENERAL };
    console.error(
      `[graph:agent] ${live ? "live" : "offline"} envelope=${resolvedEnvelopePath} sha256=${envelopeSha256.slice(0, 12)}… generalRows=${envelopeGeneralRows}`,
    );

    const result = await buildAgentGraph({
      dbPath,
      parserContext,
      rootAgentId,
      ...(envelopeGeneral ? { envelope: envelopeGeneral } : {}),
      ...(transport ? { transport } : {}),
      ...(accountFixture ? { account: accountFixture } : {}),
      ...(live ? { bodyFixture: { agentOwner: rootAgentId } } : {}),
      fetchWeeklyForRoot: values.weekly === true,
    });

    if (showSecurityNotice) {
      console.error(F402_AGENT_SECURITY_WARNING_AGAIN_MARKDOWN);
      console.error("");
    }

    const graphJsonText = `${JSON.stringify(result.graph, null, 2)}\n`;
    const { cytoscapeExportToSvg } =
      await import("../lib/f402_agent_graph_svg.ts");
    const { renderAgentGraphCapturePage } =
      await import("../lib/f402_agent_graph_capture_page.ts");

    await atomicWrite(outPath, graphJsonText);
    await atomicWrite(
      artifactPaths.graphSvg,
      cytoscapeExportToSvg(result.graph),
    );
    await atomicWrite(
      artifactPaths.graphCaptureHtml,
      renderAgentGraphCapturePage(JSON.stringify(result.graph, null, 2)),
    );

    await writeAgentGraphBuildManifest(artifactPaths.manifest, {
      version: 1,
      envelopePath: resolvedEnvelopePath,
      envelopeSha256,
      envelopeGeneralRows,
      ingestedRowCount: result.ingest.rowCount,
      skippedOverflowCount: result.ingest.skippedOverflow.length,
      nodeCount: result.graph.nodes.length,
      edgeCount: result.graph.edges.length,
      builtAt: new Date().toISOString(),
    });

    console.error(
      `[graph:agent] ingested=${result.ingest.rowCount} skippedOverflow=${result.ingest.skippedOverflow.length} nodes=${result.graph.nodes.length} edges=${result.graph.edges.length}`,
    );
    console.error(`[graph:agent] wrote ${outPath}`);
    console.error(
      `[graph:agent] manifest ${artifactPaths.manifest} (views and webp stale until graph:agent:views + graph:agent:image)`,
    );
  } finally {
    await transport?.close();
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
