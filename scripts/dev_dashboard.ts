/**
 * @file scripts/dev_dashboard.ts
 * @description Native Bun-Powered Development Server for SportsDesk Dashboard.
 *
 * Implements:
 *  - Native React 18 bundling on the fly via Bun.build
 *  - Fast zero-copy file serving via Bun.file
 *  - Hot-reloading over native WebSockets for both React components and dashboard.md
 *  - Live Markdown-to-HTML rendering via Bun.markdown.html
 */

import { watch } from "node:fs";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT) || 4022;
const DASHBOARD_MD_PATH = resolve(process.cwd(), "dashboard.md");
const DASHBOARD_ENTRY_PATH = resolve(process.cwd(), "src/dashboard/index.tsx");

const clients = new Set<ServerWebSocket<unknown>>();

// Watch dashboard.md and src/dashboard for live reloading
try {
  watch(DASHBOARD_MD_PATH, () => {
    for (const ws of clients) {
      ws.send("dashboard-updated");
    }
  });

  watch(resolve(process.cwd(), "src/dashboard"), { recursive: true }, () => {
    for (const ws of clients) {
      ws.send("reload");
    }
  });
} catch (err) {
  console.warn("File watch initialized with fallback:", err);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for hot reload
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API: Real-time dashboard data parsed via Bun.markdown.html
    if (url.pathname === "/api/dashboard") {
      const file = Bun.file(DASHBOARD_MD_PATH);
      if (!(await file.exists())) {
        return Response.json(
          { error: "dashboard.md not found" },
          { status: 404 },
        );
      }

      const markdown = await file.text();
      const html = Bun.markdown.html(markdown);
      return Response.json({
        markdown,
        html,
        updatedAt: new Date().toISOString(),
      });
    }

    // Dynamic React bundle compiled on the fly via Bun.build
    if (url.pathname === "/index.js") {
      const build = await Bun.build({
        entrypoints: [DASHBOARD_ENTRY_PATH],
        target: "browser",
        sourcemap: "inline",
      });

      if (!build.success || build.outputs.length === 0) {
        console.error("Build failed:", build.logs);
        return new Response("console.error('Bundle compilation failed');", {
          status: 500,
          headers: { "Content-Type": "application/javascript" },
        });
      }

      const output = build.outputs[0];
      if (!output) {
        return new Response("Missing output", { status: 500 });
      }
      return new Response(await output.text(), {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Root SPA Shell
    if (url.pathname === "/" || !url.pathname.includes(".")) {
      const htmlShell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SportsDesk &amp; Fantasy402 Real-Time Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #070b14;
        --card: #0d1527;
        --border: #1e293b;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #38bdf8;
      }
      body {
        margin: 0;
        background-color: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        font-size: 14px;
      }
      th, td {
        padding: 10px 14px;
        border: 1px solid var(--border);
        text-align: left;
      }
      th {
        background-color: var(--card);
        color: var(--muted);
        text-transform: uppercase;
        font-size: 12px;
      }
      tr:nth-child(even) td {
        background-color: rgba(30, 41, 59, 0.4);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #f59e0b;
        background: rgba(30, 41, 59, 0.6);
        padding: 2px 6px;
        border-radius: 4px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      blockquote {
        margin: 12px 0;
        padding: 8px 16px;
        border-left: 4px solid var(--accent);
        background: rgba(13, 21, 39, 0.7);
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/index.js"></script>
  </body>
</html>`;
      return new Response(htmlShell, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {
      // noop
    },
  },
});

console.log(
  `\n🚀 SportsDesk Dashboard Dev Server listening at http://localhost:${server.port}`,
);
console.log(
  `⚡ Hot-reloading active on React components (src/dashboard/) and dashboard.md\n`,
);
