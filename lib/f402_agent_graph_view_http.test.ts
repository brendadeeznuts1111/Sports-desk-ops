import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  atomicWrite,
  writeAgentGraphBuildManifest,
} from "./f402_agent_graph_artifacts.ts";
import {
  defaultAgentGraphViewPaths,
  handleAgentGraphViewRequest,
} from "./f402_agent_graph_view_http.ts";
import {
  buildViewSet,
  structuralGraphExport,
} from "./f402_agent_graph_views.ts";
import { buildAgentTreeFromGeneral } from "./f402_agent_tree.ts";
import { sha256Hex } from "./f402_hierarchy_hash.ts";

const TMP = join(import.meta.dir, ".tmp-view-http");

describe("f402_agent_graph_view_http", () => {
  test("/graph.webp returns 503 when webp exists but manifest marks stale", async () => {
    const root = join(TMP, "stale-webp");
    const scratch = join(root, "scratch");
    const graphJson = join(scratch, "agent-graph.json");
    const paths = {
      ...defaultAgentGraphViewPaths(root),
      graphJson,
      graphWebp: join(scratch, "agent-graph.webp"),
      graphManifest: join(scratch, "agent-graph.manifest.json"),
    };

    const hash = await sha256Hex("env-a");
    await atomicWrite(graphJson, '{"nodes":[],"edges":[]}\n');
    await atomicWrite(
      paths.graphManifest,
      `${JSON.stringify({
        version: 1,
        envelopePath: "/x",
        envelopeSha256: hash,
        envelopeGeneralRows: 1,
        ingestedRowCount: 1,
        skippedOverflowCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        builtAt: new Date().toISOString(),
      })}\n`,
    );
    await atomicWrite(paths.graphWebp, "RIFFxxxxWEBP");

    const res = await handleAgentGraphViewRequest(
      new Request("http://127.0.0.1/graph.webp"),
      paths,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Stale");
  });

  test("/graph.webp serves when webpEnvelopeSha256 matches envelope", async () => {
    const root = join(TMP, "fresh-webp");
    const scratch = join(root, "scratch");
    const graphJson = join(scratch, "agent-graph.json");
    const paths = {
      ...defaultAgentGraphViewPaths(root),
      graphJson,
      graphWebp: join(scratch, "agent-graph.webp"),
      graphManifest: join(scratch, "agent-graph.manifest.json"),
    };

    const hash = await sha256Hex("env-b");
    await atomicWrite(graphJson, '{"nodes":[],"edges":[]}\n');
    await writeAgentGraphBuildManifest(paths.graphManifest, {
      version: 1,
      envelopePath: "/x",
      envelopeSha256: hash,
      envelopeGeneralRows: 1,
      ingestedRowCount: 1,
      skippedOverflowCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      builtAt: new Date().toISOString(),
      webpEnvelopeSha256: hash,
      webpBuiltAt: new Date().toISOString(),
    });
    await atomicWrite(paths.graphWebp, "RIFFxxxxWEBP");

    const res = await handleAgentGraphViewRequest(
      new Request("http://127.0.0.1/graph.webp"),
      paths,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("webp");
  });

  async function viewsFixture(name: string, fresh: boolean, weeklyAgentId = "MASTER") {
    const root = join(TMP, name);
    const scratch = join(root, "scratch");
    const graphJson = join(scratch, "agent-graph.json");
    const paths = {
      ...defaultAgentGraphViewPaths(root),
      graphJson,
      graphWebp: join(scratch, "agent-graph.webp"),
      graphManifest: join(scratch, "agent-graph.manifest.json"),
      viewsDir: join(scratch, "agent-graph-views"),
    };
    const hash = await sha256Hex(`env-${name}`);
    const tree = buildAgentTreeFromGeneral([
      { AgentID: "R", Login: "R", Level: 1 },
      { AgentID: "A", Login: "A", Level: 2 },
      { AgentID: "B", Login: "B", Level: 3 },
      { AgentID: "C", Login: "C", Level: 3 },
      { AgentID: "X.", Login: "XL", Level: 3 },
      { AgentID: "D1.", Login: "DUP", Level: 3 },
      { AgentID: "D2.", Login: "DUP", Level: 3 },
    ]);
    // Portal-parser style parent for C (previous sibling) to exercise divergence.
    await atomicWrite(
      graphJson,
      `${JSON.stringify({
        nodes: ["R", "A", "B", "C"].map((id) => ({
          data: { id, label: id, level: 1, metrics: null },
        })),
        weekly: {
          agentId: weeklyAgentId,
          figure: { kind: "figures", activePlayers: 1234, thisWeek: -5000.4, today: null },
          fetchedAt: "2026-11-01T18:00:00.000Z",
        },
        edges: [
          { data: { id: "R->A", source: "R", target: "A" } },
          { data: { id: "A->B", source: "A", target: "B" } },
          { data: { id: "B->C", source: "B", target: "C" } },
        ],
      })}\n`,
    );
    const readability = {
      viewCount: 1,
      coverage: 4,
      reconciled: true,
      overflowDrawn: 0,
      worstFontPx: 12,
      totalCrossings: 0,
      totalOverlaps: 0,
      parentDivergence: 1,
      budget: 140,
      rankdir: "LR" as const,
    };
    await writeAgentGraphBuildManifest(paths.graphManifest, {
      version: 1,
      envelopePath: "/x",
      envelopeSha256: hash,
      envelopeGeneralRows: 4,
      ingestedRowCount: 4,
      skippedOverflowCount: 0,
      nodeCount: 4,
      edgeCount: 3,
      builtAt: new Date().toISOString(),
      ...(fresh ? { viewsEnvelopeSha256: hash, readability } : {}),
    });
    const set = buildViewSet(tree);
    await atomicWrite(
      join(paths.viewsDir, "index.json"),
      JSON.stringify({
        version: 1,
        envelopeSha256: hash,
        generatedAt: new Date().toISOString(),
        options: { budget: 140, leafBundleMin: 3, rankdir: "LR" },
        coverage: set.coverage,
        reconciled: true,
        overflowTotal: 0,
        overflowDrawn: 0,
        radial: null,
        agentView: set.agentView,
        views: [
          {
            id: "overview",
            title: "overview",
            focusId: null,
            parentViewId: null,
            boxes: 3,
            agentsShown: 4,
            hidden: 0,
            frontier: [],
            svg: "overview.svg",
            webp: "overview.webp",
            webpWidth: 1,
            webpHeight: 1,
            metrics: {},
          },
        ],
        parentDivergence: { count: 1, byLevel: { 3: 1 }, samples: [] },
      }),
    );
    await atomicWrite(
      join(paths.viewsDir, "structural.json"),
      JSON.stringify(structuralGraphExport(tree)),
    );
    await atomicWrite(join(paths.viewsDir, "overview.webp"), "RIFFxxxxWEBP");
    return paths;
  }

  test("/views and /agent return 503 no-store when manifest views are stale", async () => {
    const paths = await viewsFixture("views-stale", false);
    for (const p of ["/views", "/views/overview.webp", "/agent/C"]) {
      const res = await handleAgentGraphViewRequest(
        new Request(`http://127.0.0.1${p}`),
        paths,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("/views shows the account weekly figure even when its agent is above every root", async () => {
    const paths = await viewsFixture("views-weekly", true);
    const get = async (p: string) =>
      (
        await handleAgentGraphViewRequest(new Request(`http://127.0.0.1${p}`), paths)
      ).text();
    const views = await get("/views");
    expect(views).toContain('<strong>This week:</strong> <span class="neg">-$5,000</span>');
    expect(views).toContain('<strong>Today:</strong> <span class="pos">$0</span>');
    expect(views).toContain("<strong>Active players:</strong> 1,234");
    expect(views).toContain("for MASTER, fetched 2026-11-01T18:00:00.000Z");
    expect(await get("/agent/R")).not.toContain("This week");
  });

  test("/agent/:id shows the weekly figure only for the agent it was fetched for", async () => {
    const paths = await viewsFixture("views-weekly-r", true, "R");
    const get = async (p: string) =>
      (
        await handleAgentGraphViewRequest(new Request(`http://127.0.0.1${p}`), paths)
      ).text();
    expect(await get("/agent/R")).toContain("for R, fetched");
    expect(await get("/agent/A")).not.toContain("This week");
  });

  test("/agent/<login> redirects to the agent id; an ambiguous login lists candidates", async () => {
    const paths = await viewsFixture("views-login", true);
    const get = (p: string) =>
      handleAgentGraphViewRequest(new Request(`http://127.0.0.1${p}`), paths);
    const byLogin = await get("/agent/xl");
    expect(byLogin.status).toBe(302);
    expect(byLogin.headers.get("location")).toBe("/agent/X.");
    expect((await get("/agent/X.")).status).toBe(200);
    const dup = await get("/agent/DUP");
    expect(dup.status).toBe(300);
    const body = await dup.text();
    expect(body).toContain('href="/agent/D1."');
    expect(body).toContain('href="/agent/D2."');
    expect((await get("/agent/NOPE")).status).toBe(404);
  });

  test("/agent/:id shows envelope upline and flags portal-parent divergence", async () => {
    const paths = await viewsFixture("views-fresh", true);
    const res = await handleAgentGraphViewRequest(
      new Request("http://127.0.0.1/agent/c"),
      paths,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('R</a> › <a href="/agent/A">A</a>');
    expect(body).toContain("Portal-parser parent is <strong>B</strong>");
    const views = await handleAgentGraphViewRequest(
      new Request("http://127.0.0.1/views"),
      paths,
    );
    expect(views.status).toBe(200);
    const bad = await handleAgentGraphViewRequest(
      new Request("http://127.0.0.1/views/..%2Fagent-graph.json"),
      paths,
    );
    expect(bad.status).toBe(404);
  });
});
