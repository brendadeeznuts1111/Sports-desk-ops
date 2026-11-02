import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { cytoscapeExportToSvg } from "./f402_agent_graph_svg.ts";

describe("f402_agent_graph_svg", () => {
  test("renders nodes and edges as SVG", async () => {
    const graph = JSON.parse(
      await Bun.file(
        join(import.meta.dir, "../tests/fixtures/f402-list-agents-by-agent-snippet.json"),
      ).text(),
    );
    const exportGraph = {
      nodes: (graph.GENERAL as { AgentID: string; Login: string; Level: number }[]).map(
        (r) => ({
          data: {
            id: String(r.AgentID).trim(),
            label: String(r.Login).trim(),
            level: r.Level,
            seqNumber: null,
            metrics: null,
          },
        }),
      ),
      edges: [] as { data: { id: string; source: string; target: string } }[],
    };
    const svg = cytoscapeExportToSvg(exportGraph);
    expect(svg).toContain("<svg");
    expect(svg).toContain("BILLY667");
  });
});
