import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Feature,
  FEATURES,
  BUILD_FEATURES,
  DESCRIPTIONS,
} from "../../types/features";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4025;
const DASHBOARD_HTML_PATH = path.resolve(
  __dirname,
  "../../../antigravity/brain/a35513a7-2222-4a84-aeb3-8cf9929c068f/dashboard.html",
);
const FALLBACK_HTML_PATH = path.resolve(__dirname, "dashboard.html");

// Also keep a copy colocated with the example for portability
const htmlFile = Bun.file(DASHBOARD_HTML_PATH);
const fallbackFile = Bun.file(FALLBACK_HTML_PATH);

const isFeature = (f: string): f is Feature =>
  (FEATURES as readonly string[]).includes(f);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API: Live Bun.build endpoint to demonstrate real DCE
    if (url.pathname === "/api/build" && req.method === "POST") {
      let body: { features?: unknown; target?: unknown };
      try {
        body = (await req.json()) as { features?: unknown; target?: unknown };
      } catch {
        return Response.json(
          { error: "Malformed JSON payload" },
          { status: 400 },
        );
      }

      try {
        let requestedFeatures: Feature[];
        const t = body.target;
        if (typeof t === "string" && Object.hasOwn(BUILD_FEATURES, t)) {
          requestedFeatures = [
            ...BUILD_FEATURES[t as keyof typeof BUILD_FEATURES],
          ];
        } else {
          const raw = Array.isArray(body.features)
            ? body.features.filter((x): x is string => typeof x === "string")
            : [];
          requestedFeatures = raw.filter(isFeature);
        }

        const entrypoint = path.join(__dirname, "risk_engine.ts");
        const build = await Bun.build({
          entrypoints: [entrypoint],
          features: requestedFeatures,
          minify: false,
        });

        if (!build.success) {
          return Response.json(
            { error: "Build failed", logs: build.logs },
            { status: 500 },
          );
        }

        const outputText = await build.outputs[0]?.text();
        const byteSize = outputText ? Buffer.byteLength(outputText, "utf8") : 0;

        return Response.json({
          success: true,
          features: requestedFeatures,
          byteSize,
          code: outputText,
        });
      } catch (err) {
        return Response.json(
          { error: (err as Error).message },
          { status: 500 },
        );
      }
    }

    // Serve HTML Dashboard
    if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/dashboard"
    ) {
      let content: string;
      if (await htmlFile.exists()) {
        content = await htmlFile.text();
      } else if (await fallbackFile.exists()) {
        content = await fallbackFile.text();
      } else {
        return new Response("Dashboard HTML file not found.", { status: 404 });
      }

      const canonicalConfig = `<script id="sportsdesk-ssot-config">
        window.CANONICAL_FEATURES = ${JSON.stringify(FEATURES)};
        window.CANONICAL_BUILD_FEATURES = ${JSON.stringify(BUILD_FEATURES)};
        window.CANONICAL_DESCRIPTIONS = ${JSON.stringify(DESCRIPTIONS)};
      </script>`;
      content = content.replace("</head>", `${canonicalConfig}\n</head>`);

      return new Response(content, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`SportsDesk Feature Flags Dashboard running at:`);
console.log(`  http://localhost:${server.port}`);
console.log(`\nEndpoints:`);
console.log(`  GET  /            - Interactive Generative UI Dashboard`);
console.log(`  POST /api/build   - Real-time Bun.build DCE endpoint`);
