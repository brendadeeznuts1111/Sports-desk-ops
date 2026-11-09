import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(
  resolve(
    import.meta.dir,
    "../static/customer-churn-simulation-dashboard.html",
  ),
  "utf8",
);

/** Slice one function out by brace matching, so reformatting cannot break the assertion. */
function functionSource(signature: string): string {
  const start = html.indexOf(signature);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return html.slice(start);
}

describe("Bridge Review dashboard panel", () => {
  const renderer = functionSource("function renderBridgeReview(bridge)");

  test("renders the review section with the full contract id set", () => {
    const section = html.match(/<section[^>]*id="review-panel"[^>]*>/);
    expect(section).not.toBeNull();
    expect(section?.[0]).toContain('class="section-card"');
    expect(section?.[0]).toContain('aria-labelledby="rv-title"');
    expect(section?.[0]).toContain('aria-live="polite"');
    for (const id of [
      "rv-title",
      "rv-status",
      "rv-jobs",
      "rv-alerts",
      "rv-dispatch",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="rv-title"\s*>Bridge Review Queue<\/h2>/);
    expect(html).toMatch(/>\s*Dispatch digest\s*</);
    expect(html).toContain(
      'class="btn btn-ghost" type="button" id="rv-dispatch"',
    );
  });

  test("keeps the panel markup outside the module script", () => {
    const markupAt = html.indexOf('id="review-panel"');
    const moduleAt = html.indexOf('<script type="module">');
    expect(markupAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(markupAt);
  });

  test("dispatches the digest through authed() on the existing route", () => {
    expect(html).toContain('"/api/telegram/report?type=BRIDGE_ROLLUP_DIGEST"');
    const dispatch = html.match(
      /authed\(\s*["']\/api\/telegram\/report\?type=BRIDGE_ROLLUP_DIGEST["']\s*,\s*\{[\s\S]{0,120}?method:\s*["']POST["']/,
    );
    expect(dispatch).not.toBeNull();
    expect(html).toContain("authed(");
    expect(html).not.toMatch(/fetch\(\s*["'`]\/api/);
  });

  test("disables the dispatch button in flight and restores it in finally", () => {
    const wiring = html.slice(html.indexOf("rv-dispatch"));
    expect(wiring).toContain("button.disabled = true");
    expect(wiring).toContain("button.disabled = false");
    expect(wiring).toMatch(/finally\s*\{/);
    expect(wiring).toContain("res.status");
  });

  test("uses DOM construction and textContent, never an HTML sink", () => {
    expect(renderer.length).toBeGreaterThan(0);
    expect(renderer).toContain("textContent");
    expect(renderer).toContain("document.createElement");
    expect(renderer).toContain("replaceChildren");
    expect(renderer).toContain("No rollup cycle recorded yet");
    for (const sink of [
      "innerHTML",
      "insertAdjacentHTML",
      "outerHTML",
      "document.write",
    ])
      expect(html).not.toContain(sink);
  });

  test("renders every optional bridge field without assuming it", () => {
    for (const token of [
      "updatedAt",
      "jobs",
      "alerts",
      "durationMs",
      "severity",
      "Array.isArray",
    ])
      expect(renderer).toContain(token);
    expect(html).toContain("renderBridgeReview(payload.bridge)");
  });

  test("defines the renderer once, inside the primary module script", () => {
    expect([
      ...html.matchAll(/function renderBridgeReview\s*\(/g),
    ]).toHaveLength(1);
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const module = blocks.find((b) => b[1]?.includes("renderWeblogPanel"));
    expect(module).toBeDefined();
    expect(module?.[1]).toContain("renderBridgeReview");
    expect(module?.[1]).toContain('"rv-dispatch"');
  });

  test("calls the renderer from the KPI load after the WebLog panel", () => {
    // The KPI loader at the end of the module is the render path; an earlier
    // fetch of the same route destructures a narrower payload.
    const kpiAt = html.lastIndexOf('authed("/api/kpis"');
    expect(kpiAt).toBeGreaterThan(-1);
    const kpiBlock = html.slice(kpiAt, kpiAt + 1500);
    expect(kpiBlock).toContain("renderWeblogPanel(payload.weblog)");
    expect(kpiBlock).toContain("renderBridgeReview(payload.bridge)");
    expect(kpiBlock.indexOf("renderWeblogPanel")).toBeLessThan(
      kpiBlock.indexOf("renderBridgeReview"),
    );
  });

  test("keeps exactly two script tags", () => {
    expect([...html.matchAll(/<script\b/g)]).toHaveLength(2);
  });
});

describe("Customer Behavioral Signatures (5-Kind Pipeline) dashboard panel", () => {
  const sigRenderer = functionSource(
    "function renderCustomerSignatures(sigData)",
  );

  test("renders the customer-signatures-panel section with full contract IDs", () => {
    const section = html.match(
      /<section[^>]*id="customer-signatures-panel"[^>]*>/s,
    );
    expect(section).not.toBeNull();
    expect(section?.[0]).toContain('class="section-card"');
    expect(section?.[0]).toContain('aria-labelledby="csig-title"');
    expect(section?.[0]).toContain('aria-live="polite"');
    for (const id of [
      "csig-title",
      "csig-badge",
      "csig-stats",
      "csig-stat-legs",
      "csig-stat-customers",
      "csig-stat-priced",
      "csig-stat-multi",
      "csig-stat-capped",
      "csig-filters",
      "csig-cohorts-body",
      "csig-top-body",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("uses DOM construction and textContent, never an HTML sink", () => {
    expect(sigRenderer.length).toBeGreaterThan(0);
    expect(sigRenderer).toContain("document.createElement");
    expect(sigRenderer).toContain("textContent");
    expect(sigRenderer).toContain("replaceChildren");
    for (const kind of [
      "in_play_activity",
      "post_halftime_activity",
      "football_key_number_discipline",
      "pre_move_betting",
      "cbb_under_concentration",
    ]) {
      expect(sigRenderer).toContain(kind);
    }
  });

  test("calls renderCustomerSignatures(payload.signatures) from the KPI load after Bridge Review", () => {
    const kpiAt = html.lastIndexOf('authed("/api/kpis"');
    expect(kpiAt).toBeGreaterThan(-1);
    const kpiBlock = html.slice(kpiAt, kpiAt + 1500);
    expect(kpiBlock).toContain("renderBridgeReview(payload.bridge)");
    expect(kpiBlock).toContain("renderCustomerSignatures(payload.signatures)");
    expect(kpiBlock.indexOf("renderBridgeReview")).toBeLessThan(
      kpiBlock.indexOf("renderCustomerSignatures"),
    );
  });
});
