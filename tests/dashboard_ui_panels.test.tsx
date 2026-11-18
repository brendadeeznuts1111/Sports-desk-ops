import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { FEATURES } from "@sportsdesk-ops/contracts";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../packages/ui/src/App.tsx";
import { renderAnsiReact } from "../packages/ui/src/ansi.tsx";
import * as uiBarrel from "../packages/ui/src/index.ts";
import {
  AlertAuditDetail,
  AlertsTabPanel,
  ApiUsageCard,
  BetTickerTabPanel,
  buildRegistryRootCss,
  BuildMatrixDrawer,
  CustomersTabPanel,
  HOUDINI_TOKENS,
  LiveWagersTabPanel,
  R2PipelineTabPanel,
  RankingsTabPanel,
  ShiftHandoffModal,
  SurveillanceTabPanel,
  TerminalTabPanel,
  TOKEN_ALIAS_SPECS,
} from "../packages/ui/src/panels/index.tsx";
import { DASHBOARD_META } from "../packages/ui/src/config/dashboard.ts";
import { TERMINAL_WELCOME_HELP_STDOUT } from "../packages/ui/src/terminal_catalog.ts";
import type {
  LiveWager,
  TerminalHistoryEntry,
} from "../packages/ui/src/types.ts";
import {
  CANONICAL_TOKENS,
  TOKEN_ALIASES,
  TOKENS_TOML_VERSION,
} from "../packages/ui/src/tokens.registry.generated.ts";
import { backtestRowsToProfiles } from "../packages/ui/src/profile_rows.ts";
import {
  beginApiCall,
  endApiCall,
  resetApiUsage,
} from "../packages/ui/src/api_usage.ts";
import {
  FIXTURE_LIVE_WAGERS,
  FIXTURE_PROFILE_CUSTOMERS,
  FIXTURE_RANKINGS,
} from "./fixtures/dashboard_ui_fixtures.ts";

describe("@sportsdesk-ops/ui modular App & panels (renderToStaticMarkup)", () => {
  test("App renders orchestrator header, tabs, and customer panel without runtime error", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("SportsDesk &amp; Fantasy402 Operations");
    expect(html).toContain("autoExecute: false");
    expect(html).toContain(`tokens.toml v${TOKENS_TOML_VERSION}`);
    expect(html).toContain(`dashboard.toml v${DASHBOARD_META.version}`);
    expect(html).toContain("Profiles (—)");
    expect(html).toContain("Downlines (—)");
    expect(html).toContain("Live Wagers (0)");
    expect(html).toContain("No live profile source yet");
    expect(html).toContain("Desk Quick-Jump:");
    expect(html).toContain('data-desk-quickjump="active-risk"');
    expect(html).toContain("NFL 1H Pregame");
    expect(html).toContain("BookDeskOps tokens");
    expect(html).toContain("NCAAB Slice");
    expect(html).toContain("GSLIVE (0)");
    expect(html).toContain("GS Builder (0)");
    expect(html).toContain("Figure-Date Audit: BRT106");
    expect(html).toContain('data-quickjump-feed-age="true"');
    expect(html).toContain('data-quickjump-feed="true"');
    expect(html).toContain("feed: Pending Hydration · pending");
    expect(html).toContain('data-desk-quickjump="copy-link"');
    expect(html).toContain("⧉ Copy link");
    expect(html).toContain('data-copy-view-link="true"');
    expect(html).toContain("⧉ Copy view");
    // Default SSR view: reset is only offered when the view is non-default.
    expect(html).not.toContain('data-reset-view="true"');
    expect(html).not.toContain("GP301");
    expect(html).not.toContain("+$76,950");
  });

  test("BuildMatrixDrawer renders sentinel, Houdini tokens, DCE flags, delta vs dev, and active target", () => {
    const rows = [
      {
        target: "prod",
        features: ["PROD", "ANALYTICS"],
        totalJsBytes: 40960,
        totalCssBytes: 8192,
        hasDebugSentinel: false,
        hasExperimentalSentinel: false,
        hasProdSentinel: true,
      },
      {
        target: "dev",
        features: ["DEBUG", "TEST", "ANALYTICS", "EXPERIMENTAL"],
        totalJsBytes: 81920,
        totalCssBytes: 8192,
        hasDebugSentinel: true,
        hasExperimentalSentinel: true,
        hasProdSentinel: false,
      },
    ] as const;
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_PROD_TARGET_ACTIVE]",
        loading: false,
        target: "prod",
        enabledFeatures: ["PROD", "ANALYTICS"],
        error: null,
        onRefresh: () => {},
        rows,
      }),
    );
    expect(html).toContain("[DCE_PROD_TARGET_ACTIVE]");
    expect(html).toContain("Active Target: prod");
    expect(html).toContain(`Flags (2/${FEATURES.length} enabled)`);
    expect(html).toContain(`All Tokens (${HOUDINI_TOKENS.length})`);
    expect(html).toContain("Obsidian: --sd-surface-bg");
    expect(html).toContain("Elevated: --sd-surface-elevated");
    expect(html).toContain("CLI: --sd-surface-cli");
    expect(html).toContain("Pending R01: --sd-route-pending");
    expect(html).toContain("#070b14");
    expect(html).toContain("40.0 KB");
    expect(html).toContain("-40.0 KB (-50.0%)");
    expect(html).toContain("ACTIVE");
    expect(html).toContain("ANALYTICS");
    expect(html).toContain("✅ Kept");
    expect(html).toContain("✂️ Pruned (DCE)");
    expect(html).toContain(
      "prod ships 40.0 KB less JS than dev (50.0% smaller) by pruning DEBUG + TEST + EXPERIMENTAL",
    );
    expect(html).toContain(
      `sentinels ${rows.length * 3}/${rows.length * 3} match the flags each target enables`,
    );
    expect(html).toContain("Copy registry");
    expect(html).toContain('data-matrix-table="true"');
    expect(html).toContain('id="build-matrix-table"');
    expect(html).toContain('data-matrix-copy-table="true"');
    expect(html).toContain("⧉ Copy matrix");
    expect(html).toContain('data-matrix-jump="table"');
    expect(html).toContain('data-matrix-copy-row="prod"');
    expect(html).toContain('data-matrix-flag="PROD"');
    expect(html).toContain('data-matrix-flag="ANALYTICS"');
    expect(html).toContain("Production-only code paths.");
    expect(html).not.toContain('data-matrix-flag-unknown="true"');
    expect(html).toContain(
      `${HOUDINI_TOKENS.length}/${HOUDINI_TOKENS.length} tokens`,
    );
    const slaTokens = HOUDINI_TOKENS.filter((token) => token.axis === "sla");
    expect(slaTokens.length).toBeGreaterThan(0);
    expect(html).toContain(`SLA Fresh→Poison (${slaTokens.length})`);
    expect(html).toContain("--sd-sla-fresh");
    expect(html).toContain(
      `${TOKEN_ALIAS_SPECS.length}/${TOKEN_ALIAS_SPECS.length} aliases`,
    );
    const stateAlias = TOKEN_ALIAS_SPECS.find(
      (alias) => alias.alias === "--sd-state-ok",
    );
    expect(stateAlias?.target).toBe("--sd-tier-whale");
    expect(html).toContain("--sd-state-ok ← --sd-tier-whale");
  });

  test("BuildMatrixDrawer flags an unregistered bun:bundle flag instead of listing it as known", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_PROD_TARGET_ACTIVE]",
        loading: false,
        target: "prod",
        enabledFeatures: ["PROD", "TURBO"],
        error: null,
        rows: [
          {
            target: "prod",
            features: ["PROD", "TURBO"],
            totalJsBytes: 40960,
            totalCssBytes: 8192,
            hasDebugSentinel: false,
            hasExperimentalSentinel: false,
            hasProdSentinel: true,
          },
        ],
      }),
    );
    expect(html).toContain('data-matrix-flag="TURBO"');
    expect(html).toContain('data-matrix-flag-unknown="true"');
    expect(html).toContain("⚠ TURBO");
    expect(html).toContain(
      "Not a registered bun:bundle feature — check the probe payload.",
    );
  });

  test("BuildMatrixDrawer marks an unbundled runtime as unpruned instead of claiming DCE", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_UNBUNDLED_HMR]",
        loading: false,
        target: "unbundled-hmr",
        enabledFeatures: [],
        error: null,
        rows: null,
      }),
    );
    expect(html).toContain("Active Target: unbundled-hmr");
    expect(html).toContain("no branch is eliminated");
    expect(html).toContain(`Flags (0/${FEATURES.length} enabled)`);
    expect(html).not.toContain("✂️");
  });

  test("BuildMatrixDrawer flags a sentinel that contradicts the flags its row was built with", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_DEBUG_TRACE_ACTIVE]",
        loading: false,
        target: "dev",
        enabledFeatures: ["DEBUG"],
        error: null,
        rows: [
          {
            target: "prod",
            features: ["PROD", "ANALYTICS"],
            totalJsBytes: 2048,
            totalCssBytes: 1024,
            hasProdSentinel: false,
            hasDebugSentinel: false,
            hasExperimentalSentinel: false,
          },
        ],
      }),
    );
    expect(html).toContain("1 sentinel mismatch");
    expect(html).toContain("sentinels 2/3");
    expect(html).toContain("prod: PROD expected kept");
  });

  test("Build-Matrix renders every canonical token from the generated registry", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_UNBUNDLED_HMR]",
        loading: false,
        rows: null,
        target: "unbundled-hmr",
        enabledFeatures: [],
        error: null,
      }),
    );
    const missing = CANONICAL_TOKENS.filter(
      (token) => !html.includes(token.token),
    ).map((token) => token.token);
    expect(missing).toEqual([]);
    const missingAliases = TOKEN_ALIASES.filter(
      (alias) => !html.includes(alias.alias),
    ).map((alias) => alias.alias);
    expect(missingAliases).toEqual([]);
    // Every alias resolves to a palette token, so its chips inherit an axis.
    expect(TOKEN_ALIAS_SPECS.every((alias) => alias.axis !== "unmapped")).toBe(
      true,
    );
  });

  test("Build-Matrix Copy registry reproduces the generated :root block", () => {
    const css = readFileSync(
      resolve(import.meta.dir, "..", "src/dashboard/tokens.generated.css"),
      "utf-8",
    );
    const start = css.indexOf(":root {");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = css.indexOf("\n}", start) + 2;
    const normalize = (text: string): string =>
      text.replace(/\s+$/gm, "").trimEnd();
    expect(normalize(buildRegistryRootCss())).toBe(
      normalize(css.slice(start, end)),
    );
  });

  test("BuildMatrixDrawer surfaces probe freshness and marks an old payload stale", () => {
    const fresh = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_UNBUNDLED_HMR]",
        loading: false,
        target: "unbundled-hmr",
        enabledFeatures: [],
        error: null,
        rows: [],
        generatedAt: new Date().toISOString(),
        compiledMs: 1234,
      }),
    );
    expect(fresh).toContain("🕒 Probe");
    expect(fresh).toContain("1234 ms");
    expect(fresh).not.toContain("Stale probe");

    const stale = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_UNBUNDLED_HMR]",
        loading: false,
        target: "unbundled-hmr",
        enabledFeatures: [],
        error: null,
        rows: [],
        generatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      }),
    );
    expect(stale).toContain("⚠ Stale probe");
  });

  test("BuildMatrixDrawer renders 5-flag sentinels, gzip bytes, inputs/hash, and staticDir probe strip", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuildMatrixDrawer, {
        dceMarker: "[DCE_PROD_TARGET_ACTIVE]",
        activeSentinels: [
          "[DCE_PROD_TARGET_ACTIVE]",
          "[DCE_ANALYTICS_TELEMETRY_ACTIVE]",
        ],
        loading: false,
        target: "prod",
        enabledFeatures: ["PROD", "ANALYTICS"],
        error: null,
        rows: [
          {
            target: "prod",
            features: ["PROD", "ANALYTICS"],
            totalJsBytes: 40960,
            totalCssBytes: 8192,
            gzipJsBytes: 12288,
            inputFileCount: 14,
            bundleHash8: "c7156202",
            hasProdSentinel: true,
            hasDebugSentinel: false,
            hasTestSentinel: false,
            hasAnalyticsSentinel: true,
            hasExperimentalSentinel: false,
          },
        ],
        staticDir: {
          wildcardPath: "/static/*",
          dir: "/repo/static",
          caseInsensitiveHostFs: true,
          totalFiles: 5,
          totalBytes: 327680,
          files: [],
          liveCheck: {
            origin: "http://127.0.0.1:4022",
            elapsedMs: 1.2,
            allPassed: true,
            etag: 'W/"100-abc"',
            contentRange: "bytes 0-9/100",
            checks: [
              {
                name: "GET 200",
                requestPath: "/static/status.html",
                expectedStatus: 200,
                status: 200,
                ok: true,
                detail: "text/html",
              },
            ],
          },
        },
      }),
    );
    expect(html).toContain("TEST Branch");
    expect(html).toContain("ANALYTICS Branch");
    expect(html).toContain("12.0 KB gz");
    expect(html).toContain("Inputs / Hash");
    expect(html).toContain("14 · c7156202");
    expect(html).toContain("sentinels 5/5 match the flags each target enables");
    expect(html).toContain('data-static-dir-probe="true"');
    expect(html).toContain("/_dev/serve-local/bun-directory");
    expect(html).toContain("Inspect in BookDeskOps");
  });

  test("CustomersTabPanel renders customer table, radars, and inspector actions", () => {
    const cust = FIXTURE_PROFILE_CUSTOMERS[0]!;
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: false,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: FIXTURE_PROFILE_CUSTOMERS,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: cust,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerReverseForensics: {
          ipAddress: "146.190.10.20",
          hostnames: ["cpe-146-190-10-20.tx.res.rr.com"],
          primaryHostname: "cpe-146-190-10-20.tx.res.rr.com",
          isDatacenterOrCloud: false,
          isVpnOrProxySuspicious: false,
          organization: "Spectrum Residential",
          egressCategory: "RESIDENTIAL",
          classificationLabel: "RESIDENTIAL",
          riskEmphasis: "NORMAL",
          deskNote: "Datacenter check clean",
        },
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    expect(html).toContain(
      `Profiled Bettors (${FIXTURE_PROFILE_CUSTOMERS.length})`,
    );
    expect(html).toContain("Avg Sharp:");
    expect(html).toContain("Alerts");
    expect(html).toContain("Σ VaR (");
    expect(html).toContain(`#1 / ${FIXTURE_PROFILE_CUSTOMERS.length}`);
    expect(html).toContain("← Prev");
    expect(html).toContain("Next →");
    expect(html).toContain("VaR / Max Cap:");
    expect(html).toContain("Pending…");
    expect(html).not.toContain("49 Accounts");
    expect(html).not.toContain("4,914 IDs");
    expect(html).toContain("Decomposed Sharpness Radars");
    expect(html).toContain("Golden Punter Syndicate Seat 1");
    expect(html).toContain("Datacenter check clean");

    const emptyHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: noop,
        kpisCollapsed: true,
        onToggleKpis: noop,
        searchQuery: "NONEXISTENT",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: [],
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: null,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerReverseForensics: {
          ipAddress: "146.190.10.20",
          hostnames: ["cpe-146-190-10-20.tx.res.rr.com"],
          primaryHostname: "cpe-146-190-10-20.tx.res.rr.com",
          isDatacenterOrCloud: false,
          isVpnOrProxySuspicious: false,
          organization: "Spectrum Residential",
          egressCategory: "RESIDENTIAL",
          classificationLabel: "RESIDENTIAL",
          riskEmphasis: "NORMAL",
          deskNote: "Datacenter check clean",
        },
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    expect(emptyHtml).toContain("No profiled bettors match current filters.");
    expect(emptyHtml).toContain("Reset filters");

    const brt106 = FIXTURE_PROFILE_CUSTOMERS.find((c) => c.id === "BRT106")!;
    expect(brt106).toBeDefined();
    const brtHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: false,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: FIXTURE_PROFILE_CUSTOMERS,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: brt106,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerReverseForensics: {
          ipAddress: "146.190.10.20",
          hostnames: ["cpe-146-190-10-20.tx.res.rr.com"],
          primaryHostname: "cpe-146-190-10-20.tx.res.rr.com",
          isDatacenterOrCloud: false,
          isVpnOrProxySuspicious: false,
          organization: "Spectrum Residential",
          egressCategory: "RESIDENTIAL",
          classificationLabel: "RESIDENTIAL",
          riskEmphasis: "NORMAL",
          deskNote: "Datacenter check clean",
        },
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
        onViewCustomerWagers: noop,
      }),
    );
    expect(brtHtml).toContain(
      "Cross-Endpoint Portal &amp; Figure-Date Reconciliation",
    );
    expect(brtHtml).toContain("CREDIT &amp; CARRYOVER BALANCED (0¢ DELTA)");
    expect(brtHtml).toContain("LINE_MOVER_WEIGHT_ACTIVE");
    expect(brtHtml).toContain("BETTING_ALERTS_DISABLED");
    expect(brtHtml).toContain("⚡ Wager Tape");
  });

  test("CustomersTabPanel explains a lookup outside the curated cohort", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "BRT5229",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: [],
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: null,
        onSelectCustomer: noop,
        customerLookupNotice: "BRT5229",
        onClearCustomerLookupNotice: noop,
        copiedCliId: null,
        onCopyCli: noop,
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    expect(html).toContain('data-customer-lookup-notice="BRT5229"');
    expect(html).toContain("No curated cohort profile for");
    expect(html).toContain("Open terminal profile");
    expect(html).toContain("Dismiss");
  });

  test("CustomersTabPanel renders cohort provenance, row source, and unknown fields as dashes", () => {
    const noop = () => {};
    const [row] = backtestRowsToProfiles([
      {
        customerId: "MJ102",
        agentId: "MJ2026",
        masterAgent: "BILLY666",
        contextType: "EXECUTION_SNIPER",
        sharpScore: 91.4,
        avgClvBps: 295,
        totalParlayTickets: 62,
        totalParlayHandleUsd: 310000,
        ipSubnet: "104.28.34.0/24",
      },
    ]);
    const html = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: noop,
        kpisCollapsed: true,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: row ? [row] : [],
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: null,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerReverseForensics: {
          ipAddress: "146.190.10.20",
          hostnames: ["cpe-146-190-10-20.tx.res.rr.com"],
          primaryHostname: "cpe-146-190-10-20.tx.res.rr.com",
          isDatacenterOrCloud: false,
          isVpnOrProxySuspicious: false,
          organization: "Spectrum Residential",
          egressCategory: "RESIDENTIAL",
          classificationLabel: "RESIDENTIAL",
          riskEmphasis: "NORMAL",
          deskNote: "Datacenter check clean",
        },
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
        profilesUnavailableReason: null,
        profilesProvenance:
          "1 cohort customers · 0 fixture rows + 1 backtest rows · test · GET /api/customers",
      }),
    );
    expect(html).toContain('data-profiles-source="cohort"');
    expect(html).toContain(
      "1 cohort customers · 0 fixture rows + 1 backtest rows",
    );
    expect(html).toContain("BACKTEST");
    expect(html).toContain("MJ102");
    // VaR, correlation and cap were never measured for a parlay-cohort row.
    expect(html).toContain("Σ VaR (0/1)");
    expect(html).toContain("Σ Caps (0/1)");
    expect(html).toContain("Cap: —");
    expect(html).not.toContain("No live profile source yet");
  });

  test("SurveillanceTabPanel renders DNS telemetry, benchmark controls, and markdown/html view", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: {
          telemetry: {
            size: 4,
            hitRatePercent: 98.5,
            cacheHitsCompleted: 120,
            cacheHitsInflight: 3,
            cacheMisses: 2,
            defaultTtlSeconds: 30,
            errors: 0,
            totalCount: 125,
          },
          coreHosts: [
            {
              hostname: "fantasy402.com",
              port: 443,
              serviceName: "Fantasy402 Manager Portal",
            },
          ],
          generatedAt: "2026-11-13T12:34:56Z",
        },
        onRefreshDns: noop,
        benchLoading: false,
        benchResult: "c-ares: 1.2ms",
        onRunBenchmark: noop,
        reverseIp: "1.1.1.1",
        onReverseIpChange: noop,
        reverseForensics: {
          ipAddress: "1.1.1.1",
          hostnames: ["one.one.one.one"],
          primaryHostname: "one.one.one.one",
          isDatacenterOrCloud: true,
          isVpnOrProxySuspicious: false,
          organization: "Cloudflare Edge",
          egressCategory: "KNOWN_PUBLIC_DNS",
          classificationLabel: "DATACENTER / VPN",
          riskEmphasis: "HIGH_RISK",
          deskNote: "Known public DNS resolver",
        },
        onRunReverseLookup: noop,
        viewMode: "raw",
        onViewModeChange: noop,
        data: {
          markdown: "# Live Desk Status",
          html: "<h1>Live Desk Status</h1>",
          updatedAt: "2026-11-12T00:00:00Z",
        },
      }),
    );
    expect(html).toContain("WARM");
    expect(html).toContain("4/256");
    expect(html).toContain("1.6%");
    expect(html).toContain("98.5%");
    expect(html).toContain("Lookups:");
    expect(html).toContain("125");
    expect(html).toContain("2% coalesced");
    expect(html).toContain("12:34:56 UTC");
    expect(html).toContain("Prefetched Hosts (1)");
    expect(html).toContain("↻ Refresh");
    expect(html).toContain("c-ares: 1.2ms");
    expect(html).toContain('data-reverse-dns-forensics="true"');
    expect(html).toContain("Suspicious Proxy  : NO");
    expect(html).toContain("📝 Surveillance Brief");
    expect(html).toContain("native markdown");
    expect(html).toContain("⧉ Copy MD");
    expect(html).toContain("# Live Desk Status");
  });

  test("SurveillanceTabPanel renders interactive markdown brief telemetry, outline toggle, and sd-markdown-doc wrapper", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: null,
        benchLoading: false,
        benchResult: null,
        onRunBenchmark: noop,
        reverseIp: "1.1.1.1",
        onReverseIpChange: noop,
        reverseForensics: null,
        onRunReverseLookup: noop,
        viewMode: "interactive",
        onViewModeChange: noop,
        data: {
          markdown:
            "# 📊 SportsDesk\n\n> Live Risk Telemetry · Desk Hotline\n\n## 🎯 Top Sharps\n\n| A | B |\n| - | - |\n| 1 | 2 |",
          html: '<h1 id="sportsdesk">📊 SportsDesk</h1><blockquote><p>Live Risk Telemetry · Desk Hotline</p></blockquote><h2 id="top-sharps">🎯 Top Sharps</h2><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
          renderDurationMs: 0.42,
          updatedAt: "2026-11-12T08:15:30Z",
        },
      }),
    );
    expect(html).toContain("sd-markdown-doc");
    expect(html).toContain("#ids");
    expect(html).toContain("Outline (1)");
    expect(html).toContain("3 glyphs");
    expect(html).toContain("0.42 ms");
    expect(html).toContain("08:15:30 UTC");
    expect(html).toContain("Tables:");
  });

  test("SurveillanceTabPanel renders DNS error badge and refresh warning when degraded", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: {
          telemetry: {
            size: 6,
            hitRatePercent: 40,
            cacheHitsCompleted: 4,
            cacheHitsInflight: 0,
            cacheMisses: 6,
            defaultTtlSeconds: 30,
            errors: 2,
          },
        },
        dnsRefreshing: true,
        dnsError: "HTTP 503",
        onRefreshDns: noop,
        benchLoading: false,
        benchResult: null,
        onRunBenchmark: noop,
        reverseIp: "1.1.1.1",
        onReverseIpChange: noop,
        reverseForensics: null,
        onRunReverseLookup: noop,
        viewMode: "interactive",
        onViewModeChange: noop,
        data: null,
      }),
    );
    expect(html).toContain("2 ERR");
    expect(html).toContain("Refreshing...");
    expect(html).toContain("DNS refresh warning: HTTP 503");
  });

  test("TerminalTabPanel renders PTY window, quick chips, and ANSI history", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(TerminalTabPanel, {
        terminalCategory: "ALL",
        onTerminalCategoryChange: noop,
        terminalHistory: [
          {
            command: "help",
            stdout: TERMINAL_WELCOME_HELP_STDOUT,
            exitCode: 0,
            durationMs: 2,
            timestamp: 1700000000000,
          },
        ],
        onClearHistory: noop,
        copiedTerminalIdx: null,
        onCopyOutput: noop,
        copiedCommandIdx: null,
        onCopyCommand: noop,
        terminalLoading: false,
        terminalBottomRef: { current: null },
        terminalCommand: "p GP301",
        onTerminalCommandChange: noop,
        commandHistory: ["help"],
        historyIndex: -1,
        onHistoryIndexChange: noop,
        onAutocomplete: noop,
        onRunCommand: noop,
      }),
    );
    expect(html).toContain("PTY Engine Ready");
    expect(html).toContain(
      "SPORTSDESK &amp; FANTASY402 INTERACTIVE PTY TERMINAL",
    );
    expect(html).toContain("Run (PTY)");
    expect(html).toContain("↻ Rerun");
    expect(html).toContain("⧉ cmd");
    expect(html).toContain("exit 0");
    expect(html).toContain("Clear Screen");
    expect(html).toContain('data-terminal-filter="true"');
    expect(html).toContain("⤓ Export");
    expect(html).toContain("⏱ 1 run · p50 2ms");
  });

  test("TerminalTabPanel surfaces inline suggestions, run stats and failure counts", () => {
    const noop = () => {};
    const renderPanel = (
      terminalCommand: string,
      terminalHistory: readonly TerminalHistoryEntry[],
    ) =>
      renderToStaticMarkup(
        React.createElement(TerminalTabPanel, {
          terminalCategory: "ALL",
          onTerminalCategoryChange: noop,
          terminalHistory,
          onClearHistory: noop,
          copiedTerminalIdx: null,
          onCopyOutput: noop,
          copiedCommandIdx: null,
          onCopyCommand: noop,
          terminalLoading: false,
          terminalBottomRef: { current: null },
          terminalCommand,
          onTerminalCommandChange: noop,
          commandHistory: ["help"],
          historyIndex: -1,
          onHistoryIndexChange: noop,
          onAutocomplete: noop,
          onRunCommand: noop,
        }),
      );

    const history: readonly TerminalHistoryEntry[] = [
      {
        command: "risk",
        stdout: "\x1b[1mCRITICAL\x1b[0m hold 91%",
        exitCode: 1,
        durationMs: 12,
        timestamp: 1700000000000,
      },
      {
        command: "help",
        stdout: TERMINAL_WELCOME_HELP_STDOUT,
        exitCode: 0,
        durationMs: 0,
        timestamp: 1700000000000,
        synthetic: true,
      },
    ];

    const withSuggestions = renderPanel("pro", history);
    expect(withSuggestions).toContain('data-terminal-palette="true"');
    expect(withSuggestions).toContain("profile &lt;id&gt;");
    expect(withSuggestions).toContain(
      "Inspect multidimensional sharpness radar",
    );
    expect(withSuggestions).toContain("⏱ 1 run · p50 12ms · p95 12ms");
    expect(withSuggestions).toContain("1 failed");

    // Arguments suppress the palette so it cannot cover the output.
    expect(renderPanel("p GP301", history)).not.toContain(
      'data-terminal-palette="true"',
    );

    // A sub-millisecond run still counts as a run; it just has no latency sample.
    const subMillisecond = renderPanel("", [
      {
        command: "help",
        stdout: "ok",
        exitCode: 0,
        durationMs: 0,
        timestamp: 1700000000000,
      },
    ]);
    expect(subMillisecond).toContain("⏱ 1 run");
    expect(subMillisecond).not.toContain("p50");
    expect(subMillisecond).not.toContain("no runs yet");
  });

  test("RankingsTabPanel renders 30d rankings and agency proxy conduits", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: noop,
        rankingsFilter: "ALL",
        onRankingsFilterChange: noop,
        onInspectPty: noop,
        rankings: FIXTURE_RANKINGS,
      }),
    );
    expect(html).toContain("30-Day Sharp Bettor Rankings");
    expect(html).toContain("FAKEMONEY");
    expect(html).toContain("SINGLE BETTOR PROXY CONDUIT");
  });

  test("AlertsTabPanel renders DLQ KPIs, toast, and alert action buttons", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(AlertsTabPanel, {
        alertToast: { message: "Queue Swept: 1 sent", type: "info" },
        onDismissToast: noop,
        onCopyDeliveryId: noop,
        healthData: {
          status: "degraded",
          uptimeSeconds: 42,
          alerts: {
            status: "degraded",
            queued: 1,
            delivered: 3,
            dead: 1,
            backlog: 1,
            acknowledged: 2,
          },
        },
        alertFilter: "ALL",
        onFilterChange: noop,
        alertLoading: false,
        onSweepAlerts: noop,
        onRefreshAlerts: noop,
        onOpenShiftModal: noop,
        alertRecords: [
          {
            deliveryId: "dead-uuid-12345678",
            wagerId: "W-109281",
            tier: "CRITICAL",
            status: "dead",
            payload: {
              customerId: "GP301",
              amountUsd: 5500,
              clvCents: 14.2,
              directive: "Clamp Max $250",
            },
            createdAt: "2026-11-12T12:00:00Z",
            updatedAt: "2026-11-12T12:01:00Z",
            attempts: 5,
            finalError: "429 Too Many Requests",
          },
        ],
        tiersConfig: null,
        onAckAlert: noop,
        onRetryAlert: noop,
      }),
    );
    expect(html).toContain("Queue Swept: 1 sent");
    expect(html).toContain("1 Dead");
    expect(html).toContain("429 Too Many Requests");
    expect(html).toContain("Retry DLQ");

    // Audit-stream controls: search, evidence copy, row expansion and age.
    expect(html).toContain('data-alert-search="true"');
    expect(html).toContain('data-alert-copy-audit="true"');
    expect(html).toContain("⧉ Copy audit (1)");
    expect(html).toContain("Showing 1/1");
    expect(html).toContain('data-alert-expand="dead-uuid-12345678"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-alert-age="true"');
    expect(html).toContain('scope="col"');
    // Collapsed by default: the evidence block is not in the initial render.
    expect(html).not.toContain("data-alert-detail-row");
  });

  test("AlertAuditDetail renders payload, lineage and timestamps for one delivery", () => {
    const createdAt = "2026-11-15T22:27:24.000Z";
    const html = renderToStaticMarkup(
      React.createElement(AlertAuditDetail, {
        now: Date.parse("2026-11-16T00:27:24.000Z"),
        alert: {
          deliveryId: "dead-uuid-12345678",
          wagerId: "W-109281",
          tier: "CRITICAL",
          status: "dead",
          payload: {
            customerId: "GP301",
            sport: "NFL",
            event: "Kansas City Chiefs @ Buffalo Bills",
            selection: "KC Chiefs -3.5",
            oddsAmerican: "-110",
            amountUsd: 5500,
            clvCents: 14.2,
            directive: "Clamp Max $250",
          },
          createdAt,
          updatedAt: "2026-11-15T22:29:24.000Z",
          attempts: 5,
          finalError: "429 Too Many Requests",
          retriedFrom: "orig-uuid-00000001",
          acknowledgedBy: "desk-operator",
          acknowledgedNotes: "escalated to partner desk",
          messageId: 4477,
        },
      }),
    );
    expect(html).toContain("TICKET PAYLOAD");
    expect(html).toContain("Kansas City Chiefs @ Buffalo Bills");
    expect(html).toContain("KC Chiefs -3.5");
    expect(html).toContain("$5,500");
    expect(html).toContain("14.2¢");
    expect(html).toContain("Clamp Max $250");
    expect(html).toContain("DELIVERY &amp; LINEAGE");
    expect(html).toContain("dead-uuid-12345678");
    expect(html).toContain("5 / 5");
    expect(html).toContain("4477");
    expect(html).toContain("429 Too Many Requests");
    expect(html).toContain("orig-uuid-00000001");
    expect(html).toContain("TIMESTAMPS &amp; ACK");
    expect(html).toContain(createdAt);
    expect(html).toContain("desk-operator");
    expect(html).toContain("escalated to partner desk");
    expect(html).toContain("2h ago");
  });

  test("LiveWagersTabPanel renders incoming wagers table and selected ticket inspector", () => {
    const noop = () => {};
    const wager = FIXTURE_LIVE_WAGERS[0]!;
    const baseProps = {
      wagers: FIXTURE_LIVE_WAGERS,
      wagerSearch: "",
      onWagerSearchChange: noop,
      wagerSportFilter: "ALL",
      onWagerSportFilterChange: noop,
      wagerAlertFilter: "ALL",
      onWagerAlertFilterChange: noop,
      wagerChannelFilter: "ALL",
      onWagerChannelFilterChange: noop,
      wagerTypeFilter: "ALL",
      onWagerTypeFilterChange: noop,
      wagerSortField: "timestamp" as const,
      wagerSortDir: "desc" as const,
      onWagerSort: noop,
      selectedWager: wager,
      onSelectWager: noop,
      copiedTicketId: null,
      onCopyText: noop,
      tiersConfig: null,
      onSelectCustomerById: noop,
      onInspectPty: noop,
    };
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, baseProps),
    );
    expect(html).toContain("Live Incoming Wagers");
    expect(html).toContain("Ticket Inspector: #W-109281");
    expect(html).toContain("Kansas City Chiefs @ Buffalo Bills");
    expect(html).toContain("OPERATOR GUARDRAILS");
    expect(html).toContain("SHADOW TAXONOMY MAP");
    expect(html).toContain("ALERT QUEUE &amp; CROSS-DESK");
    expect(html).toContain("LINE, PRICE &amp; TICKET HOLD");
    expect(html).toContain("PTY TRACE");
    expect(html).toContain("Shadow slice");
    expect(html).toContain("Weblog trace");
    expect(html).toContain("Operator brief");
    // wagers.toml is inlined into the bundle: its policy tag renders and the
    // stake emphasis floor (dashboard.toml) tags overweight samples.
    expect(html).toContain("wagers-policy/v1");
    expect(html).toContain("HIGH RISK");
    // Sport, bet type, event and market are separate columns, not combined cells.
    expect(html).toContain("Sport</th>");
    expect(html).toContain("Subsport</th>");
    expect(html).toContain("Bet Type</th>");
    expect(html).toContain("Event</th>");
    expect(html).toContain("Market Selection</th>");
    expect(html).not.toContain("Event &amp; Market Selection");
    expect(html).toContain("via GSLIVE");
    expect(html).not.toContain("Sport / Type");
    expect(html).not.toContain("wagers-dead-table-sentinel");
    // Partner 118 split: channel pills + per-channel profile cards.
    expect(html).toContain("🔴 GSLIVE");
    expect(html).toContain("🧩 GS Builder");
    expect(html).toContain('data-channel-profile="gslive"');
    expect(html).toContain('data-channel-profile="gsbuilder"');
    expect(html).toContain("$5,500 risk");
    expect(html).toContain("$5,250 risk");
    expect(html).toContain("Other channels");

    // Filtering by channel narrows the table to that writer only.
    const gsliveOnly = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wagerChannelFilter: "GSLIVE",
      }),
    );
    expect(gsliveOnly).toContain("GP301");
    expect(gsliveOnly).toContain("#W-109281");
    expect(gsliveOnly).not.toContain("#W-109282");
    // GSLIVE scope adds the game log + event log drill-down.
    expect(gsliveOnly).toContain('data-gslive-game-log="true"');
    expect(gsliveOnly).toContain("GSLIVE Game Log");
    expect(gsliveOnly).toContain("Kansas City Chiefs @ Buffalo Bills");
    expect(gsliveOnly).toContain('data-gslive-event-log="true"');
    expect(gsliveOnly).toContain("GSLIVE Event Log");
    expect(gsliveOnly).toContain('data-gslive-event="W-109281"');
    // Enhanced drill-down: sortable game columns, event filters, scope summary.
    for (const label of ["Tix", "Risk", "Avg", "Window"]) {
      expect(gsliveOnly).toContain(label);
    }
    for (const filter of ["all", "alerts", "clv"]) {
      expect(gsliveOnly).toContain(`data-gslive-event-filter="${filter}"`);
    }
    expect(gsliveOnly).toContain("risk ·");
    expect(gsliveOnly).toContain("alerts");
    // CSV handoff + burst/concentration sub-line.
    expect(gsliveOnly).toContain('data-gslive-copy="games"');
    expect(gsliveOnly).toContain('data-gslive-copy="events"');
    expect(gsliveOnly).toContain("cust · top3");
    expect(gsliveOnly).toContain("/60s");
    // Other channels keep the plain table: no GSLIVE logs outside the GSLIVE scope.
    expect(html).not.toContain('data-gslive-game-log="true"');

    // Streaming surface: live/polling status, pause control, NEW-row highlight.
    const streaming = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wagerChannelFilter: "GSLIVE",
        wagersLastUpdatedAt: Date.now(),
        newTicketIds: new Set(["W-109281"]),
        streamingConnected: false,
      }),
    );
    expect(streaming).toContain('data-gslive-stream="fallback"');
    expect(streaming).toContain("◌ polling");
    expect(streaming).toContain('data-gslive-pause="true"');
    expect(streaming).toContain("NEW");
    expect(streaming).toContain("s ago");

    const liveStream = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wagerChannelFilter: "GSLIVE",
        wagersLastUpdatedAt: Date.now(),
        streamingConnected: true,
      }),
    );
    expect(liveStream).toContain('data-gslive-stream="live"');
    expect(liveStream).toContain("● live");

    // Wire-contract chip: clean run vs. violations, rendered from the same props.
    const clean = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wireContract: {
          ok: true,
          registry: "schema/wagers_field_contract.json",
          capture: "getBetTicker-2026-10-31",
          capture_sha256: "955c3d0a",
          enum_source: "observed",
          fields_checked: ["WagerType", "ShortDesc", "VolumeAmount", "VIP"],
          rows: 237,
          skipped_rows: 63,
          violations: [],
        },
      }),
    );
    expect(clean).toContain("✓ wire: 237 rows");
    expect(clean).toContain("63 sentinel row(s) skipped");

    const withSlab = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        slabPolicy: {
          schema: "sportsdesk-slab/v1",
          version: "1.0.0",
          window_bytes: 2_000_000,
          unsafe_allowed: true,
          sentinels: {
            null_clv: -2147483648,
            null_customer_handle32: 4294967295,
            null_bridge_channel_word32: 4294967295,
          },
        },
      }),
    );
    expect(withSlab).toContain("slab 2.0 MB");
    expect(withSlab).toContain("sentinels null_clv=-2147483648");

    const dirty = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wireContract: {
          ok: false,
          registry: "schema/wagers_field_contract.json",
          capture: "getBetTicker-2026-10-31",
          capture_sha256: "955c3d0a",
          enum_source: "observed",
          fields_checked: ["VIP"],
          rows: 237,
          skipped_rows: 0,
          violations: [
            { field: "VIP", kind: "nullable", count: 4, examples: ["null"] },
          ],
        },
      }),
    );
    expect(dirty).toContain("⚠ wire: 1 issue(s)");
    expect(dirty).toContain("VIP: nullable ×4");

    // A stale clean contract must not read as clean when the feed failed.
    const errored = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        wagersError: "GET /api/wagers failed: boom",
        wireContract: {
          ok: true,
          registry: "schema/wagers_field_contract.json",
          capture: "getBetTicker-2026-10-31",
          capture_sha256: "955c3d0a",
          enum_source: "observed",
          fields_checked: ["VIP"],
          rows: 237,
          skipped_rows: 0,
          violations: [],
        },
      }),
    );
    expect(errored).toContain("⚠ wire: unavailable");
    expect(errored).not.toContain("✓ wire: 237 rows");
  });

  test("LiveWagersTabPanel prints a pick whose selection repeats the line only once", () => {
    const noop = () => {};
    // Ticket 769158444 as captured: ShortDesc hydration puts the whole pick in
    // both selection and lineDisplay, which used to render the pick twice.
    const ticket: LiveWager = {
      ...FIXTURE_LIVE_WAGERS[0]!,
      ticketId: "769158444",
      timestamp: "10:27:24 PM ET",
      customerId: "TTN29",
      agentId: "APOLLO",
      masterAgent: "APOLLO",
      ticketWriter: "Internet",
      writer: "internet",
      sport: "",
      subSport: null,
      betType: "Spread",
      event: "Event Matchup",
      selection: "Steelers (Live) +27½ +100",
      lineDisplay: "Steelers (Live) +27½ +100",
      oddsAmerican: "-110",
      riskUsd: 10000,
      volumeUsd: 10000,
      toWinUsd: 10000,
      clvCents: null,
      alertTier: "LATENCY",
      alertBadge: "⚠️ LATENCY (In-Play)",
      operatorDirective: "Delay 3s + Cap $1,000 (autoExecute: false)",
      maxRecommendedStake: 1000,
    };
    const baseProps = {
      wagers: [ticket],
      wagerSearch: "",
      onWagerSearchChange: noop,
      wagerSportFilter: "ALL",
      onWagerSportFilterChange: noop,
      wagerAlertFilter: "ALL",
      onWagerAlertFilterChange: noop,
      wagerChannelFilter: "ALL",
      onWagerChannelFilterChange: noop,
      wagerTypeFilter: "ALL",
      onWagerTypeFilterChange: noop,
      wagerSortField: "timestamp" as const,
      wagerSortDir: "desc" as const,
      onWagerSort: noop,
      selectedWager: null,
      onSelectWager: noop,
      copiedTicketId: null,
      onCopyText: noop,
      tiersConfig: null,
      onSelectCustomerById: noop,
      onInspectPty: noop,
    };
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, baseProps),
    );
    const occurrences = (html.match(/Steelers \(Live\) \+27½ \+100/g) ?? [])
      .length;
    expect(occurrences).toBe(1);
    // Event and market render in distinct cells.
    expect(html).toContain('data-wager-event="769158444"');
    expect(html).toContain('data-wager-market="769158444"');
    expect(html).toContain("Event Matchup</div></td>");
    expect(html).toContain("Steelers (Live) +27½ +100 (-110)");
    expect(html).not.toContain(
      "Steelers (Live) +27½ +100 Steelers (Live) +27½ +100",
    );

    // The inspector formats the same pick through the same path.
    const withInspector = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...baseProps,
        selectedWager: ticket,
      }),
    );
    expect(withInspector).toContain("Pick: Steelers (Live) +27½ +100 (-110)");
    expect(withInspector).not.toContain(
      "Pick: Steelers (Live) +27½ +100 Steelers",
    );
  });

  test("ShiftHandoffModal renders operator handoff summary and DLQ status note", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        shiftOperator: "nolarose",
        onShiftOperatorChange: noop,
        shiftLoading: false,
        onRefresh: noop,
        shiftSummary: {
          date: "2026-11-12",
          operatorId: "nolarose",
          totalAlerts: 12,
          deliveredAlerts: 10,
          failedAttempts: 1,
          deadLetterAlerts: 2,
          acknowledgedAlerts: 4,
          terminalCommandsCount: 9,
          loginEventsCount: 1,
        },
        onClose: noop,
      }),
    );
    expect(html).toContain("Operator Shift Handoff Summary");
    expect(html).toContain("2026-11-12");
    expect(html).toContain("2 dead alert(s) in DLQ");
  });

  test("BetTickerTabPanel reports the rendered page and can reveal the whole filtered stream", () => {
    const noop = () => {};
    const tickets = Array.from({ length: 130 }, (_, index) => {
      const ticketNumber = 10_000 + index;
      return {
        wagerNumber: ticketNumber,
        ticketId: String(ticketNumber),
        customerId: `C${index}`,
        agentId: "AG1",
        masterAgent: "MASTER",
        ticketWriter: "Internet",
        writer: "internet",
        wagerType: "S",
        wagerTypeLabel: "Spread",
        amountWageredCents: 1_000 + index,
        volumeAmountCents: 1_000 + index,
        toWinAmountCents: 900 + index,
        volumeDiffers: false,
        isSentinelNoise: false,
        vip: false,
        live: index % 2 === 0,
        insertedAt: `2026-11-12T18:${String(index % 60).padStart(2, "0")}:00Z`,
        legCount: 1,
        shortDesc: "Team -3",
        sport: "NFL",
        selection: "Team -3",
        alertFlags: [],
      };
    });
    const html = renderToStaticMarkup(
      React.createElement(BetTickerTabPanel, {
        data: {
          schemaVersion: 1,
          observedAt: "2026-11-12T18:00:00Z",
          autoExecute: false,
          provenance: {
            kind: "live",
            label: "live feed",
            sourcePath: "data/live-wagers.json",
            observedAt: "2026-11-12T18:00:00Z",
          },
          localFeed: {
            rawRowCount: 130,
            actionableTicketCount: 130,
            sentinelNoiseCount: 0,
            totalWageredCents: 1_000,
            totalVolumeCents: 1_000,
            totalToWinCents: 1_000,
            volumeDiffersCount: 0,
            vipCount: 0,
            liveCount: 65,
            flagCount: 0,
            byRule: {},
            byWriter: [],
            byWagerType: [],
            tickets,
          },
          bridge3aR2: { available: false, error: "not captured" },
          pendingGames: { available: false },
          captureHealth: { available: false },
        },
        loading: false,
        error: null,
        onRefresh: noop,
        onSelectAgent: noop,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    expect(html).toContain("Showing 120 of 130 filtered");
    expect(html).toContain("130 captured");
    expect(html).toContain('data-bet-ticker-show-all="expand"');
    expect(html).toContain("Show all 130 rows");
    expect(html).toContain("⧉ Copy rows (130)");
    expect((html.match(/Team -3/g) ?? []).length).toBe(120);
  });

  test("ApiUsageCard reports coalesced requests separately from network calls", () => {
    resetApiUsage();
    try {
      endApiCall(beginApiCall("GET /api/kpis"), 200);
      endApiCall(beginApiCall("GET /api/kpis", true), 200);
      const html = renderToStaticMarkup(React.createElement(ApiUsageCard));
      expect(html).toContain("2 calls");
      expect(html).toContain("1 network");
      expect(html).toContain("1 coalesced");
    } finally {
      resetApiUsage();
    }
  });

  test("ApiUsageCard renders the empty state and normalized session rows", () => {
    resetApiUsage();
    try {
      const empty = renderToStaticMarkup(React.createElement(ApiUsageCard));
      expect(empty).toContain('data-api-usage-card="true"');
      expect(empty).toContain("No API calls recorded this session");

      endApiCall(beginApiCall("GET /api/kpis"), 200);
      endApiCall(beginApiCall("GET /api/kpis"), 503);
      const html = renderToStaticMarkup(React.createElement(ApiUsageCard));
      expect(html).toContain("GET /api/kpis");
      expect(html).toContain("2 calls");
      expect(html).toContain("1 ok");
      expect(html).toContain("1 failed");
      expect(html).toContain("Reset meter");
      // No request-specific values leak into the meter.
      expect(html).not.toContain("window=24");
    } finally {
      resetApiUsage();
    }
  });

  test("BetTickerTabPanel sanitizes portal markup in channels and selections", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(BetTickerTabPanel, {
        data: {
          schemaVersion: 1,
          observedAt: "2026-11-12T18:00:00Z",
          autoExecute: false,
          provenance: {
            kind: "live",
            label: "live feed",
            sourcePath: "data/live-wagers.json",
            observedAt: "2026-11-12T18:00:00Z",
          },
          localFeed: {
            rawRowCount: 1,
            actionableTicketCount: 1,
            sentinelNoiseCount: 0,
            totalWageredCents: 1000,
            totalVolumeCents: 1000,
            totalToWinCents: 900,
            volumeDiffersCount: 0,
            vipCount: 0,
            liveCount: 0,
            flagCount: 0,
            byRule: {},
            byWriter: [
              {
                writer: '<strong style="color:#D90000">ALERT </strong>',
                count: 1,
                wageredCents: 1000,
                volumeCents: 1000,
                toWinCents: 900,
                isSentinelNoise: false,
              },
            ],
            byWagerType: [],
            tickets: [
              {
                wagerNumber: 12_345,
                ticketId: "12345",
                customerId: "GP301",
                agentId: "AG1",
                masterAgent: "MASTER",
                ticketWriter: '<strong style="color:#D90000">ALERT </strong>',
                writer: "alert",
                wagerType: "S",
                wagerTypeLabel: "Spread",
                amountWageredCents: 1000,
                volumeAmountCents: 1000,
                toWinAmountCents: 900,
                volumeDiffers: false,
                isSentinelNoise: false,
                vip: false,
                live: false,
                insertedAt: "2026-11-12T18:00:00Z",
                legCount: 1,
                shortDesc: "Kings +4&#189; -115",
                sport: "NBA",
                selection: "Kings +4&#189; -115",
                alertFlags: ["ALERT_SENTINEL_TWIN"],
              },
            ],
          },
          bridge3aR2: { available: false, error: "not captured" },
          pendingGames: { available: false },
          captureHealth: { available: false },
        },
        loading: false,
        error: null,
        onRefresh: noop,
        onSelectAgent: noop,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    expect(html).toContain("Kings +4½ -115");
    expect(html).toContain("ALERT");
    expect(html).not.toContain("&lt;strong");
    expect(html).not.toContain("&amp;#189;");
  });

  test("BetTickerTabPanel and R2PipelineTabPanel SSR render channels, types, sinks, and remediation", () => {
    const noop = () => {};
    const tickerHtml = renderToStaticMarkup(
      React.createElement(BetTickerTabPanel, {
        data: {
          schemaVersion: 1,
          observedAt: "2026-11-12T18:00:00Z",
          autoExecute: false,
          provenance: {
            kind: "live",
            label: "live feed",
            sourcePath: "data/live-wagers.json",
            observedAt: "2026-11-12T18:00:00Z",
          },
          localFeed: {
            rawRowCount: 5,
            actionableTicketCount: 3,
            sentinelNoiseCount: 2,
            totalWageredCents: 150000,
            totalVolumeCents: 185000,
            totalToWinCents: 135000,
            volumeDiffersCount: 1,
            vipCount: 1,
            liveCount: 1,
            flagCount: 1,
            byRule: { HIGH_STAKE: 1 },
            byWriter: [
              {
                writer: "Internet",
                count: 2,
                wageredCents: 100000,
                volumeCents: 135000,
                toWinCents: 90000,
                isSentinelNoise: false,
              },
              {
                writer: "ALERT",
                count: 2,
                wageredCents: 0,
                volumeCents: 0,
                toWinCents: 0,
                isSentinelNoise: true,
              },
            ],
            byWagerType: [
              {
                wagerType: "S",
                label: "Spread",
                count: 2,
                wageredCents: 100000,
                volumeCents: 135000,
                toWinCents: 90000,
              },
            ],
            tickets: [
              {
                ticketId: "9001",
                customerId: "GP301",
                agentId: "FAKEMONEY",
                ticketWriter: "Internet",
                isSentinelNoise: false,
                wagerType: "S",
                wagerTypeLabel: "Spread",
                wageredCents: 50000,
                volumeCents: 75000,
                toWinCents: 45000,
                volumeDiffers: true,
                vip: true,
                live: false,
                insertedAt: "2026-11-12T18:00:00Z",
                legCount: 1,
                shortDesc: "[NFL] Chiefs -3",
                sport: "NFL",
                selection: "Chiefs -3",
                alertFlags: ["HIGH_STAKE"],
              },
            ],
          },
          bridge3aR2: {
            available: true,
            publicUrl:
              "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/f402-bet-ticker/latest.json",
            state: "fresh",
            lastModified: "2026-11-12T17:58:00Z",
            ageSeconds: 120,
            generatedAt: "2026-11-12T17:58:00Z",
            deskDate: "2026-11-12",
            deskHour: 12,
            watermark: "768283486",
            rowCount: 87,
            ticketCount: 87,
            legCount: 110,
            alertTwinCount: 25,
            orphanCount: 25,
            byChannel: {
              Internet: { tickets: 40, legs: 50, volumeCents: 120000 },
            },
            byWagerType: {
              S: { tickets: 60, legs: 60, wageredCents: 200000 },
            },
          },
          pendingGames: {
            available: true,
            gameCount: 12,
            pendingCount: 12,
            totalWageredCents: 350000,
            totalToWinCents: 310000,
            capturedAt: "2026-11-12T17:55:00Z",
            dataSource: "Report/Pending",
            sourcePath: "data/live-bets.json",
          },
          captureHealth: {
            available: true,
            status: "ok",
            capturedAt: "2026-11-12T17:59:00Z",
            ageSeconds: 60,
            rowCount: 5,
            sourcePath: "data/capture-health.json",
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
        onSelectAgent: noop,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    expect(tickerHtml).toContain("768283486");
    expect(tickerHtml).toContain("Internet");
    expect(tickerHtml).toContain("/agent/FAKEMONEY");
    expect(tickerHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    // The stream reports what it actually rendered and exports the whole filter.
    expect(tickerHtml).toContain("Showing 1 of 1 filtered");
    expect(tickerHtml).toContain("5 captured");
    expect(tickerHtml).toContain('data-bet-ticker-copy-rows="true"');
    expect(tickerHtml).toContain("⧉ Copy rows (1)");
    expect(tickerHtml).toContain('data-bet-ticker-sort="ticket"');
    expect(tickerHtml).toContain('data-bet-ticker-sort="wagered"');
    expect(tickerHtml).toContain('data-bet-ticker-sort="toWin"');
    expect(tickerHtml).toContain('aria-sort="descending"');
    expect(tickerHtml).toContain('aria-label="Filter Bet-Ticker rows"');
    expect(tickerHtml).toContain('scope="col"');
    // Channel and wager type are separate columns, not one combined cell.
    expect(tickerHtml).toContain("Channel</th>");
    expect(tickerHtml).toContain("Type</th>");
    expect(tickerHtml).not.toContain("Channel / Type");
    expect(tickerHtml).toContain('data-bet-ticker-channel="9001"');
    expect(tickerHtml).toContain('data-bet-ticker-type="9001"');
    expect(tickerHtml).toContain("Spread");
    // Sport/leg context is separate from the pick text.
    expect(tickerHtml).toContain("Sport</th>");
    expect(tickerHtml).toContain("Selection</th>");
    expect(tickerHtml).toContain('data-bet-ticker-sport="9001"');
    expect(tickerHtml).toContain('data-bet-ticker-selection="9001"');
    expect(tickerHtml).toContain("NFL");
    expect(tickerHtml).toContain("1L");
    expect(tickerHtml).toContain("Chiefs -3");

    const r2Html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: {
          schemaVersion: 1,
          bucketPublicBase:
            "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
          observedAt: "2026-11-12T18:00:00Z",
          overallStatus: "stale",
          freshCount: 1,
          totalCount: 4,
          staleKeys: ["gslive-tally/latest.json"],
          dataStaleKeys: ["gslive-tally/latest.json"],
          sinks: [
            {
              id: "gslive-tally",
              key: "gslive-tally/latest.json",
              label: "gslive tally",
              description: "Bridge 3c rollup",
              publicUrl:
                "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/gslive-tally/latest.json",
              resolvedRollupKey: "gslive-tally/2026-11-09/rollup.json",
              resolvedRollupUrl:
                "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/gslive-tally/2026-11-09/rollup.json",
              slaSeconds: 3600,
              state: "stale",
              stale: true,
              lastModified: "2026-11-12T15:00:00Z",
              ageSeconds: 10800,
              dataAgeSeconds: 100000,
              dataStale: true,
              contentLength: 512,
              sha256: "abc123",
              reason: "Age exceeds 1h SLA",
              remediationCommand: "bun run tally:bridge3c",
              metrics: [{ label: "Desk Date", value: "2026-11-09" }],
            },
          ],
          daemon4020: {
            online: true,
            url: "http://127.0.0.1:4020/health",
            status: 200,
            latencyMs: 2,
            checkedAt: "2026-11-12T18:00:00Z",
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(r2Html).toContain("gslive tally");
    expect(r2Html).toContain("bun run tally:bridge3c");
    expect(r2Html).toContain("2026-11-09");

    const degradedR2Html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: {
          schemaVersion: 1,
          bucketPublicBase: "https://pub.example.r2.dev",
          observedAt: "2026-11-12T18:00:00Z",
          overallStatus: "stale",
          freshCount: 0,
          totalCount: 1,
          staleKeys: ["gslive-tally/latest.json"],
          dataStaleKeys: ["gslive-tally/latest.json"],
          sinks: [],
          daemon4020: {
            online: true,
            state: "degraded",
            operationalStatus: "down",
            url: "http://127.0.0.1:4020/health",
            status: 503,
            latencyMs: 9,
            checkedAt: "2026-11-12T18:00:00Z",
            reason: "HTTP 503 — F402 session expired",
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(degradedR2Html).toContain("Reachable — Auth Down (9ms)");
    expect(degradedR2Html).toContain("F402 session expired");
    expect(degradedR2Html).not.toContain("Offline");

    const automationsR2Html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: {
          schemaVersion: 1,
          bucketPublicBase: "https://pub.example.r2.dev",
          observedAt: "2026-11-15T20:30:00Z",
          overallStatus: "fresh",
          freshCount: 1,
          totalCount: 1,
          staleKeys: [],
          dataStaleKeys: [],
          sinks: [],
          daemon4020: {
            online: true,
            url: "http://127.0.0.1:4020/health",
            status: 200,
            latencyMs: 2,
            checkedAt: "2026-11-15T20:30:00Z",
          },
          automations: {
            observedAt: "2026-11-15T20:30:00Z",
            bridgeRollupUpdatedAt: "2026-11-15T20:15:00Z",
            bridgeJobs: [
              {
                id: "bridge3c",
                label: "GSLive tally (3c)",
                ok: true,
                durationMs: 310,
              },
            ],
            schedules: [
              {
                id: "sched_gslive_tickets_verify_30m",
                name: "GSLive Ticket & Canary Verify (30m)",
                scheduleTime: "*/30 * * * *",
                tz: "America/Chicago",
                reportType: "SHELL_CAPTURE",
                owner: "daemon",
                enabled: true,
                gateReady: true,
                missingRequirements: [],
                lastTriggeredAt: null,
              },
            ],
            ticketVerification: {
              schemaVersion: 1,
              available: true,
              mode: "dry-run",
              verifiedAt: "2026-11-15T20:30:00Z",
              sourcePath: "data/live-wagers.json",
              totalRows: 10,
              actionableTickets: 8,
              sentinelNoiseCount: 2,
              volumeMismatchCount: 1,
              totalWageredCents: 100_000,
              totalVolumeCents: 110_000,
              totalToWinCents: 90_000,
              canaryPassed: true,
              clientSealed: true,
              f402Status: "ok",
              r2Status: "skipped",
              r2PublishedKey: null,
              error: null,
              remediation: null,
            },
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
        onVerifyTickets: noop,
      }),
    );
    expect(automationsR2Html).toContain("GSLive Ticket Verification");
    expect(automationsR2Html).toContain("CANARY PASS");
    expect(automationsR2Html).toContain("Scheduled Automations");
    expect(automationsR2Html).toContain(
      "GSLive Ticket &amp; Canary Verify (30m)",
    );
    expect(automationsR2Html).toContain("Run Dry-Run Verify");

    const triageR2Html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: {
          schemaVersion: 1,
          bucketPublicBase: "https://pub.example.r2.dev",
          observedAt: "2026-11-16T03:30:04Z",
          overallStatus: "stale",
          freshCount: 1,
          totalCount: 4,
          staleKeys: ["gslive-tally/latest.json"],
          dataStaleKeys: ["wagers-by-state/latest.json"],
          sinks: [
            {
              id: "wagers-by-state",
              key: "wagers-by-state/latest.json",
              label: "wagers-by-state",
              description: "88-hour win/lose/push & grade-lag histogram",
              publicUrl:
                "https://pub.example.r2.dev/wagers-by-state/latest.json",
              resolvedRollupKey: null,
              resolvedRollupUrl: null,
              slaSeconds: 3600,
              state: "fresh",
              stale: false,
              lastModified: "2026-11-16T03:30:01Z",
              ageSeconds: 3,
              dataAgeSeconds: 593251,
              dataStale: true,
              contentLength: 2140,
              sha256: "9cb61eecc60e40b4",
              reason: "Within publish SLA",
              remediationCommand: "bun run wagers:publish-snapshot",
              diagnostic: {
                blockerClass: "upstream_capture_stale",
                headline:
                  "Cached Snapshot Republished · GSLive Dual-Auth Expired",
                detail:
                  "wagers-by-state: GSLive expired. Manual dual-auth required.",
                failedJobIds: ["wagers-by-state"],
                suggestedCommand:
                  "printf '%s' '<GSID>' | bun run secrets:gslive set",
              },
              metrics: [{ label: "Desk Date", value: "2026-11-09" }],
            },
          ],
          daemon4020: {
            online: true,
            url: "http://127.0.0.1:4020/health",
            status: 200,
            latencyMs: 2,
            checkedAt: "2026-11-16T03:30:04Z",
          },
          automations: {
            observedAt: "2026-11-16T03:30:04Z",
            bridgeRollupUpdatedAt: "2026-11-16T03:30:02Z",
            bridgeJobs: [
              {
                id: "wagers-by-state",
                label: "Wagers by State Publish",
                ok: false,
                durationMs: 0,
                error: "GSLive expired. Manual dual-auth required.",
              },
            ],
            schedules: [],
            ticketVerification: null,
          },
        },
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(triageR2Html).toContain("Data Windows &gt;24h");
    expect(triageR2Html).toContain(
      "Pipeline Root-Cause &amp; Auth Remediation Triage",
    );
    expect(triageR2Html).toContain("Cached Snapshot Republished");
    expect(triageR2Html).toContain("DATA &gt;24H");
    expect(triageR2Html).toContain("sha256:9cb61eecc60e");
    expect(triageR2Html).toContain("Failing Bridge Jobs (1)");
    expect(triageR2Html).toContain(
      "GSLive expired. Manual dual-auth required.",
    );
  });

  test("R2PipelineTabPanel renders SLA breach math and the process-local freshness trend", () => {
    const noop = () => {};
    const sink = {
      id: "gslive-tally",
      key: "gslive-tally/latest.json",
      label: "gslive tally",
      description: "Bridge 3c rollup",
      publicUrl: "https://pub.example.r2.dev/gslive-tally/latest.json",
      resolvedRollupKey: null,
      resolvedRollupUrl: null,
      slaSeconds: 3600,
      state: "stale" as const,
      stale: true,
      lastModified: "2026-11-12T15:00:00.000Z",
      ageSeconds: 10800,
      dataAgeSeconds: 90000,
      dataStale: true,
      contentLength: 512,
      sha256: "abc123",
      reason: "Published 3h ago (SLA 60m)",
      remediationCommand: "bun run tally:bridge3c",
      sla: {
        breachSeconds: 7200,
        utilizationPct: 300,
        breachStartedAt: "2026-11-12T15:00:00.000Z",
        remainingSeconds: null,
      },
      metrics: [],
    };
    const freshSink = {
      id: "f402-bet-ticker",
      key: "f402-bet-ticker/latest.json",
      label: "f402 bet ticker",
      description: "Bridge 3a rollup",
      publicUrl: "https://pub.example.r2.dev/f402-bet-ticker/latest.json",
      resolvedRollupKey: null,
      resolvedRollupUrl: null,
      slaSeconds: 3600,
      state: "fresh" as const,
      stale: false,
      lastModified: "2026-11-12T17:55:00.000Z",
      ageSeconds: 300,
      dataAgeSeconds: 320,
      dataStale: false,
      contentLength: 256,
      sha256: "def456",
      reason: "Within publish SLA",
      remediationCommand: "bun run positions:cron --once",
      sla: {
        breachSeconds: 0,
        utilizationPct: 8,
        breachStartedAt: null,
        remainingSeconds: 3300,
      },
      metrics: [],
    };
    const data = {
      schemaVersion: 1 as const,
      bucketPublicBase: "https://pub.example.r2.dev",
      observedAt: "2026-11-12T18:00:00.000Z",
      overallStatus: "stale" as const,
      freshCount: 1,
      totalCount: 2,
      staleKeys: [sink.key],
      dataStaleKeys: [sink.key],
      sinks: [sink, freshSink],
      daemon4020: {
        online: true,
        state: "degraded" as const,
        operationalStatus: "degraded" as const,
        url: "http://127.0.0.1:4020/health",
        status: 200,
        latencyMs: 2,
        checkedAt: "2026-11-12T18:00:00.000Z",
        auth: {
          f402: { status: "ok", source: "session-file", remediation: null },
          gslive: {
            status: "expired",
            source: "keychain",
            remediation: "printf '%s' '<GSID>' | bun run secrets:gslive set",
          },
        },
      },
    };
    const history = {
      schemaVersion: 1 as const,
      observedAt: "2026-11-12T18:00:00.000Z",
      source: "process-memory" as const,
      sampledSince: "2026-11-12T17:00:00.000Z",
      minSampleIntervalSeconds: 60,
      sinks: [
        {
          id: "gslive-tally",
          label: "gslive tally",
          slaSeconds: 3600,
          sampleCount: 3,
          samples: [
            {
              at: "2026-11-12T17:00:00.000Z",
              ageSeconds: 7200,
              state: "stale" as const,
              dataAgeSeconds: 80000,
            },
            {
              at: "2026-11-12T17:30:00.000Z",
              ageSeconds: 9000,
              state: "stale" as const,
              dataAgeSeconds: 85000,
            },
            {
              at: "2026-11-12T18:00:00.000Z",
              ageSeconds: 10800,
              state: "stale" as const,
              dataAgeSeconds: 90000,
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data,
        history,
        historyError: null,
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(html).toContain("OVERDUE 2.0h");
    expect(html).toContain("overdue since 15:00Z · 300% of SLA");
    expect(html).toContain("1 Overdue · Worst 2.0h (gslive tally)");
    expect(html).toContain("renews in 55m · 8% of SLA");
    expect(html).toContain("GSLive auth expired");
    // Worst breach renders before the healthy sink.
    expect(html.indexOf("overdue since 15:00Z")).toBeLessThan(
      html.indexOf("renews in 55m"),
    );
    expect(html).toContain("Freshness Trend · process-local");
    expect(html).toContain("rising · 3 samples");
    expect(html).toContain("Publish age trend over 3 samples");
    expect(html).not.toContain("history unavailable");

    const erroredHtml = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data,
        history: null,
        historyError: "HTTP 500",
        loading: false,
        error: null,
        onRefresh: noop,
      }),
    );
    expect(erroredHtml).toContain("Freshness history unavailable: HTTP 500");
  });

  test("UI panels, ANSI renderer, and dashboard.md replace dead desk.bookdeskops.com/agent/ URLs with local links", () => {
    const noop = () => {};
    const custHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: false,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: FIXTURE_PROFILE_CUSTOMERS,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: FIXTURE_PROFILE_CUSTOMERS[0]!,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerReverseForensics: {
          ipAddress: "146.190.10.20",
          hostnames: ["cpe-146-190-10-20.tx.res.rr.com"],
          primaryHostname: "cpe-146-190-10-20.tx.res.rr.com",
          isDatacenterOrCloud: false,
          isVpnOrProxySuspicious: false,
          organization: "Spectrum Residential",
          egressCategory: "RESIDENTIAL",
          classificationLabel: "RESIDENTIAL",
          riskEmphasis: "NORMAL",
          deskNote: "Datacenter check clean",
        },
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );
    const wagersHtml = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        wagerSearch: "",
        onWagerSearchChange: noop,
        wagerSportFilter: "ALL",
        onWagerSportFilterChange: noop,
        wagerAlertFilter: "ALL",
        onWagerAlertFilterChange: noop,
        wagerTypeFilter: "ALL",
        onWagerTypeFilterChange: noop,
        wagerSortField: "timestamp",
        wagerSortDir: "desc",
        onWagerSort: noop,
        wagers: FIXTURE_LIVE_WAGERS,
        selectedWager: FIXTURE_LIVE_WAGERS[0]!,
        onSelectWager: noop,
        copiedTicketId: null,
        onCopyText: noop,
        tiersConfig: null,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );
    const rankingsHtml = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: noop,
        rankingsFilter: "ALL",
        onRankingsFilterChange: noop,
        onInspectPty: noop,
        rankings: FIXTURE_RANKINGS,
      }),
    );
    const ansiHtml = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        renderAnsiReact(
          "\x1b]8;;https://desk.bookdeskops.com/agent/FAKEMONEY\x07FAKEMONEY\x1b]8;;\x07",
        ),
      ),
    );
    const dashboardMd = readFileSync(
      resolve(import.meta.dir, "..", "dashboard.md"),
      "utf8",
    );

    expect(custHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(wagersHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(rankingsHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(ansiHtml).toContain('href="/agent/FAKEMONEY"');
    expect(ansiHtml).not.toContain("https://desk.bookdeskops.com/agent/");
    expect(dashboardMd).not.toContain("https://desk.bookdeskops.com/agent/");
  });

  test("@sportsdesk-ops/ui public index.ts barrel exposes TOML contracts, route helpers, panels, and tab specs", () => {
    expect(uiBarrel.App).toBe(App);
    expect(typeof uiBarrel.ThresholdsPanel).toBe("function");
    expect(typeof uiBarrel.getLocalAgentHref).toBe("function");
    expect(typeof uiBarrel.resolveDashboardTabId).toBe("function");
    expect(uiBarrel.DASHBOARD_META.schema).toBe("sportsdesk-dashboard/v2");
    expect(uiBarrel.WAGERS_META.schema).toBe("sportsdesk-wagers-tab/v1");
    expect(uiBarrel.DASHBOARD_TAB_IDS).toContain("wagers");
  });
});

test("LiveWagersTabPanel shows the streaming status and highlights fresh rows", () => {
  const noop = () => {};
  const wager = FIXTURE_LIVE_WAGERS[0]!;
  const base = {
    wagers: FIXTURE_LIVE_WAGERS,
    wagerSearch: "",
    onWagerSearchChange: noop,
    wagerSportFilter: "ALL",
    onWagerSportFilterChange: noop,
    wagerAlertFilter: "ALL",
    onWagerAlertFilterChange: noop,
    wagerChannelFilter: "ALL",
    onWagerChannelFilterChange: noop,
    wagerTypeFilter: "ALL",
    onWagerTypeFilterChange: noop,
    wagerSortField: "timestamp" as const,
    wagerSortDir: "desc" as const,
    onWagerSort: noop,
    selectedWager: wager,
    onSelectWager: noop,
    copiedTicketId: null,
    onCopyText: noop,
    tiersConfig: null,
    onSelectCustomerById: noop,
    onInspectPty: noop,
  };

  const live = renderToStaticMarkup(
    React.createElement(LiveWagersTabPanel, {
      ...base,
      wagersLastUpdatedAt: Date.now(),
      newTicketIds: new Set([wager.ticketId]),
      streamingConnected: true,
    }),
  );
  expect(live).toContain('data-wagers-stream="live"');
  expect(live).toContain("● live");
  expect(live).toContain("auto 10s");
  expect(live).toContain("NEW");
  expect(live).toContain("s ago");
  expect(live).toContain('data-wagers-pause="true"');
  expect(live).toContain("+1 new");

  const fallback = renderToStaticMarkup(
    React.createElement(LiveWagersTabPanel, {
      ...base,
      wagersLastUpdatedAt: Date.now(),
      streamingConnected: false,
    }),
  );
  expect(fallback).toContain('data-wagers-stream="fallback"');
  expect(fallback).toContain("◌ polling");
});

test("sport filter also matches the subsport/league", () => {
  const noop = () => {};
  const wager = FIXTURE_LIVE_WAGERS[0]!;
  const base = {
    wagers: FIXTURE_LIVE_WAGERS,
    wagerSearch: "",
    onWagerSearchChange: noop,
    wagerSportFilter: "NFL",
    onWagerSportFilterChange: noop,
    wagerAlertFilter: "ALL",
    onWagerAlertFilterChange: noop,
    wagerChannelFilter: "ALL",
    onWagerChannelFilterChange: noop,
    wagerTypeFilter: "ALL",
    onWagerTypeFilterChange: noop,
    wagerSortField: "timestamp" as const,
    wagerSortDir: "desc" as const,
    onWagerSort: noop,
    selectedWager: wager,
    onSelectWager: noop,
    copiedTicketId: null,
    onCopyText: noop,
    tiersConfig: null,
    onSelectCustomerById: noop,
    onInspectPty: noop,
  };
  const html = renderToStaticMarkup(
    React.createElement(LiveWagersTabPanel, base),
  );
  expect(html).toContain("#W-109281");
  expect(html).not.toContain("#W-109287");
});

test("the subsport column and league pills hide when the capture has no subsport", () => {
  const noop = () => {};
  const wager = FIXTURE_LIVE_WAGERS[0]!;
  const base = {
    wagers: FIXTURE_LIVE_WAGERS.map((w) => ({ ...w, subSport: null })),
    wagerSearch: "",
    onWagerSearchChange: noop,
    wagerSportFilter: "ALL",
    onWagerSportFilterChange: noop,
    wagerAlertFilter: "ALL",
    onWagerAlertFilterChange: noop,
    wagerChannelFilter: "ALL",
    onWagerChannelFilterChange: noop,
    wagerTypeFilter: "ALL",
    onWagerTypeFilterChange: noop,
    wagerSortField: "timestamp" as const,
    wagerSortDir: "desc" as const,
    onWagerSort: noop,
    selectedWager: wager,
    onSelectWager: noop,
    copiedTicketId: null,
    onCopyText: noop,
    tiersConfig: null,
    onSelectCustomerById: noop,
    onInspectPty: noop,
  };
  const html = renderToStaticMarkup(
    React.createElement(LiveWagersTabPanel, base),
  );
  expect(html).not.toContain("Subsport</th>");
  expect(html).not.toContain(">NFL</button>");
});
