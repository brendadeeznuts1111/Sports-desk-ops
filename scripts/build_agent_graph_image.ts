#!/usr/bin/env bun
/**
 * WebView capture.html → screenshot Blob → Bun.Image WebP (cached on disk).
 *
 *   bun run graph:agent:image
 *   GRAPH_VIEW_PORT=9876 bun run graph:agent:image   # reuse running graph:agent:view
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import { markAgentGraphWebpBuilt } from "../lib/f402_agent_graph_artifacts.ts";
import { writeAgentGraphWebp } from "../lib/f402_agent_graph_capture.ts";
import {
  defaultAgentGraphViewPaths,
  handleAgentGraphViewRequest,
  isAgentGraphWebpFresh,
} from "../lib/f402_agent_graph_view_http.ts";

const REPO = join(import.meta.dir, "..");
const paths = defaultAgentGraphViewPaths(REPO);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`graph:agent:image — WebView → Bun.Image → scratch/agent-graph.webp

Options:
  --port <n>   Use existing viewer on this port (else starts ephemeral server on :0)
  --force      Re-encode even when webp is newer than agent-graph.json
  -h, --help
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (!(await Bun.file(paths.graphJson).exists())) {
    throw new Error(
      `Missing ${paths.graphJson} — run graph:agent with --envelope first`,
    );
  }

  if (values.force !== true && (await isAgentGraphWebpFresh(paths))) {
    const webp = Bun.file(paths.graphWebp);
    console.error(
      `[graph:agent:image] up-to-date ${paths.graphWebp} (${webp.size} bytes)`,
    );
    return;
  }

  const externalPort = values.port?.trim() || Bun.env.GRAPH_VIEW_PORT?.trim();
  let port: number;
  let stopServer: (() => void) | undefined;

  if (externalPort) {
    port = Number(externalPort);
    if (!Number.isFinite(port) || port < 1) throw new Error("Invalid port");
    console.error(`[graph:agent:image] using existing server on ${port}`);
  } else {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => handleAgentGraphViewRequest(req, paths),
    });
    port = server.port!;
    stopServer = () => server.stop();
    console.error(`[graph:agent:image] ephemeral server http://127.0.0.1:${port}/`);
  }

  const captureUrl = `http://127.0.0.1:${port}/capture.html`;
  const viewportW = Number(Bun.env.F402_GRAPH_VIEWPORT_W ?? 1920);
  const viewportH = Number(Bun.env.F402_GRAPH_VIEWPORT_H ?? 1080);
  const quality = Number(Bun.env.F402_GRAPH_WEBP_QUALITY ?? 85);

  try {
    console.error(`[graph:agent:image] capture ${captureUrl}`);
    const { bytes, ms } = await writeAgentGraphWebp(paths.graphWebp, {
      captureUrl,
      viewportWidth: viewportW,
      viewportHeight: viewportH,
      webp: { maxWidth: viewportW, maxHeight: viewportH, quality },
    });
    await markAgentGraphWebpBuilt(paths.graphManifest);
    console.error(
      `[graph:agent:image] wrote ${paths.graphWebp} (${bytes} bytes, ${ms.toFixed(1)}ms)`,
    );
  } finally {
    stopServer?.();
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
