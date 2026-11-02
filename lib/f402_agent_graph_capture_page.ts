/**
 * Headless capture page for Cytoscape layout → WebView screenshot.
 * Sets `window.__AGENT_GRAPH_READY__` after `layoutstop`.
 */

import { envPositiveInt } from "./env.ts";

/**
 * Ready timeout, read and validated once at the boundary.
 *
 * `Number(Bun.env.X ?? 30000)` yields NaN for a malformed value, and `Date.now() > NaN` is false
 * forever — the promise then never rejects and the capture hangs until the outer timeout. The
 * value is interpolated into page-evaluated JS, so it must be a number, not a raw string.
 */
const AGENT_GRAPH_CAPTURE_TIMEOUT_MS = envPositiveInt(
  "F402_GRAPH_CAPTURE_TIMEOUT_MS",
  30_000,
);

export const AGENT_GRAPH_READY_GLOBAL = "__AGENT_GRAPH_READY__" as const;

/** Expression evaluated in-page; resolves when the graph layout finishes. */
export const AGENT_GRAPH_READY_EVAL = `(new Promise((resolve, reject) => {
  const deadline = Date.now() + ${AGENT_GRAPH_CAPTURE_TIMEOUT_MS};
  const check = () => {
    if (window.${AGENT_GRAPH_READY_GLOBAL}) return resolve(true);
    if (Date.now() > deadline) return reject(new Error("agent graph ready timeout"));
    requestAnimationFrame(check);
  };
  check();
}))`;

/** Script tags for the layout stack; served by the graph viewer from node_modules. */
export const AGENT_GRAPH_LAYOUT_SCRIPTS = `<script src="/cytoscape.min.js"></script>
  <script src="/elk.bundled.js"></script>
  <script src="/cytoscape-elk.js"></script>`;

/**
 * Browser-side helpers: `agentGraphStyle()` and `agentGraphLayout(cy)`.
 * ELK mrtree (left→right) when cytoscape-elk loaded, else breadthfirst from roots.
 */
export const AGENT_GRAPH_CLIENT_JS = `
    function agentGraphStyle() {
      return [
        { selector: "node", style: {
          shape: "round-rectangle",
          label: "data(label)",
          "background-color": function (n) { return n.data("color") || "#56B4E9"; },
          color: "#0b1220",
          "text-valign": "center",
          "text-halign": "center",
          "font-size": 11,
          "text-wrap": "wrap",
          width: function (n) {
            var longest = String(n.data("label")).split("\\n").reduce(function (m, s) { return Math.max(m, s.length); }, 0);
            return Math.max(48, longest * 7 + 16);
          },
          height: function (n) { return 10 + 14 * String(n.data("label")).split("\\n").length; },
        }},
        { selector: "node[overflow > 0]", style: { "border-width": 3, "border-color": "#D55E00" } },
        { selector: "edge", style: {
          width: 1,
          "line-color": "#64748b",
          "target-arrow-color": "#64748b",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.6,
          "curve-style": "taxi",
          "taxi-direction": "rightward",
        }},
      ];
    }
    function agentGraphLayout(cy) {
      if (typeof cytoscapeElk === "function") {
        if (!window.__agentGraphElkRegistered) {
          cytoscape.use(cytoscapeElk);
          window.__agentGraphElkRegistered = true;
        }
        return cy.layout({
          name: "elk",
          fit: true,
          padding: 24,
          elk: { algorithm: "mrtree", "elk.direction": "RIGHT", "elk.spacing.nodeNode": 6 },
        });
      }
      return cy.layout({ name: "breadthfirst", directed: true, roots: cy.nodes().roots(), fit: true, padding: 24 });
    }
`;

export function renderAgentGraphCapturePage(graphJsonText: string): string {
  const safeJson = graphJsonText.replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Agent graph capture</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #0b1220; overflow: hidden; }
    #cy { width: 100vw; height: 100vh; }
  </style>
  ${AGENT_GRAPH_LAYOUT_SCRIPTS}
</head>
<body>
  <div id="cy"></div>
  <script type="application/json" id="graph-data">${safeJson}</script>
  <script>
    window.${AGENT_GRAPH_READY_GLOBAL} = false;
    ${AGENT_GRAPH_CLIENT_JS}
    (function () {
      if (typeof cytoscape !== "function") {
        window.${AGENT_GRAPH_READY_GLOBAL} = true;
        return;
      }
      var graph = JSON.parse(document.getElementById("graph-data").textContent);
      var elements = (graph.nodes || []).concat(graph.edges || []);
      var cy = cytoscape({
        container: document.getElementById("cy"),
        elements: elements,
        style: agentGraphStyle(),
      });
      if (elements.length === 0) {
        window.${AGENT_GRAPH_READY_GLOBAL} = true;
      } else {
        var layout = agentGraphLayout(cy);
        layout.one("layoutstop", function () {
          window.${AGENT_GRAPH_READY_GLOBAL} = true;
        });
        layout.run();
      }
    })();
  </script>
</body>
</html>`;
}
