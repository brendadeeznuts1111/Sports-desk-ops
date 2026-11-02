/**
 * Shared HTTP routes for agent graph viewer + capture page (no WebView per request).
 */

import { join } from "node:path";

import type { CytoscapeGraphExport } from "./f402_agent_graph.ts";
import {
  agentGraphArtifactPathsFromJsonOut,
  isAgentGraphViewsFresh,
  isAgentGraphWebpFreshForManifest,
  readAgentGraphManifest,
} from "./f402_agent_graph_artifacts.ts";
import {
  AGENT_GRAPH_CLIENT_JS,
  AGENT_GRAPH_LAYOUT_SCRIPTS,
  renderAgentGraphCapturePage,
} from "./f402_agent_graph_capture_page.ts";
import { cytoscapeExportToSvg } from "./f402_agent_graph_svg.ts";
import {
  AGENT_GRAPH_VIEWS_DIR,
  type AgentGraphViewIndex,
  type StructuralGraphExport,
} from "./f402_agent_graph_views.ts";
import {
  type StoredWeeklyFigureLite,
  storedWeeklyFigureLite,
} from "./f402_weekly_figure_lite.ts";

export interface AgentGraphViewPaths {
  readonly repoRoot: string;
  readonly graphJson: string;
  readonly graphWebp: string;
  readonly graphManifest: string;
  readonly viewsDir: string;
  readonly cytoscapeJs: string;
  readonly elkJs: string;
  readonly cytoscapeElkJs: string;
}

export function defaultAgentGraphViewPaths(
  repoRoot: string,
): AgentGraphViewPaths {
  const scratch = join(repoRoot, "scratch");
  const graphJson = join(scratch, "agent-graph.json");
  const artifacts = agentGraphArtifactPathsFromJsonOut(graphJson);
  return {
    repoRoot,
    graphJson,
    graphWebp: artifacts.graphWebp,
    graphManifest: artifacts.manifest,
    viewsDir: join(scratch, AGENT_GRAPH_VIEWS_DIR),
    cytoscapeJs: join(repoRoot, "node_modules/cytoscape/dist/cytoscape.min.js"),
    elkJs: join(repoRoot, "node_modules/elkjs/lib/elk.bundled.js"),
    cytoscapeElkJs: join(
      repoRoot,
      "node_modules/cytoscape-elk/dist/cytoscape-elk.js",
    ),
  };
}

const VIEW_FILE_RE = /^[A-Za-z0-9._-]+\.(svg|webp)$/;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function staleViews(): Response {
  return new Response(
    "Stale or missing agent-graph views — run: bun run graph:agent:views",
    {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

interface LoadedViews {
  readonly index: AgentGraphViewIndex;
  readonly structural: StructuralGraphExport;
  readonly byId: ReadonlyMap<
    string,
    StructuralGraphExport["nodes"][number]["data"]
  >;
  /** Upper-cased login → agent ids; AgentID and Login differ for some agents and logins can repeat. */
  readonly idsByLogin: ReadonlyMap<string, readonly string[]>;
}

let viewsCache: { key: string; value: LoadedViews } | undefined;

/** index.json + structural.json when the manifest says views match the envelope; else null. */
export async function loadFreshViews(
  paths: AgentGraphViewPaths,
): Promise<LoadedViews | null> {
  if (!(await isAgentGraphViewsFresh(paths.graphManifest))) return null;
  const indexFile = Bun.file(join(paths.viewsDir, "index.json"));
  const structuralFile = Bun.file(join(paths.viewsDir, "structural.json"));
  if (!(await indexFile.exists()) || !(await structuralFile.exists()))
    return null;
  const key = `${indexFile.lastModified}:${structuralFile.lastModified}`;
  if (viewsCache?.key === key) return viewsCache.value;
  const index = JSON.parse(await indexFile.text()) as AgentGraphViewIndex;
  const manifest = await readAgentGraphManifest(paths.graphManifest);
  if (manifest?.envelopeSha256 !== index.envelopeSha256) return null;
  const structural = JSON.parse(
    await structuralFile.text(),
  ) as StructuralGraphExport;
  const idsByLogin = new Map<string, string[]>();
  for (const n of structural.nodes) {
    const login = n.data.label.toUpperCase();
    idsByLogin.set(login, [...(idsByLogin.get(login) ?? []), n.data.id]);
  }
  const value: LoadedViews = {
    index,
    structural,
    byId: new Map(structural.nodes.map((n) => [n.data.id, n.data])),
    idsByLogin,
  };
  viewsCache = { key, value };
  return value;
}

function viewsIndexPage(v: LoadedViews, weekly: StoredWeeklyFigureLite | null): string {
  const { index } = v;
  const cards = index.views
    .map(
      (e) =>
        `<li><a href="/views/${esc(e.webp)}">${esc(e.title)}</a> · ${e.agentsShown} shown` +
        (e.hidden > 0
          ? `, +${e.hidden} in ${e.frontier.length} sub-views`
          : "") +
        ` · font ${e.metrics.effectiveFontPx}px` +
        (e.focusId
          ? ` · <a href="/agent/${encodeURIComponent(e.focusId)}">agent page</a>`
          : "") +
        `</li>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Agent graph views</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;padding:1rem}a{color:#38bdf8}li{margin:.2rem 0}code{background:#1e293b;padding:.1rem .3rem;border-radius:4px}</style></head><body>
<p><a href="/">← dashboard</a> · <form style="display:inline" action="/agent"><input name="id" placeholder="agent id" /> <button>find</button></form></p>
<h1>Agent graph views</h1>
${weekly ? weeklyFigureHtml(weekly) : ""}
<p>${index.views.length} views · coverage ${index.coverage.covered}/${index.coverage.agents} · reconciled ${index.reconciled} · overflow drawn ${index.overflowDrawn}/${index.overflowTotal} · envelope <code>${esc(index.envelopeSha256.slice(0, 16))}</code></p>
<p><strong>Parent divergence:</strong> ${index.parentDivergence.count} agents have a portal-parser parent that differs from the envelope's own nesting. Views use the envelope nesting.</p>
${index.radial ? `<p><a href="/views/${esc(index.radial.webp)}">Radial overview</a></p>` : ""}
<ol>${cards}</ol></body></html>`;
}

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function weeklyFigureHtml({ agentId, figure: f, fetchedAt }: StoredWeeklyFigureLite): string {
  const asOf = `getWeeklyFigureByAgentLite for ${esc(agentId)}, fetched ${esc(fetchedAt)}`;
  if (f.kind === "empty") return `<p>Weekly figure: no rows (${asOf}).</p>`;
  if (f.kind === "withheld") {
    return `<p>Weekly figure: withheld by the portal (Active = -1; ${asOf}).</p>`;
  }
  const amount = (n: number | null) => {
    const v = n ?? 0;
    return `<span class="${v < 0 ? "neg" : "pos"}">${WHOLE_DOLLARS.format(v)}</span>`;
  };
  return `<p><strong>This week:</strong> ${amount(f.thisWeek)} · <strong>Today:</strong> ${amount(f.today)} · <strong>Active players:</strong> ${f.activePlayers.toLocaleString("en-US")} <small>(${asOf})</small></p>`;
}

function agentPage(
  v: LoadedViews,
  id: string,
  portalParent: string | null | undefined,
  weekly: StoredWeeklyFigureLite | null,
): string | null {
  const node = v.byId.get(id);
  if (!node) return null;
  const chain: string[] = [];
  let p = node.upline;
  while (p !== null) {
    chain.unshift(p);
    p = v.byId.get(p)?.upline ?? null;
  }
  const link = (aid: string) => {
    const d = v.byId.get(aid);
    return `<a href="/agent/${encodeURIComponent(aid)}">${esc(d?.label ?? aid)}</a>`;
  };
  const children = v.structural.edges
    .filter((e) => e.data.source === id)
    .map((e) => v.byId.get(e.data.target)!)
    .sort((a, b) => b.subtree - a.subtree || a.label.localeCompare(b.label));
  const viewId = v.index.agentView[id];
  const view = v.index.views.find((e) => e.id === viewId);
  const divergent = portalParent !== undefined && portalParent !== node.upline;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${esc(node.label)} · agent</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;padding:1rem}a{color:#38bdf8}table{border-collapse:collapse}td,th{padding:.15rem .6rem;text-align:left;border-bottom:1px solid #1e293b}.warn{color:#E69F00}.neg{color:#f87171}.pos{color:#4ade80}img{max-width:100%;border:1px solid #1e293b;border-radius:8px}</style></head><body>
<p><a href="/views">← views</a></p>
<h1>${esc(node.label)} <small>level ${node.level}</small></h1>
<p><strong>Upline:</strong> ${chain.length > 0 ? chain.map(link).join(" › ") : "(root)"} › <strong>${esc(node.label)}</strong></p>
<p>Subtree: <strong>${node.subtree}</strong> agents (self included) · direct children: <strong>${node.childCount}</strong> · branch ${esc(node.branch)}${node.overflow > 0 ? ` · <span class="warn">owns ${node.overflow} L13–19 overflow agents</span>` : ""}</p>
${weekly ? weeklyFigureHtml(weekly) : ""}
${divergent ? `<p class="warn">Portal-parser parent is <strong>${esc(portalParent ?? "(none)")}</strong>; the envelope nests this agent under <strong>${esc(node.upline ?? "(none)")}</strong>.</p>` : ""}
${children.length > 0 ? `<table><tr><th>child</th><th>level</th><th>subtree</th><th>overflow</th></tr>${children.map((c) => `<tr><td>${link(c.id)}</td><td>${c.level}</td><td>${c.subtree}</td><td>${c.overflow || ""}</td></tr>`).join("")}</table>` : "<p>No children (leaf agent).</p>"}
${view ? `<h2>Drawn in: ${esc(view.title)}</h2><p><a href="/views/${esc(view.svg)}">SVG</a></p><img src="/views/${esc(view.webp)}" alt="${esc(view.title)}" />` : ""}
</body></html>`;
}

export async function loadAgentGraphExport(
  graphJsonPath: string,
): Promise<CytoscapeGraphExport> {
  const file = Bun.file(graphJsonPath);
  if (!(await file.exists())) {
    throw new Error(
      `Missing ${graphJsonPath} — run: bun run graph:agent -- --envelope tests/fixtures/f402-list-agents-by-agent-snippet.json`,
    );
  }
  return JSON.parse(await file.text()) as CytoscapeGraphExport;
}

export async function isAgentGraphWebpFresh(
  paths: AgentGraphViewPaths,
): Promise<boolean> {
  return isAgentGraphWebpFreshForManifest(paths.graphManifest, paths.graphWebp);
}

function shellPage(
  svg: string,
  stats: string,
  webpState: "fresh" | "stale" | "missing",
): string {
  const webpBlock =
    webpState === "fresh"
      ? `<p><img src="/graph.webp" alt="Agent downline WebP" style="max-width:100%;height:auto;border:1px solid #1e293b;border-radius:8px;" /></p>`
      : webpState === "stale"
        ? `<p><strong>WebP stale</strong> — graph JSON rebuilt. Run <code>bun run graph:agent:image</code> before trusting the raster.</p>`
        : `<p><em>No cached WebP — run <code>bun run graph:agent:image</code></em></p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>F402 agent downline</title>
  <style>
    body { margin: 0; background: #0b1220; color: #e2e8f0; font-family: system-ui, sans-serif; }
    header { padding: 0.5rem 1rem; font-size: 0.8rem; border-bottom: 1px solid #1e293b; }
    header a { color: #38bdf8; margin-right: 1rem; }
    .wrap { overflow: auto; padding: 1rem; }
    svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
    code { background: #1e293b; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <header>${stats} · <a href="/graph.webp">graph.webp</a> · <a href="/graph.svg">graph.svg</a> · <a href="/capture.html">capture</a> · <a href="/interactive">interactive</a> · <a href="/views"><strong>readable views</strong></a></header>
  ${webpBlock}
  <div class="wrap">${svg.replace(/^<\?xml[^?]*\?>\s*/u, "")}</div>
</body>
</html>`;
}

function interactivePage(graphJsonText: string): string {
  const safeJson = graphJsonText.replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>F402 interactive</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0b1220; color: #e2e8f0; font-family: system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 0.45rem 0.75rem; font-size: 0.75rem; border-bottom: 1px solid #1e293b; }
    header a { color: #38bdf8; }
    #cy { flex: 1 1 auto; min-height: 400px; width: 100%; }
  </style>
  ${AGENT_GRAPH_LAYOUT_SCRIPTS}
</head>
<body>
  <header><a href="/">← dashboard</a> · <a href="/views">readable views</a> · click an agent to open its page</header>
  <div id="cy"></div>
  <script type="application/json" id="graph-data">${safeJson}</script>
  <script>
    ${AGENT_GRAPH_CLIENT_JS}
    (function () {
      if (typeof cytoscape !== "function") {
        document.body.innerHTML = "<p style=\\"padding:1rem\\">cytoscape missing</p>";
        return;
      }
      var graph = JSON.parse(document.getElementById("graph-data").textContent);
      var elements = (graph.nodes || []).concat(graph.edges || []);
      var cy = cytoscape({
        container: document.getElementById("cy"),
        elements: elements,
        wheelSensitivity: 0.25,
        minZoom: 0.02,
        style: agentGraphStyle(),
      });
      agentGraphLayout(cy).run();
      cy.on("tap", "node", function (evt) {
        window.location.href = "/agent/" + encodeURIComponent(evt.target.id());
      });
    })();
  </script>
</body>
</html>`;
}

export async function handleAgentGraphViewRequest(
  req: Request,
  paths: AgentGraphViewPaths,
): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const cytoscapeFile = Bun.file(paths.cytoscapeJs);

  const scriptAssets: Record<string, string> = {
    "/cytoscape.min.js": paths.cytoscapeJs,
    "/elk.bundled.js": paths.elkJs,
    "/cytoscape-elk.js": paths.cytoscapeElkJs,
  };
  const assetPath = scriptAssets[pathname];
  if (assetPath !== undefined) {
    const asset =
      pathname === "/cytoscape.min.js" ? cytoscapeFile : Bun.file(assetPath);
    if (!(await asset.exists())) {
      return new Response(`Run bun install (${pathname.slice(1)})`, {
        status: 500,
      });
    }
    return new Response(asset, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  if (pathname === "/views" || pathname === "/views/") {
    const views = await loadFreshViews(paths);
    if (!views) return staleViews();
    let weekly: StoredWeeklyFigureLite | null = null;
    try {
      weekly = storedWeeklyFigureLite(
        (await loadAgentGraphExport(paths.graphJson)).weekly,
      );
    } catch {
      weekly = null;
    }
    return html(viewsIndexPage(views, weekly));
  }

  if (pathname.startsWith("/views/")) {
    const name = pathname.slice("/views/".length);
    if (!VIEW_FILE_RE.test(name))
      return new Response("Not found", { status: 404 });
    if ((await loadFreshViews(paths)) === null) return staleViews();
    const file = Bun.file(join(paths.viewsDir, name));
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": name.endsWith(".svg") ? "image/svg+xml" : "image/webp",
        "cache-control": "no-cache",
      },
    });
  }

  if (pathname === "/agent" || pathname.startsWith("/agent/")) {
    const url = new URL(req.url);
    const raw =
      pathname === "/agent"
        ? (url.searchParams.get("id") ?? "")
        : decodeURIComponent(pathname.slice("/agent/".length));
    const id = raw.trim().toUpperCase();
    if (pathname === "/agent" && id !== "") {
      return new Response(null, {
        status: 302,
        headers: { location: `/agent/${encodeURIComponent(id)}` },
      });
    }
    const views = await loadFreshViews(paths);
    if (views === null) return staleViews();
    const loginIds = views.byId.has(id) ? [] : (views.idsByLogin.get(id) ?? []);
    if (loginIds.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: `/agent/${encodeURIComponent(loginIds[0]!)}` },
      });
    }
    if (loginIds.length > 1) {
      const items = loginIds
        .map((aid) => {
          const d = views.byId.get(aid);
          return `<li><a href="/agent/${encodeURIComponent(aid)}">${esc(aid)}</a> · level ${d?.level ?? "?"}</li>`;
        })
        .join("");
      return html(
        `<p>Login <code>${esc(id)}</code> belongs to ${loginIds.length} agents:</p><ul>${items}</ul>`,
        300,
      );
    }
    let portalParent: string | null | undefined;
    let weekly: StoredWeeklyFigureLite | null = null;
    try {
      const shipped = await loadAgentGraphExport(paths.graphJson);
      const edge = shipped.edges.find((e) => e.data.target === id);
      portalParent = edge
        ? edge.data.source
        : shipped.nodes.some((n) => n.data.id === id)
          ? null
          : undefined;
      weekly = storedWeeklyFigureLite(shipped.weekly);
    } catch {
      portalParent = undefined;
    }
    const page = agentPage(
      views,
      id,
      portalParent,
      weekly?.agentId === id ? weekly : null,
    );
    return page
      ? html(page)
      : html(
          `<p>Unknown agent <code>${esc(id)}</code>. <a href="/views">views</a></p>`,
          404,
        );
  }

  if (pathname === "/graph.webp") {
    const url = new URL(req.url);
    if (url.searchParams.get("refresh") === "1") {
      return new Response(
        "Regenerate offline: bun run graph:agent:image (never spawns WebView per request)",
        {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    const webp = Bun.file(paths.graphWebp);
    if (!(await webp.exists())) {
      return new Response(
        "Missing scratch/agent-graph.webp — run: bun run graph:agent:image",
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    const fresh = await isAgentGraphWebpFresh(paths);
    if (!fresh) {
      return new Response(
        "Stale agent-graph.webp (graph rebuilt) — run: bun run graph:agent:image",
        {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }
    return new Response(webp, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "public, max-age=3600",
        "x-agent-graph-envelope-sha256":
          (
            await readAgentGraphManifest(paths.graphManifest)
          )?.envelopeSha256.slice(0, 16) ?? "unknown",
      },
    });
  }

  try {
    const graph = await loadAgentGraphExport(paths.graphJson);
    const n = graph.nodes.length;
    const e = graph.edges.length;
    const stats = `F402 downline — ${n} nodes, ${e} edges`;
    const jsonText = await Bun.file(paths.graphJson).text();
    const webpFile = Bun.file(paths.graphWebp);
    const webpState: "fresh" | "stale" | "missing" = !(await webpFile.exists())
      ? "missing"
      : (await isAgentGraphWebpFresh(paths))
        ? "fresh"
        : "stale";

    if (pathname === "/graph.svg") {
      return new Response(cytoscapeExportToSvg(graph), {
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      });
    }

    if (pathname === "/interactive") {
      const views = await loadFreshViews(paths);
      return html(
        interactivePage(views ? JSON.stringify(views.structural) : jsonText),
      );
    }

    if (pathname === "/capture.html") {
      // A whole-tree raster is unreadable at any layout (see agent-graph-readability.md),
      // so the WebView captures the budgeted overview view when views are fresh.
      const overview = Bun.file(join(paths.viewsDir, "overview.cy.json"));
      const useOverview =
        (await loadFreshViews(paths)) !== null && (await overview.exists());
      return html(
        renderAgentGraphCapturePage(
          useOverview ? await overview.text() : jsonText,
        ),
      );
    }

    if (pathname === "/" || pathname === "/agent-graph-view.html") {
      const svg = cytoscapeExportToSvg(graph);
      return new Response(shellPage(svg, stats, webpState), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  } catch (err) {
    return new Response(String(err), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response("Not found", { status: 404 });
}
