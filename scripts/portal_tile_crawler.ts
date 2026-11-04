#!/usr/bin/env bun
/**
 * @file portal_tile_crawler.ts
 * @description Native Bun.WebView launcher-tile crawler for the Fantasy402
 * Manager portal, rewritten against the real Bun 1.4.4 API
 * (reports/docs-review/BUN_CAPTURE_CONTRACT.md).
 *
 * Two modes:
 *   --offline (default)  deterministic catalog pass over UNMAPPED_LAUNCHER_TILES;
 *                        no WebView, no network — safe for CI.
 *   --live --portal URL  chrome-backed Bun.WebView crawl: scroll to each tile,
 *                        click it, extract DOM inputs + L-keys via IIFE
 *                        evaluate, JPEG proof screenshots, ui-dom evidence.
 *
 * Safety: this crawler only observes the UI. It never authenticates, never
 * sends credentials, and never calls an upstream API. WebView is always closed
 * with `await view.close()` (never destroy / Symbol.asyncDispose).
 */

import { join, resolve } from "node:path";
import {
  createDefaultAuditRuntime,
  isRecord,
  type AuditIssue,
  type WebViewHandle,
  type WebViewOptions,
} from "./audit_docs_webview_cron.ts";

const SCRIPT_DIR = import.meta.dir;
const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, "..");
const NAVIGATION_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 15_000;
const TILE_SETTLE_MS = 500;
const TILE_READY_TIMEOUT_MS = 10_000;
const TILE_POLL_INTERVAL_MS = 150;
const DEFAULT_EVIDENCE_KIND = "ui-dom";
const OFFLINE_EVIDENCE_KIND = "catalog";

/* -------------------------------------------------------------------------- */
/* Catalog (kept from the original prototype; offline source of truth)        */
/* -------------------------------------------------------------------------- */

export interface TileCrawledMetadata {
  readonly tileName: string;
  readonly clusterColor: string;
  readonly domSelector: string;
  readonly candidateEndpoint: string;
  readonly candidateMethod: "POST" | "GET";
  readonly extractedInputs: readonly string[];
  readonly dataLanguageLKeys: readonly string[];
  readonly discoveryStatus: "CONFIRMED" | "UNDER_SURVEILLANCE" | "IN_PROGRESS";
  readonly notes: string;
}

export const UNMAPPED_LAUNCHER_TILES: readonly TileCrawledMetadata[] = [
  {
    tileName: "Game Admin",
    clusterColor: "Dark Navy (#0f2b46)",
    domSelector: "div.tile:has-text('Game Admin'), div[data-tile='game-admin']",
    candidateEndpoint: "/cloud/api/Manager/gameAdmin",
    candidateMethod: "POST",
    extractedInputs: ["rotationNumber", "sportType", "circleLimit", "isLocked"],
    dataLanguageLKeys: ["L-1034", "L-1052"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Circling games, freezing odds, locking lines on market pace moves.",
  },
  {
    tileName: "Messaging",
    clusterColor: "Dark Navy (#0f2b46)",
    domSelector: "div.tile:has-text('Messaging'), div[data-tile='messaging']",
    candidateEndpoint: "/cloud/api/System/getMessages",
    candidateMethod: "POST",
    extractedInputs: ["recipientScope", "subject", "messageBody", "priority"],
    dataLanguageLKeys: ["L-1055", "L-1056"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Downline agent broadcasts, sharp notices, operator inbox.",
  },
  {
    tileName: "Cashier",
    clusterColor: "Slate Gray (#6b7785)",
    domSelector: "div.tile:has-text('Cashier'), div[data-tile='cashier']",
    candidateEndpoint: "/cloud/api/Manager/adjustBalance",
    candidateMethod: "POST",
    extractedInputs: ["customerID", "amountCents", "transactionType", "notes"],
    dataLanguageLKeys: ["L-1031", "L-1045", "L-1058"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes:
      "Manual ledger credit adjustments, cash settlements, free play bonuses.",
  },
  {
    tileName: "Add Customer",
    clusterColor: "Slate Gray (#6b7785)",
    domSelector:
      "div.tile:has-text('Add Customer'), div[data-tile='add-customer']",
    candidateEndpoint: "/cloud/api/Manager/createPlayer",
    candidateMethod: "POST",
    extractedInputs: [
      "customerID",
      "agentID",
      "password",
      "creditLimit",
      "delaySeconds",
    ],
    dataLanguageLKeys: ["L-1031", "L-1032", "L-1040"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Bettor account provisioning under direct sub-agent hierarchy.",
  },
  {
    tileName: "3rd Party Limits",
    clusterColor: "Slate Gray (#6b7785)",
    domSelector:
      "div.tile:has-text('3rd Party Limits'), div[data-tile='3rd-party-limits']",
    candidateEndpoint: "/cloud/api/Manager/get3rdPartyLimits",
    candidateMethod: "POST",
    extractedInputs: ["providerID", "sportCategory", "maxLimitCents"],
    dataLanguageLKeys: ["L-1060", "L-1061"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes:
      "Global external oddsmaker feed collar ceilings (Don Best, Betradar).",
  },
  {
    tileName: "Analysis",
    clusterColor: "Cerulean Blue (#1d84b5)",
    domSelector: "div.tile:has-text('Analysis'), div[data-tile='analysis']",
    candidateEndpoint: "/cloud/api/Report/getAnalysis",
    candidateMethod: "POST",
    extractedInputs: ["period", "sport", "marketCategory", "agentID"],
    dataLanguageLKeys: ["L-1034", "L-1064"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes:
      "Market and sport concentration sizing (Stage 6 of surveillance lifecycle).",
  },
  {
    tileName: "Scores",
    clusterColor: "Sunset Orange (#f4511e)",
    domSelector: "div.tile:has-text('Scores'), div[data-tile='scores']",
    candidateEndpoint: "/cloud/api/Manager/getScores",
    candidateMethod: "POST",
    extractedInputs: [
      "gameID",
      "periodIndex",
      "homeScore",
      "awayScore",
      "isFinal",
    ],
    dataLanguageLKeys: ["L-1034", "L-1068"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Period score verification and manual settlement grading overrides.",
  },
  {
    tileName: "Agent Admin",
    clusterColor: "Forest Green (#2e7d32)",
    domSelector:
      "div.tile:has-text('Agent Admin'), div[data-tile='agent-admin']",
    candidateEndpoint: "/cloud/api/Manager/getAgentTree",
    candidateMethod: "POST",
    extractedInputs: ["masterAgent", "commissionSplitPercent", "creditCeiling"],
    dataLanguageLKeys: ["L-1032", "L-1070"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Sub-agent 50% split governance and credit ceiling adjustments.",
  },
  {
    tileName: "Billing",
    clusterColor: "Forest Green (#2e7d32)",
    domSelector: "div.tile:has-text('Billing'), div[data-tile='billing']",
    candidateEndpoint: "/cloud/api/Manager/getBilling",
    candidateMethod: "POST",
    extractedInputs: ["billingWeek", "ratePerActiveHead", "activeAccountCount"],
    dataLanguageLKeys: ["L-1050", "L-1072"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "PPH per-head software fees across active accounts.",
  },
  {
    tileName: "Settings & Rules",
    clusterColor: "Forest Green (#2e7d32)",
    domSelector: "div.tile:has-text('Rules'), div[data-tile='rules']",
    candidateEndpoint: "/cloud/api/Manager/getRules",
    candidateMethod: "POST",
    extractedInputs: [
      "parlayMaxPayout",
      "teaserTieRule",
      "defaultDelaySeconds",
    ],
    dataLanguageLKeys: ["L-1040", "L-1075"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes:
      "House wagering rules, teaser tie tables, and parlay payout collars.",
  },
  {
    tileName: "Transactions History",
    clusterColor: "Cerulean Blue (#1d84b5)",
    domSelector:
      "div.tile:has-text('Transactions History'), div[data-tile='transactions-history']",
    candidateEndpoint: "/cloud/api/Report/getFinancialReport",
    candidateMethod: "POST",
    extractedInputs: [
      "customerID",
      "startDate",
      "endDate",
      "transactionFilter",
    ],
    dataLanguageLKeys: ["L-1031", "L-1033", "L-1058"],
    discoveryStatus: "UNDER_SURVEILLANCE",
    notes: "Financial transaction ledger audit across players and agent nodes.",
  },
];

export type CrawlMode = "offline" | "live";
export type TileObservationStatus =
  "CATALOG_ONLY" | "OBSERVED" | "OBSERVE_FAILED";

export interface CrawledTile extends TileCrawledMetadata {
  readonly observedAt: string;
  readonly evidenceKind: "ui-dom" | "catalog";
  readonly status: TileObservationStatus;
  readonly note: string | undefined;
  readonly screenshotPath: string | undefined;
}

export interface CrawlReport {
  readonly generatedAt: string;
  readonly mode: CrawlMode;
  readonly portalUrl: string | undefined;
  readonly backend: string;
  readonly totalTiles: number;
  readonly observedTiles: number;
  readonly tiles: readonly CrawledTile[];
  readonly issues: readonly AuditIssue[];
  readonly reportPath: string;
}

/* -------------------------------------------------------------------------- */
/* Runtime boundary                                                           */
/* -------------------------------------------------------------------------- */

export interface CrawlRuntime {
  createWebView(options: WebViewOptions): Promise<WebViewHandle>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): void;
  now(): Date;
}

export function createDefaultCrawlRuntime(): CrawlRuntime {
  const base = createDefaultAuditRuntime();
  return {
    createWebView: (options: WebViewOptions) => base.createWebView(options),
    writeBytes: (path: string, bytes: Uint8Array) =>
      base.writeBytes(path, bytes),
    mkdirp: (path: string) => base.mkdirp(path),
    now: () => base.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* DOM extraction                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The catalog selectors mix CSS with a Playwright-style `:has-text(...)`
 * pseudo-selector that the browser cannot parse. The `[data-tile=...]` part is
 * valid CSS and is what WebView scrollTo/click can use.
 */
export function cssSelectorForTile(tile: TileCrawledMetadata): string {
  const dataTile = /div\[data-tile='([^']+)'\]/.exec(tile.domSelector);
  const slug = dataTile?.[1];
  if (slug !== undefined) return `div[data-tile='${slug}']`;
  return "div.tile";
}

/**
 * Presence expression for a tile selector. Bun.WebView.navigate() resolves at
 * document load, so each tile must be polled for before scrollTo/click.
 */
export function buildSelectorPresenceExpression(selector: string): string {
  return `(() => Boolean(document.querySelector(${JSON.stringify(selector)})))()`;
}

/** Poll until a tile selector exists in the live DOM (bounded). */
async function waitForTileSelector(
  view: WebViewHandle,
  selector: string,
  timeoutMs = TILE_READY_TIMEOUT_MS,
): Promise<boolean> {
  const expression = buildSelectorPresenceExpression(selector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const present = await view.evaluate(expression);
      if (present === true) return true;
    } catch {
      // The page can still be navigating; retry until the deadline.
    }
    await sleep(TILE_POLL_INTERVAL_MS);
  }
  return false;
}

export const TILE_EXTRACTION_EXPRESSION = `(() => {
  const scope =
    document.querySelector("[role='dialog'], .modal, .drawer, .panel, main") ||
    document;
  const readAttr = (element, names) => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) return value;
    }
    return "";
  };
  const inputs = Array.from(
    scope.querySelectorAll("input[name], select[name], textarea[name]")
  )
    .map((element) => readAttr(element, ["name", "id", "data-action"]))
    .filter((value) => value !== "");
  const lKeys = Array.from(
    scope.querySelectorAll("[data-language], [data-l-key], [data-language-key]")
  )
    .map((element) =>
      readAttr(element, ["data-language", "data-l-key", "data-language-key"])
    )
    .filter((value) => value !== "");
  const heading = scope.querySelector("h1, h2, [role='heading']");
  return {
    inputs: Array.from(new Set(inputs)),
    lKeys: Array.from(new Set(lKeys)),
    panelTitle: heading ? (heading.textContent || "").trim() : "",
  };
})()`;

export interface ExtractedTileDom {
  readonly inputs: readonly string[];
  readonly lKeys: readonly string[];
  readonly panelTitle: string;
}

/** Parse the raw evaluate result at the boundary. */
export function parseExtractedTileDom(
  value: unknown,
): ExtractedTileDom | undefined {
  if (!isRecord(value)) return undefined;
  const { inputs, lKeys, panelTitle } = value;
  if (
    !Array.isArray(inputs) ||
    !inputs.every((entry) => typeof entry === "string") ||
    !Array.isArray(lKeys) ||
    !lKeys.every((entry) => typeof entry === "string") ||
    typeof panelTitle !== "string"
  ) {
    return undefined;
  }
  return { inputs, lKeys, panelTitle };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tileSlug(tileName: string): string {
  return tileName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error ? error : new Error(describeError(error)),
        );
      },
    );
  });
}

/**
 * Poll until the portal reports a rendered document title and URL. WebKit's
 * `view.title` is always "" on Bun 1.4.4, so the title comes from
 * `evaluate("document.title")`; evaluate errors count as "not ready".
 */
async function waitForPortalRender(
  view: WebViewHandle,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await readPortalTitle(view);
    const url = view.url;
    if (title !== "" && url.trim() !== "") return true;
    await sleep(250);
  }
  return (await readPortalTitle(view)) !== "" && view.url.trim() !== "";
}

/**
 * Read the document title through evaluate(). Kept local (and below the
 * catalog) so the tile citation line numbers in docs/api-reference.md do not
 * shift; WebKit's `view.title` is always "" on Bun 1.4.4.
 */
async function readPortalTitle(view: WebViewHandle): Promise<string> {
  try {
    const raw = await view.evaluate("document.title");
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/** The real Bun.WebView crawl surface adds click()/scrollTo() (CSS selectors). */
interface CrawlWebView extends WebViewHandle {
  scrollTo(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
}

/** Validate the optional method surface at the adapter boundary. */
export function asCrawlWebView(view: WebViewHandle): CrawlWebView | undefined {
  const candidate = view as WebViewHandle & {
    scrollTo?: unknown;
    click?: unknown;
  };
  if (
    typeof candidate.scrollTo !== "function" ||
    typeof candidate.click !== "function"
  ) {
    return undefined;
  }
  return candidate as CrawlWebView;
}

interface LaunchedCrawlWebView {
  readonly view: CrawlWebView;
  readonly backend: string;
  readonly warnings: readonly string[];
}

async function launchCrawlWebView(
  runtime: CrawlRuntime,
  portalUrl: string,
  consoleSink: (type: string, ...args: unknown[]) => void,
): Promise<LaunchedCrawlWebView> {
  const failures: string[] = [];
  for (const backend of ["chrome", "webkit"] as const) {
    let rawView: WebViewHandle | undefined;
    try {
      rawView = await runtime.createWebView({
        width: 1440,
        height: 900,
        backend,
        console: consoleSink,
      });
      const view = asCrawlWebView(rawView);
      if (view === undefined) {
        throw new Error(
          "Bun.WebView is missing click()/scrollTo(); cannot crawl tiles",
        );
      }
      await withTimeout(
        view.navigate(portalUrl),
        NAVIGATION_TIMEOUT_MS,
        `${backend} navigate`,
      );
      // Chrome treats the constructor size as the outer window; resize after
      // navigation so the tile screenshots use the requested 1440x900 viewport.
      if (typeof view.resize === "function") {
        try {
          await view.resize(1440, 900);
        } catch {
          // Best-effort: an un-resizable backend still renders.
        }
      }
      if (!(await waitForPortalRender(view))) {
        throw new Error(`portal never rendered a title/url with ${backend}`);
      }
      return {
        view,
        backend,
        warnings:
          failures.length === 0
            ? []
            : [
                `chrome backend unavailable (${failures.join(" | ")}); rendered with webkit`,
              ],
      };
    } catch (error) {
      failures.push(`${backend}: ${describeError(error)}`);
      if (rawView !== undefined) {
        try {
          await rawView.close();
        } catch {
          // Already gone.
        }
      }
    }
  }
  throw new Error(
    `no Bun.WebView backend could render ${portalUrl}: ${failures.join(" | ")}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Crawl orchestration                                                        */
/* -------------------------------------------------------------------------- */

export interface CrawlOptions {
  readonly mode?: CrawlMode | undefined;
  readonly portalUrl?: string | undefined;
  readonly outDir?: string | undefined;
  readonly rootDir?: string | undefined;
  readonly runtime?: CrawlRuntime | undefined;
}

function catalogTile(
  tile: TileCrawledMetadata,
  observedAt: string,
): CrawledTile {
  return {
    ...tile,
    observedAt,
    evidenceKind: OFFLINE_EVIDENCE_KIND,
    status: "CATALOG_ONLY",
    note: "offline catalog pass (no WebView); candidate contract from the launcher catalog",
    screenshotPath: undefined,
  };
}

async function runLiveCrawl(
  runtime: CrawlRuntime,
  portalUrl: string,
  proofsDir: string,
  observedAt: string,
  issues: AuditIssue[],
): Promise<{
  readonly backend: string;
  readonly tiles: readonly CrawledTile[];
}> {
  const consoleMessages: string[] = [];
  const consoleSink = (type: string, ...args: unknown[]): void => {
    const body = args
      .map((argument) =>
        typeof argument === "string" ? argument : JSON.stringify(argument),
      )
      .join(" ");
    consoleMessages.push(type ? `[${type}] ${body}` : body);
  };

  const launched = await launchCrawlWebView(runtime, portalUrl, consoleSink);
  const tiles: CrawledTile[] = [];
  try {
    for (const tile of UNMAPPED_LAUNCHER_TILES) {
      const selector = cssSelectorForTile(tile);
      let status: TileObservationStatus = "OBSERVED";
      const notes: string[] = [];
      let extracted: ExtractedTileDom | undefined;
      let screenshotPath: string | undefined;

      try {
        // SPA hydration: navigate() resolves at document load, so wait for the
        // tile selector to exist before interacting with it.
        if (!(await waitForTileSelector(launched.view, selector))) {
          throw new Error(
            `tile selector ${selector} never appeared within ${TILE_READY_TIMEOUT_MS}ms`,
          );
        }
        await withTimeout(
          launched.view.scrollTo(selector),
          NAVIGATION_TIMEOUT_MS,
          `scrollTo(${selector})`,
        );
        await withTimeout(
          launched.view.click(selector),
          NAVIGATION_TIMEOUT_MS,
          `click(${selector})`,
        );
        await sleep(TILE_SETTLE_MS);
        extracted = parseExtractedTileDom(
          await launched.view.evaluate(TILE_EXTRACTION_EXPRESSION),
        );
        if (extracted === undefined) {
          notes.push("DOM extraction returned an unexpected shape");
        }
      } catch (error) {
        status = "OBSERVE_FAILED";
        notes.push(
          `tile not observable in this session: ${describeError(error)}`,
        );
      }

      try {
        const blob = await launched.view.screenshot({
          format: "jpeg",
          quality: 85,
        });
        const bytes = Buffer.from(await blob.arrayBuffer());
        runtime.mkdirp(proofsDir);
        const proofPath = join(
          proofsDir,
          `proof_${tileSlug(tile.tileName)}.jpg`,
        );
        await runtime.writeBytes(proofPath, bytes);
        screenshotPath = proofPath;
      } catch (error) {
        notes.push(`screenshot failed: ${describeError(error)}`);
      }

      tiles.push({
        ...tile,
        extractedInputs:
          extracted !== undefined && extracted.inputs.length > 0
            ? extracted.inputs
            : tile.extractedInputs,
        dataLanguageLKeys:
          extracted !== undefined && extracted.lKeys.length > 0
            ? extracted.lKeys
            : tile.dataLanguageLKeys,
        discoveryStatus:
          status === "OBSERVED" ? "IN_PROGRESS" : tile.discoveryStatus,
        observedAt,
        evidenceKind: DEFAULT_EVIDENCE_KIND,
        status,
        note: notes.length > 0 ? notes.join("; ") : undefined,
        screenshotPath,
      });
    }
  } finally {
    // No Bun.WebView.closeAll(): it SIGKILLs the shared browser and the next
    // launch races the respawn ("Chrome process closed the pipe").
    try {
      await launched.view.close();
    } catch (error) {
      issues.push({
        severity: "MEDIUM",
        category: "WEBVIEW_ERROR",
        target: "Bun.WebView.close",
        message: `WebView close failed: ${describeError(error)}`,
      });
    }
  }

  const consoleErrors = consoleMessages.filter((message) =>
    /(error|uncaught|exception|refused|failed to load)/i.test(message),
  );
  for (const message of consoleErrors.slice(0, 10)) {
    issues.push({
      severity: "MEDIUM",
      category: "CONSOLE_ERROR",
      target: portalUrl,
      message: `page console error during tile crawl: ${message}`,
    });
  }

  return { backend: launched.backend, tiles };
}

/**
 * Inspect the launcher tiles. Kept as the public entry point used by tests and
 * the CLI: offline returns the deterministic catalog report; live performs the
 * chrome WebView DOM crawl.
 */
export async function runTileInspectionCrawl(
  options: CrawlOptions = {},
): Promise<CrawlReport> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const outDir = options.outDir ?? join(rootDir, "reports");
  const mode: CrawlMode = options.mode ?? "offline";
  const runtime = options.runtime ?? createDefaultCrawlRuntime();
  const generatedAt = runtime.now().toISOString();
  const issues: AuditIssue[] = [];
  const reportPath = join(outDir, "tile_crawler_audit.json");

  let portalUrl: string | undefined;
  let backend = "not-launched";
  let tiles: CrawledTile[];

  if (mode === "offline") {
    if (options.portalUrl !== undefined) portalUrl = options.portalUrl;
    tiles = UNMAPPED_LAUNCHER_TILES.map((tile) =>
      catalogTile(tile, generatedAt),
    );
  } else {
    if (options.portalUrl === undefined) {
      throw new Error("live crawl requires --portal <url>");
    }
    portalUrl = options.portalUrl;
    const proofsDir = join(outDir, "tile_crawler_proofs");
    runtime.mkdirp(proofsDir);
    try {
      const live = await runLiveCrawl(
        runtime,
        portalUrl,
        proofsDir,
        generatedAt,
        issues,
      );
      backend = live.backend;
      tiles = [...live.tiles];
      if (live.backend !== "chrome") {
        issues.push({
          severity: "MEDIUM",
          category: "WEBVIEW_ERROR",
          target: "Bun.WebView",
          message:
            "chrome backend was unavailable; the crawl ran on the webkit fallback",
        });
      }
    } catch (error) {
      backend = "failed";
      issues.push({
        severity: "HIGH",
        category: "WEBVIEW_ERROR",
        target: portalUrl,
        message: `live tile crawl could not launch/render the portal: ${describeError(error)}`,
      });
      tiles = UNMAPPED_LAUNCHER_TILES.map((tile) => ({
        ...catalogTile(tile, generatedAt),
        status: "OBSERVE_FAILED",
        note: `live crawl failed: ${describeError(error)}`,
      }));
    }
  }

  const report: CrawlReport = {
    generatedAt,
    mode,
    portalUrl,
    backend,
    totalTiles: tiles.length,
    observedTiles: tiles.filter((tile) => tile.status === "OBSERVED").length,
    tiles,
    issues,
    reportPath,
  };

  runtime.mkdirp(outDir);
  await runtime.writeBytes(
    reportPath,
    new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
  );
  return report;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export interface CrawlCliOptions {
  readonly mode: CrawlMode;
  readonly portalUrl: string | undefined;
  readonly outDir: string | undefined;
  readonly json: boolean;
}

const CRAWL_USAGE =
  "usage: bun run scripts/portal_tile_crawler.ts [--offline|--live --portal <url>] [--out <dir>] [--json]";

export function parseCrawlCliArgs(
  argv: readonly string[],
): CrawlCliOptions | string {
  let mode: CrawlMode = "offline";
  let portalUrl: string | undefined;
  let outDir: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--offline") {
      mode = "offline";
    } else if (argument === "--live") {
      mode = "live";
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--portal") {
      const next = argv[index + 1];
      if (next === undefined) {
        return `--portal requires a URL\n${CRAWL_USAGE}`;
      }
      portalUrl = next;
      index += 1;
    } else if (argument.startsWith("--portal=")) {
      portalUrl = argument.slice("--portal=".length);
    } else if (argument === "--out") {
      const next = argv[index + 1];
      if (next === undefined)
        return `--out requires a directory\n${CRAWL_USAGE}`;
      outDir = next;
      index += 1;
    } else if (argument.startsWith("--out=")) {
      outDir = argument.slice("--out=".length);
    } else {
      return `unknown argument: ${argument}\n${CRAWL_USAGE}`;
    }
  }

  if (mode === "live" && portalUrl === undefined) {
    return `--live requires --portal <url>\n${CRAWL_USAGE}`;
  }
  return { mode, portalUrl, outDir, json };
}

function printCrawlReport(report: CrawlReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `[Tile Crawler] ${report.mode} pass: ${report.totalTiles} tiles, ${report.observedTiles} observed (backend: ${report.backend})`,
  );
  for (const tile of report.tiles) {
    console.log(
      `  ${tile.status.padEnd(14)} ${tile.tileName} -> ${tile.candidateMethod} ${tile.candidateEndpoint} [${tile.evidenceKind}]`,
    );
  }
  for (const issue of report.issues) {
    console.log(
      `  ISSUE [${issue.severity}/${issue.category}] ${issue.target}: ${issue.message}`,
    );
  }
  console.log(`  report: ${report.reportPath}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const cli = parseCrawlCliArgs(argv);
  if (typeof cli === "string") {
    console.error(cli);
    return 2;
  }
  try {
    const report = await runTileInspectionCrawl({
      mode: cli.mode,
      portalUrl: cli.portalUrl,
      outDir: cli.outDir === undefined ? undefined : resolve(cli.outDir),
    });
    printCrawlReport(report, cli.json);
    if (cli.mode === "live") {
      const fatal = report.issues.some(
        (issue) => issue.severity === "HIGH" || issue.severity === "CRITICAL",
      );
      return fatal ? 1 : 0;
    }
    return 0;
  } catch (error) {
    console.error(`[Tile Crawler] failed: ${describeError(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`[Tile Crawler] crashed: ${describeError(error)}`);
      process.exitCode = 2;
    },
  );
}
