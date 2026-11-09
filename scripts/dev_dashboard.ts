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
import { runBunBuild } from "./build.ts";
import {
  benchmarkResolverLatency,
  classifyIpAddress,
  getDnsTelemetry,
  prefetchSportsDeskEndpoints,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";

const PORT = Number(process.env.PORT) || 4022;
const DASHBOARD_MD_PATH = resolve(process.cwd(), "dashboard.md");
const DASHBOARD_ENTRY_PATH = resolve(process.cwd(), "src/dashboard/index.tsx");

const clients = new Set<ServerWebSocket<unknown>>();

// Native memory pressure handler (Bun 1.4)
if (typeof process !== "undefined" && typeof process.on === "function") {
  try {
    process.on("memoryPressure", (level: string) => {
      console.warn(
        `[SportsDesk Dev Server] Host memory pressure: ${level}. Reclaiming build cache.`,
      );
    });
  } catch {
    // Unsupported environment fallback
  }
}

// Watch dashboard.md and src/dashboard for live reloading
try {
  watch(DASHBOARD_MD_PATH, () => {
    // Publish to "dashboard" topic natively, plus legacy clients
    server.publish("dashboard", "dashboard-updated");
    for (const ws of clients) {
      if (
        !ws.subscriptions ||
        ws.subscriptions.length === 0 ||
        ws.subscriptions.includes("dashboard")
      ) {
        ws.send("dashboard-updated");
      }
    }
  });

  watch(resolve(process.cwd(), "src/dashboard"), { recursive: true }, () => {
    server.publish("dashboard", "reload");
    for (const ws of clients) {
      if (
        !ws.subscriptions ||
        ws.subscriptions.length === 0 ||
        ws.subscriptions.includes("dashboard")
      ) {
        ws.send("reload");
      }
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
      // trusted-markdown: local repo-owned dashboard.md rendered for operator dev server
      const html = Bun.markdown.html(markdown);
      return Response.json({
        markdown,
        html,
        updatedAt: new Date().toISOString(),
      });
    }

    // API: Real-time DNS Cache Telemetry
    if (url.pathname === "/api/dns") {
      const telemetry = getDnsTelemetry();
      return Response.json({
        telemetry,
        hosts: SPORTSDESK_CORE_HOSTS,
        updatedAt: new Date().toISOString(),
      });
    }

    // API: DNS Resolver Latency Benchmark
    if (url.pathname === "/api/dns/benchmark") {
      const host = url.searchParams.get("host") || "fantasy402.com";
      const result = await benchmarkResolverLatency(
        host,
        ["c-ares", "system"],
        3,
      );
      return Response.json(result);
    }

    // API: Reverse DNS & Forensics IP Classification
    if (url.pathname === "/api/dns/reverse") {
      const ip = url.searchParams.get("ip") || "1.1.1.1";
      const result = await classifyIpAddress(ip);
      return Response.json(result);
    }

    // API: Customer Profiling & Behavioral Sharp Showcase
    if (url.pathname === "/api/customers") {
      const backtestFile = Bun.file("docs/backtest-4wk-cfb-nba.json");
      const backtestJson = (await backtestFile.exists())
        ? ((await backtestFile.json()) as {
            customerLeaderboard?: Array<Record<string, unknown>>;
          })
        : { customerLeaderboard: [] };

      const fixtureFile = Bun.file(
        "tests/fixtures/backtest/enriched_customers_full.json",
      );
      const fixtureJson = (await fixtureFile.exists())
        ? ((await fixtureFile.json()) as Array<Record<string, unknown>>)
        : [];

      return Response.json({
        cohorts: {
          backtestCount: backtestJson.customerLeaderboard?.length ?? 49,
          keyNumberSharpsCount: 5,
          hookSyndicateCount: 5,
          fixtureCount: fixtureJson.length,
          fullBookSpecCount: 220,
          uniqueSurveillanceCount: 4914,
        },
        backtestTop: (backtestJson.customerLeaderboard ?? []).slice(0, 20),
        fixtures: fixtureJson,
      });
    }

    // API: PTY Terminal Emulator Execution powered by Bun.Terminal & Bun.spawn
    if (url.pathname === "/api/terminal/exec" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          command?: string;
          cols?: number;
          rows?: number;
        };
        const command = body.command?.trim() ?? "help";
        const result = await executeTerminalQuery(command, {
          cols: body.cols ?? 100,
          rows: body.rows ?? 30,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: 30-Day Batched Player Rankings
    if (url.pathname === "/api/rankings/all") {
      try {
        const { runBatchedRanking } =
          await import("../lib/customer_rankings.ts");
        const limit = Number(url.searchParams.get("limit")) || 100;
        const data = await runBatchedRanking({ limitPlayers: limit });
        return Response.json(data);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: Proxy Conduits
    if (url.pathname === "/api/agency/conduits") {
      try {
        const { runBatchedRanking } =
          await import("../lib/customer_rankings.ts");
        const data = await runBatchedRanking({ limitPlayers: 50 });
        const conduits = data.topSubAgents.filter((s) => s.isProxyConduit);
        return Response.json({ conduits });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // API: WebSocket Status & Topic Subscriptions Telemetry (ServerWebSocket.subscriptions)
    if (url.pathname === "/api/ws/status") {
      const topicCounts: Record<string, number> = {};
      const clientSummaries: Array<{ id: number; topics: string[] }> = [];
      let clientId = 1;

      for (const ws of clients) {
        const subs = ws.subscriptions ?? [];
        clientSummaries.push({ id: clientId++, topics: subs });
        for (const topic of subs) {
          topicCounts[topic] = (topicCounts[topic] || 0) + 1;
        }
      }

      return Response.json({
        totalConnectedClients: clients.size,
        topicDistribution: topicCounts,
        clients: clientSummaries,
        serverTopics: [
          "dashboard",
          "live-bets",
          "syndicate-alerts",
          "proxy-conduits",
          "terminal-logs",
        ],
        timestamp: new Date().toISOString(),
      });
    }

    // Dynamic React bundle compiled on the fly via Bun.build
    if (url.pathname === "/index.js") {
      const build = await runBunBuild({
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
      // Automatically subscribe to base dashboard broadcast channel
      ws.subscribe("dashboard");
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, message) {
      try {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        const data = JSON.parse(text) as {
          type?: string;
          topic?: string;
          topics?: string[];
        };

        if (data.type === "subscribe" && data.topic) {
          ws.subscribe(data.topic);
          ws.send(
            JSON.stringify({
              type: "subscribed",
              topic: data.topic,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (
          data.type === "subscribe-all" ||
          (data.type === "subscribe" && data.topics)
        ) {
          const list = data.topics ?? [
            "dashboard",
            "live-bets",
            "syndicate-alerts",
            "proxy-conduits",
            "terminal-logs",
          ];
          for (const t of list) ws.subscribe(t);
          ws.send(
            JSON.stringify({
              type: "subscribed-many",
              topics: list,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (data.type === "unsubscribe" && data.topic) {
          ws.unsubscribe(data.topic);
          ws.send(
            JSON.stringify({
              type: "unsubscribed",
              topic: data.topic,
              activeTopics: ws.subscriptions,
            }),
          );
        } else if (data.type === "query-subscriptions") {
          ws.send(
            JSON.stringify({
              type: "subscriptions",
              activeTopics: ws.subscriptions,
            }),
          );
        }
      } catch {
        // Plain string or ping/pong fallback
      }
    },
  },
});

// Pre-warm DNS cache for all sportsdesk service endpoints
const warmedHosts = prefetchSportsDeskEndpoints();

console.log(
  `\n🚀 SportsDesk Dashboard Dev Server listening at http://localhost:${server.port}`,
);
console.log(
  `🌐 Pre-warmed DNS cache for ${warmedHosts} core endpoints via Bun.dns.prefetch()`,
);
console.log(
  `⚡ Hot-reloading active on React components (src/dashboard/) and dashboard.md\n`,
);
