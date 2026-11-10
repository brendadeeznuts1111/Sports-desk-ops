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
  DESK_PREFS_STORAGE_KEY,
  defaultWorkspacePrefs,
  extractApiFailureCause,
  parseKalshiPayload,
  parseKpisPayload,
  parseScoreboardPayload,
  parseWorkspacePrefsJson,
  resolveDeskOrigin,
  serializeWorkspacePrefs,
  sortSignalArenaIndex,
} from "../packages/nsh-desk/desk_model.ts";

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

  test("nsh.json enforces read-only loopback HTTP capabilities", async () => {
    const nshJsonPath = path.join(
      import.meta.dir,
      "..",
      "packages",
      "nsh-desk",
      "nsh.json",
    );
    const manifest = (await Bun.file(nshJsonPath).json()) as {
      id: string;
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
    expect(manifest.capabilities.network.hosts).toBeUndefined();
    expect(manifest.capabilities.network.http).toEqual([
      { host: "127.0.0.1", methods: ["GET"], schemes: ["http"] },
      { host: "localhost", methods: ["GET"], schemes: ["http"] },
    ]);
    expect(manifest.capabilities.process.env).toEqual(["SPORTSDESK_ORIGIN"]);
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
    for (const requiredRole of ["positive", "warning", "negative"]) {
      expect(typeof themeJson.cssVars.light[requiredRole]).toBe("string");
      expect(typeof themeJson.cssVars.dark[requiredRole]).toBe("string");
    }

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
  });

  test("enforces root App.tsx mount(App) ownership and acyclic components/ boundary", async () => {
    const pkgDir = path.join(import.meta.dir, "..", "packages", "nsh-desk");
    const appSrc = await Bun.file(path.join(pkgDir, "App.tsx")).text();
    const mountCalls = appSrc.match(/\bmount\s*\(/g) ?? [];
    expect(mountCalls.length).toBe(1);
    expect(appSrc).toContain("ErrorBoundary");
    expect(appSrc).toMatch(/from\s+["']\.\/components["']/);

    const compDir = path.join(pkgDir, "components");
    const compGlob = new Bun.Glob("**/*.{ts,tsx}");
    let compCount = 0;
    for await (const rel of compGlob.scan({ cwd: compDir })) {
      compCount += 1;
      const src = await Bun.file(path.join(compDir, rel)).text();
      expect(src).not.toMatch(/from\s+["']nsh\/base/);
      expect(src).not.toMatch(/from\s+["']\.\.\/App/);
      expect(src).not.toMatch(/\bmount\s*\(/);
    }
    expect(compCount).toBeGreaterThanOrEqual(7);
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
      parseNshCliOutput,
      parseNshVersionOutput,
    } = await import("../scripts/nsh_desk_cli.ts");

    const ver = parseNshVersionOutput(
      "\u001b[32mnsh 0.4.0 (e626a8d)\u001b[0m\n",
    );
    expect(ver).toEqual({
      raw: "nsh 0.4.0 (e626a8d)",
      semver: "0.4.0",
      gitSha: "e626a8d",
    });
    expect(Bun.semver.satisfies(ver.semver!, ">=0.4.0")).toBe(true);

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
});
