#!/usr/bin/env bun
/**
 * @file scripts/agent_env_doctor.ts
 * @description One command that reports the environment gaps an agent hits *before* it wastes
 * tool calls on them. The 2026-11-04 audit of 24 session traces found the recurring friction was
 * not the code: missing worktree dependencies, the gitignored `enriched_customers_full.json`,
 * no browser/CDP, a sandbox that cannot write `~/.dsh`, and deploy credentials living outside the
 * documented paths. Each check prints the exact next command instead of leaving the agent to
 * discover it through a failed gate.
 *
 *   bun run agent:doctor            human report; exit 1 only on FAIL
 *   bun run agent:doctor --json     machine-readable checks
 *
 * This is a diagnostic: it never writes, installs, or changes policy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveBunServePort,
  resolveSportsdeskDaemonPort,
} from "../lib/bun_serve_port.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly title: string;
  readonly detail?: string;
  readonly fix?: string;
}

const ROOT = path.resolve(import.meta.dirname, "..");

function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function readJson(target: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function spawnText(command: readonly string[], cwd: string): string | null {
  try {
    const result = Bun.spawnSync([...command], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** The main checkout when `root` is a linked worktree; null for a normal checkout. */
export function mainCheckoutRoot(root: string): string | null {
  const common = spawnText(["git", "rev-parse", "--git-common-dir"], root);
  if (common === null || common === "") return null;
  const absolute = path.resolve(root, common);
  if (path.basename(absolute) !== ".git") return null;
  const parent = path.dirname(absolute);
  return parent === root ? null : parent;
}

function playwrightHeadlessShell(): string | null {
  const base = Bun.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.resolve(Bun.env.PLAYWRIGHT_BROWSERS_PATH)
    : path.join(os.homedir(), "Library/Caches/ms-playwright");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return null;
  }
  const candidates = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
  ];
  for (const entry of entries.sort().reverse()) {
    if (!entry.startsWith("chromium_headless_shell-")) continue;
    for (const suffix of candidates) {
      const candidate = path.join(base, entry, suffix);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function hashOf(target: string): string | null {
  try {
    return new Bun.CryptoHasher("sha256")
      .update(fs.readFileSync(target))
      .digest("hex");
  } catch {
    return null;
  }
}

/** Collect every check. Exported so tests can drive it without a terminal. */
export async function runDoctor(root = ROOT): Promise<Check[]> {
  const checks: Check[] = [];
  const main = mainCheckoutRoot(root);

  checks.push({
    id: "runtime",
    status: "ok",
    title: `Bun ${Bun.version} on ${process.platform}/${process.arch}`,
    detail: `cwd ${root}${main === null ? "" : ` · linked worktree of ${main}`}`,
  });

  const nodeModules = path.join(root, "node_modules");
  const mainModules = main === null ? null : path.join(main, "node_modules");
  if (exists(nodeModules)) {
    const bunTypes =
      exists(path.join(nodeModules, "bun-types")) ||
      exists(path.join(nodeModules, "@types", "bun"));
    checks.push({
      id: "deps",
      status: bunTypes ? "ok" : "warn",
      title: "node_modules present",
      ...(bunTypes
        ? {}
        : {
            detail:
              "bun-types/@types/bun is missing; the `dx bun` surface test fails",
            fix: "bun install --frozen-lockfile",
          }),
    });
  } else if (mainModules !== null && exists(mainModules)) {
    checks.push({
      id: "deps",
      status: "fail",
      title: "node_modules missing in this worktree",
      detail:
        "tests that import dependencies and the `dx bun` surface test will fail here",
      fix: `ln -s ${mainModules} ${nodeModules}   # or: bun install --frozen-lockfile`,
    });
  } else {
    checks.push({
      id: "deps",
      status: "fail",
      title: "node_modules missing",
      fix: "bun install --frozen-lockfile",
    });
  }

  const requiredBins = ["dx", "sportsdesk", "wrangler", "nsh-desk", "oxlint"];
  const binDir = path.join(nodeModules, ".bin");
  const missingBins = requiredBins.filter(
    (name) => !exists(path.join(binDir, name)),
  );
  checks.push({
    id: "cli-bins",
    status: missingBins.length === 0 ? "ok" : "warn",
    title:
      missingBins.length === 0
        ? "workspace bun x CLI bins linked in node_modules/.bin"
        : `node_modules/.bin missing ${missingBins.join(", ")}`,
    ...(missingBins.length === 0
      ? {}
      : {
          detail:
            "bun x <cli> and oxlint gates expect packages/sportsdesk-ops linked",
          fix: "./bin/dx exec bun-deps install   # or: bun install --frozen-lockfile",
        }),
  });

  const book = path.join(root, "enriched_customers_full.json");
  const mainBook =
    main === null ? null : path.join(main, "enriched_customers_full.json");
  if (exists(book)) {
    checks.push({ id: "book", status: "ok", title: "customer book present" });
  } else if (mainBook !== null && exists(mainBook)) {
    checks.push({
      id: "book",
      status: "warn",
      title: "gitignored customer book missing here",
      detail:
        "tests/sportsdesk_cli_rankings.test.ts and tests/customer_profile_audit.test.ts error without it",
      fix: `ln -s ${mainBook} ${book}`,
    });
  } else {
    checks.push({
      id: "book",
      status: "warn",
      title: "gitignored customer book missing",
      detail:
        "two rankings/profile tests error; every other gate runs without it",
      fix: "bun run scripts/audit_customer_book.ts  # or symlink a built enriched_customers_full.json",
    });
  }

  const feedPath = path.join(root, "docs", "graph-live-feed.json");
  const feed = record(readJson(feedPath));
  if (feed === null) {
    checks.push({
      id: "feed",
      status: "fail",
      title: "docs/graph-live-feed.json missing or unreadable",
      fix: "bun run scripts/graph_feed_poller_daemon.ts --once",
    });
  } else {
    const provenance = record(feed.provenance);
    const polymarket =
      provenance === null ? null : record(provenance.polymarket);
    checks.push({
      id: "feed",
      status: "ok",
      title: `graph feed ${String(feed.dataMode ?? "unknown")} · ${String(feed.lastUpdatedCdt ?? "no timestamp")}`,
      detail: [
        `source ${String(polymarket?.source ?? "unknown")}`,
        `wallets ok ${String(polymarket?.walletsOk ?? "?")} / invalid ${String(polymarket?.walletsInvalid ?? "?")}`,
        `legs ${String(feed.totalOpenLegsCount ?? "?")}`,
      ].join(" · "),
      fix: "bun run scripts/graph_feed_poller_daemon.ts --once --live --no-backtest-artifact",
    });
  }

  const docsHash = hashOf(path.join(root, "docs", "graph.html"));
  const distHash = hashOf(path.join(root, "dist", "graph.html"));
  checks.push({
    id: "dist",
    status: distHash === null ? "warn" : distHash === docsHash ? "ok" : "warn",
    title:
      distHash === null
        ? "dist/ is not staged"
        : distHash === docsHash
          ? "dist/ graph.html matches docs/"
          : "dist/ graph.html is stale",
    fix: "bun run docs:stage",
  });

  checks.push({
    id: "graphviz",
    status: Bun.which("dot") === null ? "warn" : "ok",
    title:
      Bun.which("dot") === null
        ? "graphviz `dot` not found"
        : "graphviz `dot` present",
    fix: "brew install graphviz  # the dot-render test needs it",
  });

  const shell = playwrightHeadlessShell();
  const cdpUp = await probe("http://127.0.0.1:9222/json/version");
  checks.push({
    id: "browser",
    status: cdpUp || shell !== null ? "ok" : "warn",
    title: cdpUp
      ? "browser CDP reachable on :9222"
      : shell !== null
        ? "Playwright headless shell available (stock Chrome is blocked by the sandbox)"
        : "no headless browser found",
    detail: cdpUp
      ? ""
      : (shell ?? "stock Chrome cannot initialize its own sandbox here"),
    fix:
      shell === null
        ? "bunx playwright install chromium"
        : `"${shell}" --no-sandbox --remote-debugging-port=9222 about:blank   # or: ./bin/dx shot <url>`,
  });

  const sportsdeskPort = resolveSportsdeskDaemonPort(Bun.env, 4020);
  const webviewPort = resolveBunServePort(Bun.env);
  const sportsdeskUp = await probe(`http://127.0.0.1:${sportsdeskPort}/health`);
  const webviewUp =
    webviewPort !== 0 &&
    (await probe(`http://127.0.0.1:${webviewPort}/health`));
  const daemonUp = sportsdeskUp || webviewUp;
  const activeDaemonPort = sportsdeskUp ? sportsdeskPort : webviewPort;

  checks.push({
    id: "daemon",
    status: daemonUp ? "ok" : "warn",
    title: daemonUp
      ? `sportsdesk daemon up on :${activeDaemonPort} (API /health reachable)`
      : `sportsdesk daemon not running on :${sportsdeskPort} (run: bun run serve)`,
    fix: `PORT=${sportsdeskPort} bun run serve`,
  });

  const dashboardUp =
    (await probe("http://127.0.0.1:4022/health")) ||
    (await probe("http://127.0.0.1:4022/"));
  checks.push({
    id: "dashboard",
    status: dashboardUp ? "ok" : "warn",
    title: dashboardUp
      ? "dashboard dev server up on :4022 (SPA, PTY terminal & live stream)"
      : "dashboard dev server not running on :4022",
    fix: "bun run dev",
  });

  const dshDir = path.join(os.homedir(), ".dsh");
  let dshWritable = false;
  try {
    fs.accessSync(dshDir, fs.constants.W_OK);
    dshWritable = true;
  } catch {
    dshWritable = false;
  }
  checks.push({
    id: "dsh-writes",
    status: dshWritable ? "ok" : "warn",
    title: dshWritable
      ? "~/.dsh is writable (pre-push logs and proof cache work)"
      : "~/.dsh is not writable from this sandbox",
    detail: dshWritable
      ? ""
      : "the pre-push gate still runs, but its log/proof-cache writes are denied; nothing is lost",
  });

  const tokenFiles = [
    path.join(root, "cloudflare.env"),
    path.join(
      Bun.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "cloudflare",
      "pages.env",
    ),
  ];
  const tokenFile = tokenFiles.find(exists);
  const envToken =
    Bun.env.CLOUDFLARE_API_TOKEN !== undefined &&
    Bun.env.CLOUDFLARE_API_TOKEN !== "";
  checks.push({
    id: "deploy",
    status: envToken || tokenFile !== undefined ? "ok" : "warn",
    title:
      envToken || tokenFile !== undefined
        ? "Pages deploy token available"
        : "no Pages token in env or documented paths",
    detail: envToken
      ? "CLOUDFLARE_API_TOKEN set in this shell"
      : (tokenFile ??
        "missing ./cloudflare.env and $XDG_CONFIG_HOME/cloudflare/pages.env"),
    fix: "source a Pages-scoped CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (never .env; it carries R2/F402 secrets)",
  });

  return checks;
}

/** exit 1 only when something actually blocks a gate; warnings stay green. */
export function exitCode(checks: readonly Check[]): number {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/** Deterministic text report (no colors, no timestamps) for tests and terminals. */
export function renderReport(checks: readonly Check[], root = ROOT): string {
  const count = (status: CheckStatus): number =>
    checks.filter((check) => check.status === status).length;
  const lines = [
    `agent:doctor · ${root}`,
    `${checks.length} checks · ${count("ok")} ok · ${count("warn")} warn · ${count("fail")} fail`,
    "",
  ];
  const label: Record<CheckStatus, string> = {
    ok: "OK  ",
    warn: "WARN",
    fail: "FAIL",
  };
  for (const check of checks) {
    lines.push(`${label[check.status]} ${check.title}`);
    if (check.detail !== undefined && check.detail !== "") {
      lines.push(`     ${check.detail}`);
    }
    if (check.fix !== undefined && check.fix !== "" && check.status !== "ok") {
      lines.push(`     fix: ${check.fix}`);
    }
  }
  lines.push(
    "",
    count("fail") > 0
      ? "RESULT: FAIL — fix the FAIL lines before running gates"
      : "RESULT: PASS (warnings are optional)",
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const json = process.argv.includes("--json");
  const checks = await runDoctor(ROOT);
  if (json) {
    console.log(JSON.stringify({ root: ROOT, checks }, null, 2));
  } else {
    console.log(renderReport(checks, ROOT));
  }
  return exitCode(checks);
}

if (import.meta.main) {
  process.exit(await main());
}
