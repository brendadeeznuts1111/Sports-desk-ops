import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("WebLog dashboard panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  test("renders the five-bridge status bar and Mode 6 panel", () => {
    for (const id of [
      "weblog-panel",
      "bridge-status",
      "bridge-1-status",
      "bridge-3a-status",
      "bridge-3b-status",
      "bridge-3c-status",
      "weblog-status",
      "wl-gates",
      "wl-matched",
      "wl-quantiles",
      "wl-flags",
      "wl-net-table",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<th scope="col">Class</th>');
  });

  test("reads the rollup from the existing authed KPI route", () => {
    expect(html).toContain('authed("/api/kpis"');
    expect(html).not.toContain('fetch("/api/weblog');
    expect(html).not.toContain("/api/weblog/latest");
  });

  test("keeps all JS changes in the primary script block", () => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const withPanel = blocks.filter((b) => b[1]?.includes("wl-net-table"));
    expect(withPanel).toHaveLength(1);
    expect(withPanel[0]?.[1]).toContain('document.getElementById("live-desk")');
  });

  test("defaults the bridge socket to the same-origin guarded route", () => {
    const bridgeMeta = html.match(
      /<meta[^>]*name="sportsdesk-bridge-ws"[^>]*>/,
    );
    expect(bridgeMeta).not.toBeNull();
    // Empty content = same origin, no separate host to configure.
    expect(bridgeMeta?.[0]).toContain('content=""');
    expect(html).toContain('id="bridge-ws-state"');
    expect(html).toContain('"/api/live-bets"');
    // The bearer cannot be a header on a browser handshake, so it rides the subprotocol list.
    expect(html).toContain("sportsdesk.bridge.v1");
    expect(html).toContain('"bearer-" + token');
    expect(html).not.toContain("/api/weblog");
  });

  test("subscribes to the five bridge topics", () => {
    for (const topic of [
      "wagers-by-state",
      "f402-bet-ticker",
      "f402-pending",
      "gslive-tally",
      "f402-weblog",
    ])
      expect(html).toContain(`"${topic}"`);
    expect(html).toContain('type: "SUBSCRIBE"');
    expect(html).toContain("channel: topic");
  });

  test("applies the acknowledged subscriptions to the bridge badges", () => {
    expect(html).toContain("msg.subscriptions");
    expect(html).toContain("Array.isArray(msg.subscriptions)");
    expect(html).toContain("BRIDGE_BADGE_IDS");
    expect(html).toContain("WS: subscribed ${active.size}/5");
    expect(html).toContain('" · ws"');
  });

  test("renders Mode 6 through one shared renderer on both paths", () => {
    const definitions = [...html.matchAll(/function renderWeblogPanel\s*\(/g)];
    expect(definitions).toHaveLength(1);
    expect(html).toContain("renderWeblogPanel(payload.weblog)");
    expect(html).toContain("renderWeblogPanel(msg)");
  });

  test("uses no HTML sinks and only the authed KPI route", () => {
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("insertAdjacentHTML");
    expect(html).not.toContain("outerHTML");
    expect(html).not.toContain("document.write");
    expect(html).not.toMatch(/fetch\(\s*["']\/api\//);
    expect(html).not.toContain("/api/weblog");
  });

  test("keeps exactly two script tags and hosts the WS client in the module", () => {
    expect([...html.matchAll(/<script\b/g)]).toHaveLength(2);
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const module = blocks.find((b) => b[1]?.includes("BRIDGE_TOPICS"));
    expect(module).toBeDefined();
    expect(module?.[1]).toContain("renderWeblogPanel");
  });
});
