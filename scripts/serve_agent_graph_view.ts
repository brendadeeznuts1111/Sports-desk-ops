#!/usr/bin/env bun
/**
 * Agent downline viewer — SVG + cached WebP (no WebView per HTTP request).
 *
 *   bun run graph:agent:view
 */
import { join } from "node:path";

import {
  defaultAgentGraphViewPaths,
  handleAgentGraphViewRequest,
} from "../lib/f402_agent_graph_view_http.ts";

const REPO = join(import.meta.dir, "..");
const paths = defaultAgentGraphViewPaths(REPO);
const PORT = Number(Bun.env.GRAPH_VIEW_PORT ?? "9876");

const server = Bun.serve({
  port: PORT,
  fetch: (req) => handleAgentGraphViewRequest(req, paths),
});

const url = `http://127.0.0.1:${server.port}/`;
console.error(`[graph:agent:view] ${url}`);
console.error(
  `[graph:agent:view] webp: ${paths.graphWebp} (run graph:agent:image to refresh)`,
);

if (Bun.env.GRAPH_VIEW_NO_OPEN !== "1") {
  Bun.spawn(["open", url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}

console.error("[graph:agent:view] Ctrl+C to stop");
await server.ref();
