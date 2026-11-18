import { YAML } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectReport } from "../lib/cli_inspect.ts";
import {
  buildDiagnosticsSnapshotJson,
  buildExposurePlotData,
  buildScoreboardRows,
  buildSignalArenaIndex,
  buildSignalArenaView,
  buildTradingTerminalSnapshot,
  classifyWriterProvenanceChannel,
  computeMarketComposite,
  DESK_ENDPOINT_CATALOG,
  DESK_PREFS_STORAGE_KEY,
  defaultWorkspacePrefs,
  extractApiFailureCause,
  filterMarketInstruments,
  isXmlOddsPollDue,
  mapLeagueToCanonicalSport,
  PARSER_WORKBENCH_PRESETS,
  parseAnalysisPayload,
  parseCustomerProfilePayload,
  parseCustomerRatingPayload,
  parseDnsTelemetryPayload,
  parseExecutionActionPayload,
  parseExecutionPlanPayload,
  parseGameAdminBoardPayload,
  parseGameAdminPayload,
  parseGovernancePayload,
  parseGraphFeedPayload,
  parseGraphStreamSample,
  parseKalshiPayload,
  parseKpisPayload,
  parseLiveBetsSummaryPayload,
  parseLiveWagersPayload,
  parseScoreboardPayload,
  parseWorkspacePrefsJson,
  parseXmlOddsSoaPayload,
  resolveDeskOrigin,
  serializeWorkspacePrefs,
  sortSignalArenaIndex,
  synthesizeMarketInstruments,
  XML_ODDS_POLL_INTERVAL_MS,
} from "../packages/nsh-desk/desk_model.ts";
import {
  isXmlOddsLineUnknown,
  loadXmlOddsSoaFeed,
  readXmlOddsRow,
  XML_ODDS_ROW_LIMIT,
  xmlOddsRows,
  xmlOddsRowsHeader,
  type XmlOddsFeed,
} from "../packages/nsh-desk/xml_odds_view.ts";

describe("packages/nsh-desk model and capability contracts", () => {
  test("resolveDeskOrigin returns value and source and rejects non-loopback hosts", () => {
    expect(resolveDeskOrigin(undefined)).toEqual({
      origin: "http://127.0.0.1:4020",
      source: "default:4020",
    });
    expect(resolveDeskOrigin("  http://localhost:4025/path ")).toEqual({
      origin: "http://localhost:4025",
      source: "env:SPORTSDESK_ORIGIN",
    });

    expect(() => resolveDeskOrigin("https://127.0.0.1:4020")).toThrow(
      /Unsupported SPORTSDESK_ORIGIN scheme/,
    );
    expect(() => resolveDeskOrigin("http://example.com:4020")).toThrow(
      /Disallowed SPORTSDESK_ORIGIN host/,
    );
    expect(() => resolveDeskOrigin("not a url")).toThrow(
      /Invalid SPORTSDESK_ORIGIN/,
    );
  });

  test("extractApiFailureCause preserves :4020 diagnostic code and message", () => {
    const body = JSON.stringify({
      success: false,
      error: "live Report/Pending unavailable",
      live: {
        diagnostic: {
          code: "unauthorized",
          message: "Report/Pending returned 401",
        },
      },
    });
    const out = extractApiFailureCause("/api/live-bets/summary", 503, body);
    expect(out).toEqual({
      code: "unauthorized",
      cause:
        "/api/live-bets/summary HTTP 503 [unauthorized]: live Report/Pending unavailable — Report/Pending returned 401",
    });
  });

  test("parseKpisPayload separates R2 publish age from data-window age (#78)", () => {
    const parsed = parseKpisPayload({
      generatedAt: "2026-11-10T19:45:00.000Z",
      kpis: {
        agents: {
          total: 2276,
          agents: 1679,
          masters: 596,
          provenance: {
            source: "scratch/agent-graph.json",
            basis: "fixture",
            ageSeconds: 120,
            stale: false,
          },
        },
      },
      pipeline: {
        r2: {
          "f402-weblog": {
            state: "fresh",
            ageSeconds: 1800,
            stale: false,
            dataAgeSeconds: 503000,
            dataStale: true,
            reason: "30m old (SLA 1h30m)",
          },
        },
      },
    });

    expect(parsed.cards.length).toBe(1);
    expect(parsed.cards[0]?.provenance.basis).toBe("fixture");
    expect(parsed.r2Sinks.length).toBe(1);
    expect(parsed.r2Sinks[0]?.windowDivergent).toBe(true);
  });

  test("buildSignalArenaView sorts via Float64Array + Uint32Array without mutating source items", () => {
    const kalshi = parseKalshiPayload({
      provenance: {
        dataMode: "PARTIAL",
        stale: true,
        fixture: true,
        ageSeconds: 3600,
        sources: ["docs/graph-live-feed.json"],
      },
      kalshi: { ok: true, degraded: false },
      signals: [
        {
          id: "NFL-BUF_KC-spread",
          league: "NFL",
          marketKind: "spread",
          teams: ["KC", "BUF"],
          sideTeam: "KC",
          line: -1.5,
          riskUsd: 12000,
          distinctAccounts: 2,
          fairProb: 0.52,
          confidence: 70,
          kalshi: { edgeBps: 180, verdict: "watch", reason: "tight" },
        },
        {
          id: "NBA-LAL_BOS-total",
          league: "NBA",
          marketKind: "total",
          teams: ["LAL", "BOS"],
          overUnder: "over",
          line: 224.5,
          riskUsd: 48000,
          distinctAccounts: 4,
          fairProb: 0.58,
          confidence: 85,
          kalshi: { edgeBps: 410, verdict: "actionable", reason: "ok" },
        },
      ],
    });

    const desc = buildSignalArenaView(kalshi.signals, "risk", "descending");
    expect(Array.from(desc.order)).toEqual([1, 0]);
    expect(desc.rows[0]?.[0]).toBe("NBA");
    expect(desc.rows[0]?.[2]).toBe("$48.0K");
    expect(desc.rows[0]?.[5]).toBe("+410 bps");

    const asc = buildSignalArenaView(kalshi.signals, "risk", "ascending");
    expect(Array.from(asc.order)).toEqual([0, 1]);

    // Verify precomputed SignalArenaIndex reuses baseRows references across sort flips + O(1) indexById lookup
    const arenaIdx = buildSignalArenaIndex(kalshi.signals);
    expect(arenaIdx.indexById.get("NBA-LAL_BOS-total")).toBe(1);
    expect(arenaIdx.indexById.get("NFL-BUF_KC-spread")).toBe(0);
    const flipA = sortSignalArenaIndex(arenaIdx, "edge", "descending");
    const flipB = sortSignalArenaIndex(arenaIdx, "edge", "ascending");
    expect(flipA.rows[0]).toBe(flipB.rows[1]);
    expect(flipA.rows[1]).toBe(flipB.rows[0]);

    const plot = buildExposurePlotData(kalshi.signals);
    expect(plot.map((p) => p.riskUsd)).toEqual([12000, 48000]);
  });

  test("buildScoreboardRows filters by league", () => {
    const board = parseScoreboardPayload({
      source: "scoreboard-fixture",
      observedAt: "2026-11-01",
      games: [
        {
          league: "NFL",
          status: "final",
          period: "Final",
          team1: { name: "Vikings", score: 15 },
          team2: { name: "Lions", score: 19 },
        },
        {
          league: "NBA",
          status: "live",
          period: "Q3",
          team1: { name: "Lakers", score: 78 },
          team2: { name: "Celtics", score: 81 },
        },
      ],
    });
    expect(buildScoreboardRows(board.games, "ALL").length).toBe(2);
    expect(buildScoreboardRows(board.games, "NBA")).toEqual([
      ["NBA", "LIVE", "Q3", "Lakers @ Celtics", "78 - 81"],
    ]);
  });

  test("nsh.json enforces minRuntime 0.5.0 and read-only loopback HTTP capabilities", async () => {
    const nshJsonPath = path.join(
      import.meta.dir,
      "..",
      "packages",
      "nsh-desk",
      "nsh.json",
    );
    const manifest = (await Bun.file(nshJsonPath).json()) as {
      id: string;
      minRuntime?: string;
      capabilities: {
        network: {
          hosts?: string[];
          http: Array<{
            host: string;
            methods: string[];
            schemes: string[];
          }>;
        };
        process: { env: string[] };
      };
    };

    expect(manifest.id).toBe("ops.sportsdesk.desk");
    expect(manifest.minRuntime).toBe("0.5.0");
    expect(manifest.capabilities.network.hosts).toBeUndefined();
    expect(manifest.capabilities.network.http).toEqual([
      {
        host: "127.0.0.1",
        methods: ["GET", "HEAD", "POST"],
        schemes: ["http"],
      },
      {
        host: "localhost",
        methods: ["GET", "HEAD", "POST"],
        schemes: ["http"],
      },
    ]);
    expect(manifest.capabilities.process.env).toEqual([
      "SPORTSDESK_ORIGIN",
      "SPORTSDESK_ADMIN_TOKEN",
    ]);
  });

  test("enforces nsh-design-guides ui layer boundary, semantic tokens, and >=12pt type scale", async () => {
    const pkgDir = path.join(import.meta.dir, "..", "packages", "nsh-desk");
    const manifest = (await Bun.file(path.join(pkgDir, "nsh.json")).json()) as {
      theme?: string;
    };
    expect(manifest.theme).toBe("theme.json");

    const themeJson = (await Bun.file(
      path.join(pkgDir, "theme.json"),
    ).json()) as {
      cssVars: {
        theme: Record<string, string>;
        light: Record<string, string>;
        dark: Record<string, string>;
      };
    };
    for (const requiredRole of [
      "positive",
      "warning",
      "negative",
      "prov-internet",
      "prov-blocked",
      "prov-gateway",
      "prov-alert",
      "prov-gsbuilder",
      "prov-gslive",
      "prov-cslevel2",
    ]) {
      expect(typeof themeJson.cssVars.light[requiredRole]).toBe("string");
      expect(typeof themeJson.cssVars.dark[requiredRole]).toBe("string");
    }
    expect(themeJson.cssVars.dark["background"]).toBe("#070b14");
    expect(themeJson.cssVars.dark["card"]).toBe("#0d1527");
    expect(themeJson.cssVars.dark["popover"]).toBe("#131f38");
    expect(themeJson.cssVars.dark["border"]).toBe("#1e293b");

    const designDoc = await Bun.file(path.join(pkgDir, "DESIGN.md")).text();
    expect(designDoc).toContain(
      "## 5. Motion Tokens & Screen Motion Inventory",
    );

    // Feature modules (App.tsx, store.ts) must compose ui/ and never import nsh/base directly.
    for (const featureFile of ["App.tsx", "store.ts"]) {
      const src = await Bun.file(path.join(pkgDir, featureFile)).text();
      expect(src).not.toMatch(/from\s+["']nsh\/base/);
    }

    // Presentation TSX files must not embed raw hex, rgb/hsl, Tailwind palette shades, or sub-12pt sizes.
    const tsxGlob = new Bun.Glob("**/*.tsx");
    for await (const rel of tsxGlob.scan({ cwd: pkgDir })) {
      if (rel.endsWith(".test.tsx")) continue;
      const src = await Bun.file(path.join(pkgDir, rel)).text();
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\s*\(/);
      expect(src).not.toMatch(
        /\b(?:text|bg|border|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/,
      );
      expect(src).not.toMatch(/\btext-\[(?:9|10|11)px\]/);
    }
  });

  test("buildNshArgv preserves -V/--version, <command> --help, signing commands, and tsc -- args", async () => {
    const { buildNshArgv } = await import("../scripts/nsh_desk_cli.ts");
    const appDir = "/repo/packages/nsh-desk";

    expect(buildNshArgv(appDir, [])).toEqual(["check", appDir]);
    expect(buildNshArgv(appDir, ["-V"])).toEqual(["-V"]);
    expect(buildNshArgv(appDir, ["--version"])).toEqual(["--version"]);
    expect(buildNshArgv(appDir, ["--help"])).toEqual(["--help"]);
    expect(buildNshArgv(appDir, ["help", "package"])).toEqual([
      "help",
      "package",
    ]);
    expect(buildNshArgv(appDir, ["run", "--help"])).toEqual(["run", "--help"]);
    expect(buildNshArgv(appDir, ["package-web", "--help"])).toEqual([
      "package",
      "--help",
    ]);
    expect(buildNshArgv(appDir, ["keygen", "keys/root"])).toEqual([
      "keygen",
      "keys/root",
    ]);
    expect(
      buildNshArgv(appDir, ["-v", "run", "--fps", "--port", "8791"]),
    ).toEqual(["-v", "run", appDir, "--fps", "--port", "8791"]);
    expect(buildNshArgv(appDir, ["test", "packages/nsh-desk/App.tsx"])).toEqual(
      ["test", "packages/nsh-desk/App.tsx"],
    );
    expect(buildNshArgv(appDir, ["check", "--", "--pretty", "false"])).toEqual([
      "check",
      appDir,
      "--",
      "--pretty",
      "false",
    ]);
    expect(buildNshArgv(appDir, ["build"])).toEqual([
      "build",
      appDir,
      "-o",
      "/repo/packages/nsh-desk/.nsh/out",
    ]);
    expect(buildNshArgv(appDir, ["build", "-o", "/tmp/custom-out"])).toEqual([
      "build",
      appDir,
      "-o",
      "/tmp/custom-out",
    ]);
    expect(buildNshArgv(appDir, ["package-web"])).toEqual([
      "package",
      appDir,
      "--target",
      "web",
      "-o",
      "/repo/packages/nsh-desk/.nsh/out/web",
    ]);
    expect(
      buildNshArgv(appDir, ["package-web", "-o", "/tmp/web-dist"]),
    ).toEqual(["package", appDir, "--target", "web", "-o", "/tmp/web-dist"]);
    expect(
      buildNshArgv(appDir, [
        "publish",
        "dist/desk.nshpkg",
        "--key",
        "keys/publisher.key",
        "--cert",
        "keys/publisher.cert",
      ]),
    ).toEqual([
      "publish",
      "dist/desk.nshpkg",
      "--key",
      "keys/publisher.key",
      "--cert",
      "keys/publisher.cert",
    ]);
    expect(
      buildNshArgv(appDir, ["init", "new-app", "--template", "rust"]),
    ).toEqual(["init", "new-app", "--template", "rust"]);
    expect(buildNshArgv(appDir, ["verify", "dist/desk.nshpkg"])).toEqual([
      "verify",
      "dist/desk.nshpkg",
    ]);
    expect(
      buildNshArgv(appDir, [
        "certify",
        "--root",
        "keys/root.secret",
        "--key",
        "keys/release.pub",
        "--apps",
        "ops.sportsdesk.desk",
        "-o",
        "keys/release.cert",
      ]),
    ).toEqual([
      "certify",
      "--root",
      "keys/root.secret",
      "--key",
      "keys/release.pub",
      "--apps",
      "ops.sportsdesk.desk",
      "-o",
      "keys/release.cert",
    ]);
    expect(
      buildNshArgv(appDir, [
        "revoke",
        "--root",
        "keys/root.secret",
        "--sequence",
        "1",
        "--package",
        "819f351e8ba9f04c86d575fc0dac49912a2e87f1f9e52ff12d2dd211c66bc778",
        "-o",
        "keys/revocations.bin",
      ]),
    ).toEqual([
      "revoke",
      "--root",
      "keys/root.secret",
      "--sequence",
      "1",
      "--package",
      "819f351e8ba9f04c86d575fc0dac49912a2e87f1f9e52ff12d2dd211c66bc778",
      "-o",
      "keys/revocations.bin",
    ]);
  });

  test("enforces root App.tsx mount(App) ownership, DeskStoreContext, split() ui wrappers, and acyclic components/ boundary", async () => {
    const pkgDir = path.join(import.meta.dir, "..", "packages", "nsh-desk");
    const appSrc = await Bun.file(path.join(pkgDir, "App.tsx")).text();
    const mountCalls = appSrc.match(/\bmount\s*\(/g) ?? [];
    expect(mountCalls.length).toBe(1);
    expect(appSrc).toContain("ErrorBoundary");
    expect(appSrc).toContain("DeskStoreContext.Provider");
    expect(appSrc).toMatch(/from\s+["']\.\/components["']/);

    const storeSrc = await Bun.file(path.join(pkgDir, "store.ts")).text();
    expect(storeSrc).toContain("export const DeskStoreContext = context<");
    expect(storeSrc).toContain("export function useDeskStore(");

    for (const uiWrapper of [
      "Button.tsx",
      "Switch.tsx",
      "Surface.tsx",
      "Field.tsx",
    ]) {
      const uiSrc = await Bun.file(path.join(pkgDir, "ui", uiWrapper)).text();
      expect(uiSrc).toMatch(/\bsplit\s*\(\s*props\b/);
      expect(uiSrc).not.toMatch(/const\s*\{[^}]*\.\.\.rest[^}]*\}\s*=\s*props/);
    }

    const compDir = path.join(pkgDir, "components");
    const compGlob = new Bun.Glob("**/*.{ts,tsx}");
    let compCount = 0;
    let useDeskStoreCount = 0;
    for await (const rel of compGlob.scan({ cwd: compDir })) {
      compCount += 1;
      const src = await Bun.file(path.join(compDir, rel)).text();
      expect(src).not.toMatch(/from\s+["']nsh\/base/);
      expect(src).not.toMatch(/from\s+["']\.\.\/App/);
      expect(src).not.toMatch(/\bmount\s*\(/);
      if (src.includes("useDeskStore(")) {
        useDeskStoreCount += 1;
      }
    }
    expect(compCount).toBeGreaterThanOrEqual(13);
    // Pinned, not loosened: 13 of the 16 components/ files call useDeskStore.
    // A new consumer must update this with its panel registration instead of
    // lowering the floor.
    expect(useDeskStoreCount).toBe(13);
  });

  test("every default workspace panel has an App.tsx switch case and a PANEL_TITLES entry", async () => {
    const pkgDir = path.join(import.meta.dir, "..", "packages", "nsh-desk");
    const storeSrc = await Bun.file(path.join(pkgDir, "store.ts")).text();
    const layout = storeSrc.match(
      /export function defaultWorkspaceLayout\(\): DockAreaLayout \{([\s\S]*?)\n\}/,
    );
    expect(layout).not.toBeNull();
    const panelIds = [
      ...(layout?.[1] ?? "").matchAll(/panels:\s*\[([^\]]*)\]/g),
    ].flatMap((match) =>
      [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((id) => id[1] ?? ""),
    );
    expect(panelIds.length).toBeGreaterThanOrEqual(7);
    expect(new Set(panelIds).size).toBe(panelIds.length);
    // The producer is wired (refreshAll loads the daemon's R2 snapshot route), so
    // the XML odds panel is a default tab again.
    expect(panelIds).toContain("xml_odds");
    expect(storeSrc).toContain("loadXmlOddsSoaFeed(base)");

    const appSrc = await Bun.file(path.join(pkgDir, "App.tsx")).text();
    const switchCases = new Set(
      [...appSrc.matchAll(/case\s+"([^"]+)":/g)].map((match) => match[1] ?? ""),
    );
    // Read PANEL_TITLES from source instead of importing it: provenance.ts imports
    // ../ui, which pulls the nsh-typed ui/*.tsx files into the root TS program.
    const provenanceSrc = await Bun.file(
      path.join(pkgDir, "components", "provenance.ts"),
    ).text();
    const titleBlock = provenanceSrc.match(
      /PANEL_TITLES[^=]*=\s*\{([\s\S]*?)\n\};/,
    );
    expect(titleBlock).not.toBeNull();
    const panelTitles = new Set(
      [...(titleBlock?.[1] ?? "").matchAll(/([A-Za-z_$][\w$]*):\s*"/g)].map(
        (match) => match[1] ?? "",
      ),
    );

    for (const panelId of panelIds) {
      expect(switchCases.has(panelId)).toBe(true);
      expect(panelTitles.has(panelId)).toBe(true);
    }
  });

  test("XML odds table input is bounded to XML_ODDS_ROW_LIMIT and states its truncation", () => {
    const makeFeed = (count: number): XmlOddsFeed => {
      const capacity = Math.max(count, 1);
      const feed: XmlOddsFeed = {
        capacity,
        count,
        eventId32Col: new Uint32Array(capacity),
        packedComboKey15Col: new Uint16Array(capacity),
        lineHundredthsI32Col: new Int32Array(capacity),
      };
      for (let index = 0; index < count; index++) {
        feed.eventId32Col[index] = index + 1;
      }
      return feed;
    };

    expect(XML_ODDS_ROW_LIMIT).toBe(2000);
    expect(xmlOddsRowsHeader(null)).toBe("0 rows");
    expect(xmlOddsRowsHeader(makeFeed(0))).toBe("0 rows");
    expect(xmlOddsRows(makeFeed(0))).toEqual([]);
    expect(xmlOddsRowsHeader(makeFeed(1))).toBe("1 row");
    expect(xmlOddsRowsHeader(makeFeed(3))).toBe("3 rows");
    // Unknown lines append the unit-unconfirmed suffix; all-known feeds carry none.
    expect(xmlOddsRowsHeader({ ...makeFeed(3), lineUnknownCount: 1 })).toBe(
      "3 rows · 1 line unit-unconfirmed",
    );
    expect(xmlOddsRowsHeader({ ...makeFeed(3), lineUnknownCount: 2 })).toBe(
      "3 rows · 2 lines unit-unconfirmed",
    );

    const total = XML_ODDS_ROW_LIMIT + 1;
    const large = makeFeed(total);
    expect(xmlOddsRowsHeader(large)).toBe(
      `Showing first ${XML_ODDS_ROW_LIMIT} of ${total}`,
    );
    expect(xmlOddsRowsHeader({ ...large, lineUnknownCount: 2 })).toBe(
      `Showing first ${XML_ODDS_ROW_LIMIT} of ${total} · 2 lines unit-unconfirmed`,
    );
    const rows = xmlOddsRows(large);
    expect(rows.length).toBe(XML_ODDS_ROW_LIMIT);
    expect(rows[0]?.eventId).toBe(1);
    expect(rows.at(-1)?.eventId).toBe(XML_ODDS_ROW_LIMIT);
    // Capacity is not rows: the bound follows the written count.
    expect(xmlOddsRowsHeader({ ...makeFeed(1), capacity: 5000 })).toBe("1 row");
  });

  test("GET /api/xml-odds/soa parses the canonical R2 chunk and answers an unavailable artifact with its reason", async () => {
    const { handleXmlOddsSoaRequest, readXmlOddsSoaFromR2 } =
      await import("../services/sportsdesk_webview_server.ts");
    const chunkKey = `chunks/${"a".repeat(64)}.bin`;
    const manifestBody = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        domain: "[Ops & Governance]",
        sink_id: "xml-ingest",
        r2_bucket: "sportsdesk-ops-reports",
        generation_u32: 7,
        merkle_root_sha256: "a".repeat(64),
        watermark_cursor: "wm-9",
        data_window_max_epoch_ms: 1700000000000,
        r2_published_at_epoch_ms: 1700000000123,
        chunk_key: chunkKey,
        row_count: 2,
        circuit_state: "CLOSED",
        ...overrides,
      });
    const chunkBody = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sportsdeskXmlFeed watermarkCursor="wm-9" dataWindowMaxEpochMs="1700000000000" rowCount="2">',
      '<event id="11" subSportCode6="2" wagerTypeCode3="1" periodCode4="3" marketKindCode2="1" lineHundredths="350"/>',
      '<event id="12" subSportCode6="4" wagerTypeCode3="0" periodCode4="0" marketKindCode2="2" lineHundredths="-110"/>',
      "</sportsdeskXmlFeed>",
    ].join("");
    const okFetch = async (url: string): Promise<Response> =>
      url.endsWith("/manifests/xml-ingest/latest")
        ? new Response(manifestBody(), { status: 200 })
        : new Response(chunkBody, { status: 200 });
    const missingManifestFetch = async (): Promise<Response> =>
      new Response("not found", { status: 404 });

    const outcome = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: okFetch,
    });
    expect(outcome.available).toBe(true);
    if (outcome.available) {
      expect(outcome.payload.rowCount).toBe(2);
      expect(outcome.payload.eventId32).toEqual([11, 12]);
      // [14:9] subSport6 | [8:6] wagerType3 | [5:2] period4 | [1:0] marketKind2
      expect(outcome.payload.comboKey15).toEqual([1101, 2050]);
      expect(outcome.payload.lineHundredths).toEqual([350, -110]);
      // One bitset word for two rows; no bit set means every line is known.
      expect(outcome.payload.lineUnknownFlags).toEqual([0]);
      expect(outcome.payload.lineUnknownCount).toBe(0);
      expect(outcome.payload.watermarkCursor).toBe("wm-9");
      expect(outcome.payload.generatedAt).toBe("2023-11-14T22:13:20.123Z");
      expect(outcome.payload.basis).toBe("r2-xml-ingest");
    }

    const missing = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: missingManifestFetch,
    });
    expect(missing.available).toBe(false);
    if (!missing.available) {
      expect(missing.reason).toContain("manifest");
      expect(missing.reason).toContain("404");
    }

    const readyResponse = await handleXmlOddsSoaRequest(
      new Request("http://127.0.0.1:4020/api/xml-odds/soa"),
      { publicBase: "https://r2.example", fetchImpl: okFetch },
    );
    expect(readyResponse.status).toBe(200);
    const body = (await readyResponse.json()) as {
      success: boolean;
      rowCount: number;
      eventId32: number[];
      comboKey15: number[];
      lineUnknownFlags: number[];
      lineUnknownCount: number;
    };
    expect(body.success).toBe(true);
    expect(body.rowCount).toBe(2);
    expect(body.eventId32).toEqual([11, 12]);
    expect(body.comboKey15).toEqual([1101, 2050]);
    expect(body.lineUnknownFlags).toEqual([0]);
    expect(body.lineUnknownCount).toBe(0);

    // A missing artifact is a stated 502, never an empty 200.
    const unavailableResponse = await handleXmlOddsSoaRequest(
      new Request("http://127.0.0.1:4020/api/xml-odds/soa"),
      { publicBase: "https://r2.example", fetchImpl: missingManifestFetch },
    );
    expect(unavailableResponse.status).toBe(502);
    const unavailableBody = (await unavailableResponse.json()) as {
      success: boolean;
      status: string;
      error: string;
    };
    expect(unavailableBody.success).toBe(false);
    expect(unavailableBody.status).toBe("unavailable");
    expect(unavailableBody.error).toContain("manifest");

    const refused = await handleXmlOddsSoaRequest(
      new Request("http://127.0.0.1:4020/api/xml-odds/soa", {
        method: "POST",
      }),
      { publicBase: "https://r2.example", fetchImpl: okFetch },
    );
    expect(refused.status).toBe(405);

    const preflight = await handleXmlOddsSoaRequest(
      new Request("http://127.0.0.1:4020/api/xml-odds/soa", {
        method: "OPTIONS",
      }),
      { corsHeadersFor: () => ({ "Access-Control-Allow-Origin": "*" }) },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Allow")).toBe("GET, OPTIONS");
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("GET /api/xml-odds/soa accepts explicit unknown lines and rejects count disagreements", async () => {
    const { readXmlOddsSoaFromR2 } =
      await import("../services/sportsdesk_webview_server.ts");
    const chunkKey = `chunks/${"b".repeat(64)}.bin`;
    const knownEvent = (id: number, line: string): string =>
      `<event id="${id}" subSportCode6="2" wagerTypeCode3="1" periodCode4="3" marketKindCode2="1" lineHundredths="${line}"/>`;
    const unknownEvent = (id: number): string =>
      `<event id="${id}" subSportCode6="2" wagerTypeCode3="1" periodCode4="3" marketKindCode2="1" lineUnknown="1"/>`;
    const chunkBody = (rootAttrs: string, events: readonly string[]): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<sportsdeskXmlFeed watermarkCursor="wm-11" dataWindowMaxEpochMs="1700000000000" rowCount="${events.length}"${rootAttrs}>${events.join("")}</sportsdeskXmlFeed>`;
    const manifestBody = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        domain: "[Ops & Governance]",
        sink_id: "xml-ingest",
        r2_bucket: "sportsdesk-ops-reports",
        generation_u32: 8,
        merkle_root_sha256: "b".repeat(64),
        watermark_cursor: "wm-11",
        data_window_max_epoch_ms: 1700000000000,
        r2_published_at_epoch_ms: 1700000000123,
        chunk_key: chunkKey,
        row_count: 2,
        line_unknown_count: 1,
        circuit_state: "CLOSED",
        ...overrides,
      });
    const fetchFor =
      (chunkText: string, manifestText: string) =>
      async (url: string): Promise<Response> =>
        url.endsWith("/manifests/xml-ingest/latest")
          ? new Response(manifestText, { status: 200 })
          : new Response(chunkText, { status: 200 });

    // Explicit unknown line: root + manifest counts agree, the route reports the flag and 0 sentinel.
    const unknown = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: fetchFor(
        chunkBody(' lineUnknownCount="1"', [
          knownEvent(11, "350"),
          unknownEvent(12),
        ]),
        manifestBody(),
      ),
    });
    expect(unknown.available).toBe(true);
    if (unknown.available) {
      expect(unknown.payload.lineHundredths).toEqual([350, 0]);
      // Bit 1 set: the second row's unit is unknown.
      expect(unknown.payload.lineUnknownFlags).toEqual([0b10]);
      expect(unknown.payload.lineUnknownCount).toBe(1);
    }

    // Root @lineUnknownCount disagreeing with the flagged rows is a stated 502.
    const rootMismatch = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: fetchFor(
        chunkBody(' lineUnknownCount="0"', [
          knownEvent(11, "350"),
          unknownEvent(12),
        ]),
        manifestBody(),
      ),
    });
    expect(rootMismatch.available).toBe(false);
    if (!rootMismatch.available) {
      expect(rootMismatch.reason).toContain("@lineUnknownCount");
      expect(rootMismatch.reason).toContain("unknown");
    }

    // Manifest line_unknown_count disagreeing with the chunk is a stated 502.
    const manifestMismatch = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: fetchFor(
        chunkBody(' lineUnknownCount="1"', [
          knownEvent(11, "350"),
          unknownEvent(12),
        ]),
        manifestBody({ line_unknown_count: 2 }),
      ),
    });
    expect(manifestMismatch.available).toBe(false);
    if (!manifestMismatch.available) {
      expect(manifestMismatch.reason).toContain("line_unknown_count");
    }

    // A row claiming both a flag and a value is inconsistent, not "known wins".
    const bothAttrs = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: fetchFor(
        chunkBody(' lineUnknownCount="1"', [
          knownEvent(11, "350"),
          `<event id="12" subSportCode6="2" wagerTypeCode3="1" periodCode4="3" marketKindCode2="1" lineUnknown="1" lineHundredths="0"/>`,
        ]),
        manifestBody(),
      ),
    });
    expect(bothAttrs.available).toBe(false);
    if (!bothAttrs.available) {
      expect(bothAttrs.reason).toContain(
        "both @lineUnknown and @lineHundredths",
      );
    }

    // Backward compatibility: a chunk/manifest written before the unknown-line contract is all-known.
    const legacy = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: fetchFor(
        chunkBody("", [knownEvent(11, "350"), knownEvent(12, "-110")]),
        manifestBody({ line_unknown_count: undefined }),
      ),
    });
    expect(legacy.available).toBe(true);
    if (legacy.available) {
      expect(legacy.payload.lineUnknownFlags).toEqual([0]);
      expect(legacy.payload.lineUnknownCount).toBe(0);
    }
  });

  test("GET /api/xml-odds/soa bounds the public-R2 reads (1 MiB manifest, 32 MiB chunk)", async () => {
    const {
      MAX_XML_ODDS_CHUNK_BYTES,
      MAX_XML_ODDS_MANIFEST_BYTES,
      readXmlOddsSoaFromR2,
    } = await import("../services/sportsdesk_webview_server.ts");
    expect(MAX_XML_ODDS_MANIFEST_BYTES).toBe(1024 * 1024);
    expect(MAX_XML_ODDS_CHUNK_BYTES).toBe(32 * 1024 * 1024);

    // A declared content-length over the manifest cap is refused before the body is read.
    const oversizedManifest = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: async () => {
        const response = new Response("{}", { status: 200 });
        response.headers.set(
          "content-length",
          String(MAX_XML_ODDS_MANIFEST_BYTES + 1),
        );
        return response;
      },
    });
    expect(oversizedManifest.available).toBe(false);
    if (!oversizedManifest.available) {
      expect(oversizedManifest.reason).toContain("content-length");
      expect(oversizedManifest.reason).toContain("cap");
    }

    // An oversized chunk body without a content-length is refused after the bounded read.
    const manifestText = JSON.stringify({
      generation_u32: 8,
      merkle_root_sha256: "b".repeat(64),
      watermark_cursor: "wm-11",
      data_window_max_epoch_ms: 1700000000000,
      r2_published_at_epoch_ms: 1700000000123,
      chunk_key: `chunks/${"b".repeat(64)}.bin`,
      row_count: 1,
    });
    const oversizedChunk = await readXmlOddsSoaFromR2({
      publicBase: "https://r2.example",
      fetchImpl: async (url) =>
        url.endsWith("/manifests/xml-ingest/latest")
          ? new Response(manifestText, { status: 200 })
          : new Response(new Uint8Array(MAX_XML_ODDS_CHUNK_BYTES + 1)),
    });
    expect(oversizedChunk.available).toBe(false);
    if (!oversizedChunk.available) {
      expect(oversizedChunk.reason).toContain("bytes exceeds");
      expect(oversizedChunk.reason).toContain("cap");
    }

    // Source contract: the XML-odds reader decodes bounded bytes under the caps, never response.text().
    const serviceSrc = await Bun.file(
      path.join(
        import.meta.dir,
        "..",
        "services",
        "sportsdesk_webview_server.ts",
      ),
    ).text();
    const sectionStart = serviceSrc.indexOf(
      "XML odds SoA snapshot (public R2)",
    );
    const sectionEnd = serviceSrc.indexOf(
      "export function withXmlOddsSoaEndpoint",
    );
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = serviceSrc.slice(sectionStart, sectionEnd);
    expect(section).toContain("MAX_XML_ODDS_MANIFEST_BYTES");
    expect(section).toContain("MAX_XML_ODDS_CHUNK_BYTES");
    expect(section).toContain("arrayBuffer()");
    expect(section).not.toContain("response.text()");
  });

  test("the desk XML odds loader turns the route body into typed columns and keeps the failure reason", async () => {
    const loaded = await loadXmlOddsSoaFeed(
      "http://127.0.0.1:4020/",
      async () =>
        Response.json({
          success: true,
          rowCount: 2,
          eventId32: [11, 12],
          comboKey15: [1101, 2050],
          lineHundredths: [350, -110],
          watermarkCursor: "wm-9",
          generatedAt: "2023-11-14T22:13:20.123Z",
          basis: "r2-xml-ingest",
        }),
    );
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.feed.eventId32Col).toBeInstanceOf(Uint32Array);
      expect(loaded.feed.packedComboKey15Col).toBeInstanceOf(Uint16Array);
      expect(loaded.feed.lineHundredthsI32Col).toBeInstanceOf(Int32Array);
      expect(Array.from(loaded.feed.eventId32Col)).toEqual([11, 12]);
      expect(loaded.feed.count).toBe(2);
      expect(loaded.provenance).toEqual({
        basis: "r2-xml-ingest",
        generatedAt: "2023-11-14T22:13:20.123Z",
        watermarkCursor: "wm-9",
        rowCount: 2,
      });
      // A route body without lineUnknown (pre-tri-state producer) is an all-known snapshot.
      expect(loaded.feed.lineUnknownCount).toBe(0);
      expect(xmlOddsRowsHeader(loaded.feed)).toBe("2 rows");
    }

    // Unknown rows arrive as the route's dense bitset word and stay a bitset in the feed.
    const withUnknown = await loadXmlOddsSoaFeed(
      "http://127.0.0.1:4020",
      async () =>
        Response.json({
          success: true,
          rowCount: 2,
          eventId32: [11, 12],
          comboKey15: [1101, 2050],
          lineHundredths: [350, 0],
          lineUnknownFlags: [0b10],
          lineUnknownCount: 1,
          watermarkCursor: "wm-9",
          generatedAt: "2023-11-14T22:13:20.123Z",
          basis: "r2-xml-ingest",
        }),
    );
    expect(withUnknown.ok).toBe(true);
    if (withUnknown.ok) {
      expect(withUnknown.feed.lineUnknownFlags).toBeInstanceOf(Uint32Array);
      expect(withUnknown.feed.lineUnknownCount).toBe(1);
      expect(isXmlOddsLineUnknown(withUnknown.feed, 0)).toBe(false);
      expect(isXmlOddsLineUnknown(withUnknown.feed, 1)).toBe(true);
      expect(readXmlOddsRow(withUnknown.feed, 1)).toMatchObject({
        lineKnown: false,
        line: "—",
      });
      expect(xmlOddsRowsHeader(withUnknown.feed)).toBe(
        "2 rows · 1 line unit-unconfirmed",
      );
    }

    const unavailable = await loadXmlOddsSoaFeed(
      "http://127.0.0.1:4020",
      async () =>
        Response.json(
          {
            success: false,
            status: "unavailable",
            error:
              "R2 manifest manifests/xml-ingest/latest unavailable: HTTP 404",
          },
          { status: 502 },
        ),
    );
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.code).toBe("http_502");
      expect(unavailable.reason).toContain("R2 manifest");
    }

    // The daemon route's own parser rejects a malformed column instead of zeroing it.
    expect(() =>
      parseXmlOddsSoaPayload({
        rowCount: 1,
        eventId32: [1],
        comboKey15: [0x8000],
        lineHundredths: [0],
        watermarkCursor: "wm-9",
        generatedAt: "2023-11-14T22:13:20.123Z",
        basis: "r2-xml-ingest",
      }),
    ).toThrow(/comboKey15/);

    // Unknown-line payload validation: wrong length, wrong element type, count mismatch,
    // and a count without the array are each rejected instead of guessed.
    const validUnknownBase = {
      rowCount: 2,
      eventId32: [1, 2],
      comboKey15: [0, 1],
      lineHundredths: [350, 0],
      watermarkCursor: "wm-9",
      generatedAt: "2023-11-14T22:13:20.123Z",
      basis: "r2-xml-ingest",
    };
    expect(
      parseXmlOddsSoaPayload({
        ...validUnknownBase,
        lineUnknownFlags: [0b10],
        lineUnknownCount: 1,
      }).lineUnknownCount,
    ).toBe(1);
    expect(parseXmlOddsSoaPayload(validUnknownBase).lineUnknownCount).toBe(0);
    expect(() =>
      parseXmlOddsSoaPayload({ ...validUnknownBase, lineUnknownFlags: [] }),
    ).toThrow(/lineUnknownFlags/);
    expect(() =>
      parseXmlOddsSoaPayload({
        ...validUnknownBase,
        lineUnknownFlags: [0x1_0000_0000],
      }),
    ).toThrow(/lineUnknownFlags\[0\]/);
    expect(() =>
      parseXmlOddsSoaPayload({
        ...validUnknownBase,
        lineUnknownFlags: [0b10],
        lineUnknownCount: 2,
      }),
    ).toThrow(/lineUnknownCount/);
    expect(() =>
      parseXmlOddsSoaPayload({
        ...validUnknownBase,
        lineUnknownCount: 1,
      }),
    ).toThrow(/without lineUnknownFlags/);
  });

  test("the XML odds poll is due on first load and every 60s after", () => {
    expect(XML_ODDS_POLL_INTERVAL_MS).toBe(60_000);
    // Never loaded: due at once, whatever the clock says.
    expect(isXmlOddsPollDue(0, 0)).toBe(true);
    expect(isXmlOddsPollDue(500_000, 0)).toBe(true);
    // 59_999ms after the last load: not yet; exactly 60_000ms: due.
    expect(isXmlOddsPollDue(159_999, 100_000)).toBe(false);
    expect(isXmlOddsPollDue(160_000, 100_000)).toBe(true);
    expect(isXmlOddsPollDue(160_001, 100_000)).toBe(true);
    // A different cadence is the third argument.
    expect(isXmlOddsPollDue(4_999, 1_000, 4_000)).toBe(false);
    expect(isXmlOddsPollDue(5_000, 1_000, 4_000)).toBe(true);
  });

  test("the store throttles the auto-poll and forces boot, manual, Retry and sweep XML odds loads", async () => {
    const storeSrc = await Bun.file(
      path.join(import.meta.dir, "..", "packages", "nsh-desk", "store.ts"),
    ).text();

    // The pure cadence helper is what the store consults, keyed on a recorded time.
    expect(storeSrc).toContain("isXmlOddsPollDue(");
    expect(storeSrc).toContain("lastXmlOddsPollMs");

    // The 10s auto-poll is the only unforced caller, and it says so explicitly.
    expect(storeSrc).toMatch(
      /setInterval\(\(\) => \{\s*if \(autoPoll\(\)\) \{\s*void refreshAll\(\{ forceXmlOdds: false \}\);/,
    );
    // A manual `store.refreshAll()` (Refresh, Retry, menus) forces by default.
    expect(storeSrc).toContain(
      "const forceXmlOdds = options.forceXmlOdds ?? true;",
    );
    // Boot and the parity sweep force explicitly.
    expect(storeSrc).toContain("void refreshAll({ forceXmlOdds: true });");
    expect(storeSrc).toMatch(
      /refreshAll\(\{ forceXmlOdds: true \}\),\s*\n\s*loadExecutionPlan\(\),/,
    );
    // A skipped poll writes nothing; a completed one records its time (ready or unavailable).
    expect(storeSrc).toMatch(
      /if \(nextXmlOdds !== null\) \{\s*applyXmlOddsLoad\(nextXmlOdds\);[\s\S]*?lastXmlOddsPollMs = Date\.now\(\);/,
    );
    expect(storeSrc).not.toMatch(/nextXmlOdds === null[^\n]*xmlOddsFeed/);
  });

  test("round-trips workspace Storage preferences and builds signal-honest diagnostics JSON", () => {
    expect(DESK_PREFS_STORAGE_KEY).toBe("ops.sportsdesk.desk.prefs.v1");
    expect(parseWorkspacePrefsJson(null)).toEqual(defaultWorkspacePrefs());
    expect(parseWorkspacePrefsJson("{broken")).toEqual(defaultWorkspacePrefs());

    const encoded = serializeWorkspacePrefs({
      schemaVersion: 1,
      leagueFilter: "NHL",
      autoPoll: true,
      locked: true,
      dockOpen: { left: false, bottom: true },
    });
    expect(parseWorkspacePrefsJson(encoded)).toEqual({
      schemaVersion: 1,
      leagueFilter: "NHL",
      autoPoll: true,
      locked: true,
      dockOpen: { left: false, bottom: true },
    });

    const snapshotRaw = buildDiagnosticsSnapshotJson({
      origin: { origin: "http://127.0.0.1:4020", source: "default:4020" },
      pollCount: 3,
      lastPollMs: 19,
      endpoints: [
        {
          status: "ready",
          endpoint: "/api/kpis",
          httpStatus: 200,
          fetchedAtIso: "2026-11-10T20:00:00.000Z",
          data: { generatedAt: null, cards: [], r2Sinks: [] },
        },
        {
          status: "unavailable",
          endpoint: "/api/live-bets/summary",
          httpStatus: 503,
          code: "unauthorized",
          cause: "/api/live-bets/summary HTTP 503 [unauthorized]: 401",
          fetchedAtIso: "2026-11-10T20:00:00.000Z",
        },
      ],
      liveBets: {
        status: "unavailable",
        endpoint: "/api/live-bets/summary",
        httpStatus: 503,
        code: "unauthorized",
        cause: "/api/live-bets/summary HTTP 503 [unauthorized]: 401",
        fetchedAtIso: "2026-11-10T20:00:00.000Z",
      },
      r2Sinks: [
        {
          sink: "f402-weblog",
          state: "fresh",
          publishAgeSeconds: 120,
          publishStale: false,
          dataAgeSeconds: 95000,
          dataStale: true,
          windowDivergent: true,
          reason: "fresh upload, stale window",
        },
      ],
    });
    const parsed = JSON.parse(snapshotRaw) as {
      appId: string;
      liveBetsSummary: unknown;
      endpoints: Array<{ endpoint: string; code?: string }>;
      r2Sinks: Array<{ windowDivergent: boolean }>;
    };
    expect(parsed.appId).toBe("ops.sportsdesk.desk");
    expect(parsed.liveBetsSummary).toBeNull();
    expect(parsed.endpoints[1]?.code).toBe("unauthorized");
    expect(parsed.r2Sinks[0]?.windowDivergent).toBe(true);
  });

  test("nsh_desk_cli uses Bun globals (no node:fs), parses CLI output/modes/semver, and hashes artifacts", async () => {
    const cliPath = path.join(
      import.meta.dir,
      "..",
      "scripts",
      "nsh_desk_cli.ts",
    );
    const cliSrc = await Bun.file(cliPath).text();
    expect(cliSrc).not.toMatch(/from\s+["']node:fs/);

    const {
      collectNshBuildArtifacts,
      detectNshProjectMode,
      InspectableNshArtifactsReport,
      InspectableNshSignVerifyReport,
      parseNshCliOutput,
      parseNshKeygenId,
      parseNshVerifyOutput,
      parseNshVersionOutput,
      PINNED_NSH_RELEASE,
      runNshSignVerify,
      summarizeNshManifest,
      tryResolveNshBinary,
    } = await import("../scripts/nsh_desk_cli.ts");

    expect(
      parseNshKeygenId(
        "key 6cc10d57ae61ddcb: /tmp/root.secret (keep it secret), /tmp/root.pub\n",
      ),
    ).toBe("6cc10d57ae61ddcb");
    expect(
      parseNshVerifyOutput(
        "valid: ops.sportsdesk.desk 0.1.0 (build 1), release key 1FC87B89F4B58E40, sha256 562e8b31deb05abc0906f38da491212996546665a4e719cfb1fb5e021694ac2f, 0 assets, bytecode for this runtime\n",
      ),
    ).toEqual({
      valid: true,
      appId: "ops.sportsdesk.desk",
      version: "0.1.0",
      build: 1,
      releaseKeyId: "1fc87b89f4b58e40",
      sha256:
        "562e8b31deb05abc0906f38da491212996546665a4e719cfb1fb5e021694ac2f",
      raw: "valid: ops.sportsdesk.desk 0.1.0 (build 1), release key 1FC87B89F4B58E40, sha256 562e8b31deb05abc0906f38da491212996546665a4e719cfb1fb5e021694ac2f, 0 assets, bytecode for this runtime",
    });

    const repoRoot = path.join(import.meta.dir, "..");
    const maybeNsh = await tryResolveNshBinary(repoRoot);
    // The sign flow needs a runtime at least as new as the manifest's
    // minRuntime: a stale local nsh cannot build a pinned app. Gate on the
    // probe and say why we skipped instead of failing every 0.4.0 host.
    const localNshVersion =
      maybeNsh === null
        ? null
        : (() => {
            const probe = Bun.spawnSync([maybeNsh.bin, "--version"], {
              stdout: "pipe",
              stderr: "pipe",
            });
            return parseNshVersionOutput(
              `${probe.stdout.toString()}${probe.stderr.toString()}`,
            ).semver;
          })();
    const runtimeMeetsPin =
      localNshVersion !== null &&
      Bun.semver.satisfies(localNshVersion, `>=${PINNED_NSH_RELEASE.version}`);
    if (maybeNsh !== null && runtimeMeetsPin) {
      const signReport = await runNshSignVerify(
        repoRoot,
        path.join(repoRoot, "packages", "nsh-desk"),
        { quiet: true },
      );
      expect(signReport.ok).toBe(true);
      expect(signReport.appId).toBe("ops.sportsdesk.desk");
      expect(signReport.verifiedValid).toBe(true);
      expect(signReport.revocationRejected).toBe(true);
      expect(signReport.packageBytes).toBeGreaterThan(10_000);
      expect(signReport.packageSha256).toMatch(/^[0-9a-f]{64}$/);
      const signInspect = inspectReport(
        new InspectableNshSignVerifyReport(signReport),
        { colors: false, depth: 4, sorted: false, compact: false },
      );
      expect(signInspect).toContain("NSH Sign & Verify");
      expect(signInspect).toContain("ops.sportsdesk.desk");
    } else if (maybeNsh !== null) {
      console.warn(
        `[nsh] sign/verify skipped: local nsh ${localNshVersion ?? "unknown"} < pinned ${PINNED_NSH_RELEASE.version}`,
      );
    }

    expect(PINNED_NSH_RELEASE.version).toBe("0.5.0");
    expect(PINNED_NSH_RELEASE.commit).toBe(
      "f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1",
    );
    expect(PINNED_NSH_RELEASE.shortSha).toBe("f4d68f7");

    const installSh = await Bun.file(
      path.join(import.meta.dir, "..", "scripts", "ci", "install-nsh.sh"),
    ).text();
    expect(installSh).toContain(`PINNED_TAG="${PINNED_NSH_RELEASE.tag}"`);
    expect(installSh).toContain(
      `PINNED_SHORT_SHA="${PINNED_NSH_RELEASE.shortSha}"`,
    );
    expect(installSh).toContain(PINNED_NSH_RELEASE.sha256["linux-x86_64"]);
    expect(installSh).toContain(PINNED_NSH_RELEASE.sha256["macos-arm64"]);

    const nshManifestSummary = summarizeNshManifest(
      await Bun.file(
        path.join(import.meta.dir, "..", "packages", "nsh-desk", "nsh.json"),
      ).json(),
    );
    expect(nshManifestSummary.minRuntime).toBe(PINNED_NSH_RELEASE.version);

    const ver = parseNshVersionOutput(
      "\u001b[32mnsh 0.5.0 (f4d68f7)\u001b[0m\n",
    );
    expect(ver).toEqual({
      raw: "nsh 0.5.0 (f4d68f7)",
      semver: "0.5.0",
      gitSha: "f4d68f7",
    });
    expect(Bun.semver.satisfies(ver.semver!, ">=0.5.0")).toBe(true);

    expect(detectNshProjectMode({ name: "Desk" })).toBe("tsx");
    expect(detectNshProjectMode({ rust: "native" })).toBe("mixed");
    expect(
      detectNshProjectMode({ rust: "native", root: "desk_app::root" }),
    ).toBe("rust");

    const stream = parseNshCliOutput(
      [
        "\u001b[32m✓\u001b[0m built App.tsx into .nsh/out (32ms)",
        "→ http://127.0.0.1:8787",
        "• connected macOS host",
        "\u001b[33mwarn:\u001b[0m unknown class bg-bogus",
        "error: type check failed",
        "desk poll #1 completed",
      ].join("\n"),
    );
    expect(stream.steps).toEqual(["built App.tsx into .nsh/out (32ms)"]);
    expect(stream.urls).toEqual(["http://127.0.0.1:8787"]);
    expect(stream.events).toEqual(["connected macOS host"]);
    expect(stream.warnings).toEqual(["warn: unknown class bg-bogus"]);
    expect(stream.errors).toEqual(["error: type check failed"]);
    expect(stream.logs).toEqual(["desk poll #1 completed"]);

    const scratchOut = await mkdtemp(path.join(tmpdir(), "nsh-artifacts-"));
    try {
      await Bun.write(path.join(scratchOut, "bundle.nshc"), "bytecode-payload");
      await Bun.write(path.join(scratchOut, "capabilities.json"), "{}");
      const inv = await collectNshBuildArtifacts(scratchOut);
      expect(inv.exists).toBe(true);
      expect(inv.totalFiles).toBe(2);
      expect(inv.artifacts.map((a) => a.kind)).toEqual([
        "bytecode",
        "capabilities",
      ]);
      expect(inv.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

      const rendered = inspectReport(new InspectableNshArtifactsReport(inv), {
        colors: false,
        depth: 4,
        sorted: false,
        compact: false,
      });
      expect(rendered).toContain("bundle.nshc");
      expect(rendered).toContain("capabilities.json");
    } finally {
      await rm(scratchOut, { recursive: true, force: true });
    }
  });

  test("import { YAML } from 'bun' parses scalars/collections, validates NSH SKILL.md frontmatter, and emits --yaml reports", async () => {
    expect(YAML.parse("123")).toBe(123);
    expect(YAML.parse("null")).toBeNull();
    expect(YAML.parse("false")).toBe(false);
    expect(YAML.parse("abc")).toBe("abc");
    expect(YAML.parse("- abc")).toEqual(["abc"]);
    expect(YAML.parse("abc: def")).toEqual({ abc: "def" });

    const {
      formatCliReportOutput,
      InspectableNshVerifyReport,
      parseSkillFrontmatterYaml,
      resolveCliReportFormat,
    } = await import("../scripts/nsh_desk_cli.ts");

    expect(resolveCliReportFormat([])).toBe("inspect");
    expect(resolveCliReportFormat(["--json"])).toBe("json");
    expect(resolveCliReportFormat(["--yaml"])).toBe("yaml");
    expect(resolveCliReportFormat(["--format=yaml"])).toBe("yaml");
    expect(resolveCliReportFormat(["--format", "yaml"])).toBe("yaml");

    const repoRoot = path.join(import.meta.dir, "..");
    const nshSkillMd = await Bun.file(
      path.join(repoRoot, ".agents", "skills", "nsh", "SKILL.md"),
    ).text();
    const guidesSkillMd = await Bun.file(
      path.join(repoRoot, ".agents", "skills", "nsh-design-guides", "SKILL.md"),
    ).text();

    const nshFm = parseSkillFrontmatterYaml(nshSkillMd);
    const guidesFm = parseSkillFrontmatterYaml(guidesSkillMd);
    expect(nshFm.name).toBe("nsh");
    expect(nshFm.description.length).toBeGreaterThan(20);
    expect(guidesFm.name).toBe("nsh-design-guides");
    expect(guidesFm.description.length).toBeGreaterThan(20);

    expect(() => parseSkillFrontmatterYaml("# no frontmatter")).toThrow(
      /missing YAML frontmatter/,
    );
    expect(() => parseSkillFrontmatterYaml("---\n- abc\n---\n")).toThrow(
      /must parse to a key-value mapping/,
    );

    const sampleReport = {
      ok: true,
      allowWarnings: false,
      totalDurationMs: 42.5,
      steps: [
        {
          step: "check" as const,
          exitCode: 0,
          durationMs: 42.5,
          stepCount: 0,
          warningCount: 0,
          errorCount: 0,
          warnings: [],
          errors: [],
        },
      ],
    };
    const yamlText = formatCliReportOutput(
      sampleReport,
      new InspectableNshVerifyReport(sampleReport),
      "yaml",
    );
    expect(YAML.parse(yamlText)).toEqual(sampleReport);
  });

  test("DESK_ENDPOINT_CATALOG achieves 100% route parity with services/sportsdesk_webview_server.ts", async () => {
    expect(DESK_ENDPOINT_CATALOG.length).toBe(52);
    expect(PARSER_WORKBENCH_PRESETS.length).toBe(9);

    const registeredPaths = new Set<string>();
    for (const entry of DESK_ENDPOINT_CATALOG) {
      registeredPaths.add(entry.path);
      for (const alias of entry.aliases) {
        registeredPaths.add(alias);
      }
    }

    const serverSrc = await Bun.file(
      path.join(
        import.meta.dir,
        "..",
        "services",
        "sportsdesk_webview_server.ts",
      ),
    ).text();
    const routeMatches = [
      ...serverSrc.matchAll(
        /pathname\s*===\s*"([^"]+)"|pathname\.startsWith\(\s*"([^"]+)"\s*\)/g,
      ),
    ]
      .map((m) => m[1] ?? m[2])
      .filter((r): r is string => typeof r === "string");

    const dataRoutes = [...new Set(routeMatches)].filter(
      (route) =>
        route.startsWith("/api/") ||
        route === "/health" ||
        route === "/status.json" ||
        route === "/governance" ||
        route === "/governance.json" ||
        route === "/graph-live-feed.json",
    );

    expect(dataRoutes.length).toBeGreaterThanOrEqual(40);
    const missing = dataRoutes.filter((r) => !registeredPaths.has(r));
    expect(missing).toEqual([]);
  });

  test("synthesizes Stocks market instruments, Prev close/Turnover quotes, 10-level ladders, and multi-plane parsers", () => {
    const kalshi = parseKalshiPayload({
      kalshi: { ok: true, degraded: false },
      signals: [
        {
          id: "NBA-BOS_LAL-1q_total-55.5-over",
          league: "NBA",
          marketKind: "1q_total",
          teams: ["LAL", "BOS"],
          line: 55.5,
          overUnder: "over",
          distinctAccounts: 3,
          riskUsd: 27700,
          fairProb: 0.54,
          confidence: 72,
          kalshi: {
            edgeBps: 380,
            verdict: "actionable",
            reason: "tight spread",
          },
          accounts: [
            {
              login: "MJ102",
              agentId: "MJ2026",
              archetype: "Whale",
              riskUsd: 16200,
            },
          ],
        },
        {
          id: "NHL-EDM_VAN-total-6.5-under",
          league: "NHL",
          marketKind: "total",
          teams: ["EDM", "VAN"],
          line: 6.5,
          overUnder: "under",
          distinctAccounts: 1,
          riskUsd: 4200,
          fairProb: 0.44,
          confidence: 51,
          kalshi: { edgeBps: -190, verdict: "pass", reason: "wide spread" },
          accounts: [],
        },
      ],
    });

    const graphFeed = parseGraphFeedPayload({
      schemaVersion: 3,
      dataMode: "LIVE",
      activeSyndicateWalletsCount: 2,
      configuredWalletsCount: 4,
      totalOpenLegsCount: 3,
      totalOpenExposureUsd: 31900,
      pendingBets: [
        {
          id: "p1",
          login: "WHALE77",
          league: "NBA",
          selection: "BOS Over 55.5",
          riskUsd: 12000,
          sharpScore: 90,
        },
      ],
      walletProfiles: [
        { label: "WHALE77", archetype: "Syndicate", openExposureUsd: 20000 },
      ],
      perOfficeIpTrackerClusters: [
        {
          clusterId: "C1",
          office: "BILLY666",
          accountCount: 2,
          ipPrefix: "10.0.0.0/24",
        },
      ],
      backtest4Wk: {
        weeks: [
          { week: "W1", estimatedSavingsUsd: 8400, holdImprovementBps: 60 },
        ],
      },
    });

    const instruments = synthesizeMarketInstruments(kalshi.signals, graphFeed);
    expect(instruments.length).toBe(2);
    const first = instruments[0]!;
    expect(first.quote.last).toBeCloseTo(54, 1);
    expect(first.quote.prevClose).toBeLessThan(first.quote.last);
    expect(first.quote.riskUsd).toBe(27700);
    expect(first.book.bids.length).toBe(10);
    expect(first.book.asks.length).toBe(10);
    expect(first.periods["intraday"].length).toBeGreaterThanOrEqual(16);
    expect(first.trades.some((t) => t.isBlock)).toBe(true);

    expect(
      filterMarketInstruments(instruments, "gainers").map((m) => m.id),
    ).toEqual(["NBA-BOS_LAL-1q_total-55.5-over"]);
    expect(
      filterMarketInstruments(instruments, "losers").map((m) => m.id),
    ).toEqual(["NHL-EDM_VAN-total-6.5-under"]);

    const composite = computeMarketComposite(instruments);
    expect(composite.advancers).toBe(1);
    expect(composite.decliners).toBe(1);
    expect(composite.totalRiskUsd).toBe(31900);
    expect(composite.leagues.length).toBe(2);

    const plan = parseExecutionPlanPayload({
      mode: "paper",
      style: "maker",
      killSwitch: { active: false },
      policy: { maxOrderNotionalUsd: 2500, maxDailyNotionalUsd: 10000 },
      risk: { remainingDailyNotionalUsd: 7500 },
      decisions: [
        { signalId: "s1", side: "yes", contracts: 100, notionalUsd: 54 },
      ],
      paper: { totalFills: 2 },
    });
    expect(plan.mode).toBe("paper");
    expect(plan.decisions.length).toBe(1);

    const execRes = parseExecutionActionPayload({
      success: true,
      mode: "paper",
      style: "auto",
      filledCount: 1,
    });
    expect(execRes.filledCount).toBe(1);

    const board = parseGameAdminBoardPayload({
      source: "live",
      window: 24,
      games: [
        {
          gameNum: 540,
          league: "NBA",
          teams: ["LAL", "BOS"],
          spread: ["-3.5"],
        },
      ],
    });
    expect(board.games[0]?.gameNum).toBe("540");

    const sse = parseGraphStreamSample(
      'event: graph.tick\ndata: {"legs":3}\n\n',
    );
    expect(sse).toEqual({
      eventCount: 1,
      firstEventType: "graph.tick",
      dataPreview: '{"legs":3}',
    });

    const analysis = parseAnalysisPayload({
      available: true,
      rows: [
        {
          customerId: "DK121",
          agentId: "BILLY666",
          wagers: 4,
          riskCents: 150000,
          netCents: 45000,
        },
      ],
    });
    expect(analysis.rows[0]?.riskUsd).toBe("$1500");
    expect(analysis.rows[0]?.netUsd).toBe("$450");

    expect(
      parseCustomerProfilePayload({
        profile: {
          customerId: "DK121",
          agentId: "BILLY666",
          lifetime: { netUsd: 1200 },
        },
      }).id,
    ).toBe("DK121");
    expect(
      parseCustomerRatingPayload({
        rating: {
          customerId: "DK121",
          tier: "sharp",
          kellyMetrics: { recommendedFraction: 0.2 },
        },
      }).kellyFraction,
    ).toBe(0.2);
    expect(
      parseDnsTelemetryPayload({ telemetry: { size: 8, hitRatePercent: 91 } })
        .hitRatePercent,
    ).toBe(91);
    expect(
      parseGovernancePayload({
        referenceDate: "2026-11-10",
        summary: { readyGates: 5, totalGates: 6 },
        oracleGates: [{ id: "G1", name: "Boot", status: "ready" }],
      }).readyGates,
    ).toBe(5);
  });

  test("Bun.Transpiler & Bun.stripANSI auditNshModuleGraph enforces desk_model purity, ui/ boundary, and QuickJS isolation", async () => {
    expect(Bun.stripANSI("\u001b[31merror:\u001b[0m bad")).toBe("error: bad");

    const { auditNshModuleGraph } = await import("../scripts/nsh_desk_cli.ts");
    const realAppDir = path.join(import.meta.dir, "..", "packages", "nsh-desk");
    const cleanAudit = await auditNshModuleGraph(realAppDir);
    expect(cleanAudit.violations).toEqual([]);
    expect(cleanAudit.scannedFiles).toBeGreaterThanOrEqual(25);
    expect(cleanAudit.importKinds["import-statement"]).toBeGreaterThan(20);

    const badDir = await mkdtemp(path.join(tmpdir(), "nsh-bad-graph-"));
    try {
      await Bun.write(
        path.join(badDir, "desk_model.ts"),
        'import { View } from "nsh";\nexport const x = View;\n',
      );
      await Bun.write(
        path.join(badDir, "components", "Bad.tsx"),
        'import { Button } from "nsh/base";\nimport { YAML } from "bun";\nexport const B = () => [Button, YAML];\n',
      );
      const badAudit = await auditNshModuleGraph(badDir);
      expect(badAudit.violations.length).toBe(3);
      expect(badAudit.violations.join("\n")).toContain(
        "desk_model.ts must have 0 runtime imports",
      );
      expect(badAudit.violations.join("\n")).toContain(
        "imports 'nsh/base' directly outside ui/ layer",
      );
      expect(badAudit.violations.join("\n")).toContain(
        "imports host-only module 'bun'",
      );
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  test("buildTradingTerminalSnapshot synthesizes read-only Trading Desk panels, excludes ALERT/BLOCKED noise, and preserves null-honest unavailable KPIs", () => {
    expect(mapLeagueToCanonicalSport("NBA")).toBe("Basketball");
    expect(mapLeagueToCanonicalSport("EPL")).toBe("Soccer");
    expect(mapLeagueToCanonicalSport("NHL")).toBe("Ice Hockey");
    expect(mapLeagueToCanonicalSport("ATP")).toBe("Tennis");
    expect(mapLeagueToCanonicalSport("CS2")).toBe("Esports");

    expect(classifyWriterProvenanceChannel("inet", "Straight", false)).toBe(
      "INTERNET",
    );
    expect(classifyWriterProvenanceChannel("gslive", "Live", false)).toBe(
      "GSLIVE",
    );
    expect(classifyWriterProvenanceChannel("inet", "Parlay", false)).toBe(
      "GSBUILDER",
    );
    expect(classifyWriterProvenanceChannel("tg-bot", "Straight", false)).toBe(
      "GATEWAY",
    );
    expect(classifyWriterProvenanceChannel("vip-desk", "Straight", true)).toBe(
      "CSLEVEL2",
    );
    expect(classifyWriterProvenanceChannel("steam-alert", "Straight")).toBe(
      "ALERT",
    );
    expect(classifyWriterProvenanceChannel("blocked-dup", "Straight")).toBe(
      "BLOCKED",
    );

    // 1. All endpoints unavailable -> strictly null-honest ("—"), zero fabricated $0 or 0%
    const makeUnavailable = (endpoint: string) => ({
      status: "unavailable" as const,
      endpoint,
      httpStatus: 503,
      code: "upstream_down",
      cause: `${endpoint} HTTP 503`,
      fetchedAtIso: "2026-11-13T10:00:00.000Z",
    });

    const emptySnap = buildTradingTerminalSnapshot({
      kpisSnap: makeUnavailable("/api/kpis"),
      kalshiSnap: makeUnavailable("/api/signals/kalshi"),
      scoreboardSnap: makeUnavailable("/api/scoreboard"),
      liveBetsSnap: makeUnavailable("/api/live-bets/summary"),
      gameAdminBoardSnap: makeUnavailable("/api/game-admin/board"),
      gameAdminSnap: makeUnavailable("/api/game-admin"),
      liveWagersSnap: makeUnavailable("/api/live-wagers"),
      graphFeedSnap: makeUnavailable("/api/graph-feed"),
      filters: {
        sportFilter: "ALL",
        selectedMatchId: null,
        blotterStatus: "all",
        unhedgedOnly: false,
        searchQuery: "",
      },
    });

    expect(emptySnap.readOnlySnapshot).toBe(true);
    expect(emptySnap.approvalActionsEnabled).toBe(false);
    expect(emptySnap.hedgeExecutionEnabled).toBe(false);
    expect(emptySnap.hedgeMonitor.executionEnabled).toBe(false);
    for (const kpi of emptySnap.kpis) {
      expect(kpi.value).toBe("—");
    }
    expect(emptySnap.liveMatches).toEqual([]);
    expect(emptySnap.selectedMatch).toBeNull();
    expect(emptySnap.liabilityVsLiquidity.sor1Status).toBe("UNMEASURED");

    // 2. Populated snapshots with ALERT/BLOCKED noise + unhedgedOnly filtering
    const readySnap = buildTradingTerminalSnapshot({
      kpisSnap: {
        status: "ready",
        endpoint: "/api/kpis",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseKpisPayload({
          generatedAt: "2026-11-13T10:00:00.000Z",
          kpis: {},
        }),
      },
      kalshiSnap: {
        status: "ready",
        endpoint: "/api/signals/kalshi",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseKalshiPayload({
          provenance: { dataMode: "LIVE", stale: false, fixture: false },
          kalshi: { ok: true, degraded: false },
          signals: [
            {
              id: "NBA-BOS_LAL-spread",
              league: "NBA",
              marketKind: "spread",
              teams: ["LAL", "BOS"],
              line: -3.5,
              riskUsd: 24000,
              distinctAccounts: 3,
              fairProb: 0.54,
              confidence: 78,
              kalshi: { edgeBps: 340, verdict: "actionable", reason: "tight" },
              accounts: [
                {
                  login: "VIP_WHALE_99",
                  agentId: "BILLY666",
                  archetype: "Whale",
                  riskUsd: 12000,
                },
              ],
            },
          ],
        }),
      },
      scoreboardSnap: makeUnavailable("/api/scoreboard"),
      liveBetsSnap: {
        status: "ready",
        endpoint: "/api/live-bets/summary",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseLiveBetsSummaryPayload({
          totalWagers: 42,
          totalRiskUsd: 18500,
          mode: "live",
        }),
      },
      gameAdminBoardSnap: {
        status: "ready",
        endpoint: "/api/game-admin/board",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseGameAdminBoardPayload({
          source: "live-board",
          window: 24,
          games: [
            {
              gameNum: 540,
              league: "NBA",
              status: "live",
              clock: "Q3 06:14",
              teams: ["Lakers", "Celtics"],
              score: [78, 82],
              openers: { spread: "-2.5" },
              spread: ["-3.5 (-110)"],
              money: ["+135 / -155"],
              total: ["224.5"],
            },
          ],
        }),
      },
      gameAdminSnap: {
        status: "ready",
        endpoint: "/api/game-admin",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseGameAdminPayload({
          source: "captured",
          games: [
            {
              matchup: "Lakers @ Celtics",
              league: "NBA",
              total: { wagers: 18, wagered: 32000, toWin: 28500 },
              positions: {},
            },
            {
              matchup: "Pacers @ Knicks",
              league: "NBA",
              total: { wagers: 4, wagered: 3000, toWin: 2700 },
              positions: {},
            },
          ],
        }),
      },
      liveWagersSnap: {
        status: "ready",
        endpoint: "/api/live-wagers",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseLiveWagersPayload({
          wagers: [
            {
              ticketNumber: "9001",
              customerId: "ACCT_HEDGED",
              writer: "gslive",
              wagerType: "Straight",
              riskUsd: 4000,
              toWinUsd: 3600,
              description: "Celtics -3.5",
            },
            {
              ticketNumber: "9002",
              customerId: "ACCT_ALERT",
              writer: "steam-alert",
              wagerType: "Straight",
              riskUsd: 50000,
              toWinUsd: 45000,
              description: "Noise steam ping",
            },
            {
              ticketNumber: "9003",
              customerId: "ACCT_BLOCKED",
              writer: "blocked-limit",
              wagerType: "Straight",
              riskUsd: 25000,
              toWinUsd: 22000,
              description: "Blocked duplicate",
            },
          ],
        }),
      },
      graphFeedSnap: {
        status: "ready",
        endpoint: "/api/graph-feed",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseGraphFeedPayload({
          schemaVersion: 3,
          dataMode: "LIVE",
          pendingBets: [
            {
              id: "pb-1",
              login: "SHARP_VIP",
              league: "NBA",
              selection: "Celtics ML",
              riskUsd: 9000,
              sharpScore: 93,
              placedAt: "2026-11-13T10:02:15Z",
            },
          ],
          backtest4Wk: {
            weeks: [
              {
                week: "2026-W45",
                estimatedSavingsUsd: 14200,
                holdImprovementBps: 90,
              },
            ],
          },
        }),
      },
      filters: {
        sportFilter: "ALL",
        selectedMatchId: null,
        blotterStatus: "all",
        unhedgedOnly: false,
        searchQuery: "",
      },
    });

    // Noise exclusion: 50K ALERT + 25K BLOCKED must NOT inflate canonicalStakeUsd!
    expect(readySnap.blotterSummary.excludedNoiseCount).toBe(2);
    expect(readySnap.blotterSummary.canonicalCount).toBe(3);
    expect(readySnap.blotterSummary.canonicalStakeUsd).toBe(
      4000 + 9000 + 12000,
    );
    expect(readySnap.selectedMatch?.ladderRows[1]?.riskBadge).toBe("KEY #3/#7");
    expect(readySnap.otcQuotes.length).toBeGreaterThanOrEqual(2);

    // Filter unhedgedOnly=true -> drops ACCT_HEDGED, ACCT_ALERT, ACCT_BLOCKED, and hedged Pacers @ Knicks row
    const unhedgedSnap = buildTradingTerminalSnapshot({
      kpisSnap: {
        status: "ready",
        endpoint: "/api/kpis",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseKpisPayload({ kpis: {} }),
      },
      kalshiSnap: readySnap.selectedMatch
        ? {
            status: "ready",
            endpoint: "/api/signals/kalshi",
            httpStatus: 200,
            fetchedAtIso: "2026-11-13T10:00:00.000Z",
            data: parseKalshiPayload({
              kalshi: { ok: true, degraded: false },
              signals: [
                {
                  id: "NBA-BOS_LAL-spread",
                  league: "NBA",
                  marketKind: "spread",
                  teams: ["LAL", "BOS"],
                  line: -3.5,
                  riskUsd: 24000,
                  distinctAccounts: 3,
                  fairProb: 0.54,
                  confidence: 78,
                  kalshi: {
                    edgeBps: 340,
                    verdict: "actionable",
                    reason: "tight",
                  },
                  accounts: [
                    {
                      login: "VIP_WHALE_99",
                      agentId: "BILLY666",
                      archetype: "Whale",
                      riskUsd: 12000,
                    },
                  ],
                },
              ],
            }),
          }
        : makeUnavailable("/api/signals/kalshi"),
      scoreboardSnap: makeUnavailable("/api/scoreboard"),
      liveBetsSnap: makeUnavailable("/api/live-bets/summary"),
      gameAdminBoardSnap: makeUnavailable("/api/game-admin/board"),
      gameAdminSnap: {
        status: "ready",
        endpoint: "/api/game-admin",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseGameAdminPayload({
          source: "captured",
          games: [
            {
              matchup: "Lakers @ Celtics",
              league: "NBA",
              total: { wagers: 18, wagered: 32000, toWin: 28500 },
              positions: {},
            },
            {
              matchup: "Pacers @ Knicks",
              league: "NBA",
              total: { wagers: 4, wagered: 3000, toWin: 2700 },
              positions: {},
            },
          ],
        }),
      },
      liveWagersSnap: {
        status: "ready",
        endpoint: "/api/live-wagers",
        httpStatus: 200,
        fetchedAtIso: "2026-11-13T10:00:00.000Z",
        data: parseLiveWagersPayload({
          wagers: [
            {
              ticketNumber: "9001",
              customerId: "ACCT_HEDGED",
              writer: "gslive",
              wagerType: "Straight",
              riskUsd: 4000,
              toWinUsd: 3600,
              description: "Celtics -3.5",
            },
            {
              ticketNumber: "9002",
              customerId: "ACCT_ALERT",
              writer: "steam-alert",
              wagerType: "Straight",
              riskUsd: 50000,
              toWinUsd: 45000,
              description: "Noise steam ping",
            },
          ],
        }),
      },
      graphFeedSnap: makeUnavailable("/api/graph-feed"),
      filters: {
        sportFilter: "ALL",
        selectedMatchId: null,
        blotterStatus: "all",
        unhedgedOnly: true,
        searchQuery: "",
      },
    });

    expect(unhedgedSnap.blotterRows.map((r) => r.account)).toEqual([
      "VIP_WHALE_99 (BILLY666)",
    ]);
    expect(
      unhedgedSnap.liabilityMatrix.some(
        (m) => m.outcomeLabel === "Pacers @ Knicks",
      ),
    ).toBe(false);
  });
});
