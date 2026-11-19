import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App, PRIMARY_SECTION_HASHES } from "../packages/ui/src/App.tsx";
import {
  DASHBOARD_SECTION_TABS,
  readDashboardUrlState,
} from "../packages/ui/src/url_state.ts";

/**
 * The header is a route surface, not just chrome: the brand lockup and the primary nav carry
 * hashes that resolve to views before React mounts (`readDashboardUrlState`), so a copied
 * `#system-logs` link works on a cold load. These pin the markup contract and the hash→view map.
 */

const html = renderToStaticMarkup(React.createElement(App));

describe("dashboard header", () => {
  test("is a sticky translucent surface with the telemetry dot pattern", () => {
    expect(html).toContain("<header");
    expect(html).toContain("position:sticky");
    expect(html).toContain("top:0");
    expect(html).toContain("z-index:40");
    expect(html).toContain("padding:0.75rem 1.5rem");
    expect(html).toContain("background-color:rgba(11, 15, 25, 0.92)");
    expect(html).toContain("backdrop-filter:blur(12px)");
    expect(html).toContain("border-bottom:1px solid #1e293b");
    expect(html).toContain("16px 16px");
  });

  test("the brand lockup links to Risk Overview and carries the file-loader logo", () => {
    expect(html).toContain('data-brand-lockup="true"');
    expect(html).toContain('href="#risk-overview"');
    expect(html).toContain('data-brand-logo="true"');
    // Bun's file loader resolves the import to a path string (absolute under `bun run`).
    const logo = /<img[^>]*data-brand-logo="true"[^>]*>/.exec(html)?.[0] ?? "";
    expect(logo).toContain('width="36"');
    expect(logo).toContain('height="36"');
    expect(logo).toContain("border-radius:6px");
    expect(logo).toContain("rgba(0, 240, 255, 0.12)");
    const src = /src="([^"]+)"/.exec(logo)?.[1] ?? "";
    expect(src.endsWith("logo.svg")).toBe(true);
  });

  test("the primary nav names the three views and marks the default", () => {
    expect(html).toContain('aria-label="Primary Surveillance Navigation"');
    expect(html).toContain('href="#risk-overview"');
    expect(html).toContain('href="#bettor-churn-simulation"');
    expect(html).toContain('href="#system-logs"');
    expect(html).toContain("Risk Overview");
    expect(html).toContain("Bettor Churn Simulation");
    expect(html).toContain("System Logs");
    // The configured landing tab is surveillance, so Risk Overview is current on first render.
    const risk =
      /<a[^>]*data-primary-nav="risk-overview"[^>]*>/.exec(html)?.[0] ?? "";
    expect(risk).toContain('aria-current="page"');
  });

  test("the active section anchors the main view under the sticky header", () => {
    expect(html).toContain('id="risk-overview"');
    expect(html).toContain('data-dashboard-section="risk-overview"');
    expect(html).toContain("scroll-margin-top:96px");
  });
});

describe("section hashes are routes", () => {
  test("each primary hash resolves to its view before React mounts", () => {
    expect(readDashboardUrlState("", "/", "#risk-overview").tab).toBe(
      "surveillance",
    );
    expect(readDashboardUrlState("", "/", "#bettor-churn-simulation").tab).toBe(
      "customers",
    );
    expect(readDashboardUrlState("", "/", "#system-logs").tab).toBe("terminal");
  });

  test("an explicit ?tab= still wins over a section hash", () => {
    expect(readDashboardUrlState("?tab=alerts", "/", "#system-logs").tab).toBe(
      "alerts",
    );
  });

  test("the App and the URL reader agree on the hash list", () => {
    expect(Object.keys(DASHBOARD_SECTION_TABS).sort()).toEqual(
      [...PRIMARY_SECTION_HASHES].sort(),
    );
  });
});
