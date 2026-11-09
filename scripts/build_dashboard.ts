/**
 * @file scripts/build_dashboard.ts
 * @description Production Builder for SportsDesk Dashboard using Bun.build.
 *
 * Compiles React 18 frontend into static assets without Webpack, Vite, or external bundlers.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT_DIR = resolve(process.cwd(), "dist/dashboard");
const DASHBOARD_ENTRY_PATH = resolve(process.cwd(), "src/dashboard/index.tsx");

mkdirSync(OUT_DIR, { recursive: true });

const start = performance.now();
const result = await Bun.build({
  entrypoints: [DASHBOARD_ENTRY_PATH],
  outdir: OUT_DIR,
  target: "browser",
  minify: true,
  naming: "[name]-[hash].[ext]",
  sourcemap: "external",
});

if (!result.success) {
  console.error("❌ Dashboard build failed:", result.logs);
  process.exit(1);
}

const jsArtifact = result.outputs.find((o) => o.path.endsWith(".js"));
const jsFileName = jsArtifact ? jsArtifact.path.split("/").pop() : "index.js";

const htmlContent = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SportsDesk &amp; Fantasy402 Dashboard (Production)</title>
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
    <script type="module" src="./${jsFileName}"></script>
  </body>
</html>`;

await Bun.write(resolve(OUT_DIR, "index.html"), htmlContent);

const elapsed = (performance.now() - start).toFixed(2);
console.log(`\n✅ Production build completed in ${elapsed}ms:`);
for (const artifact of result.outputs) {
  const sizeKb = (artifact.size / 1024).toFixed(1);
  console.log(`   📦 ${artifact.path} (${sizeKb} KB)`);
}
console.log(`   📄 ${resolve(OUT_DIR, "index.html")}\n`);
