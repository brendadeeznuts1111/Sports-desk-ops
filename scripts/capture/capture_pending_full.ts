#!/usr/bin/env bun
/**
 * @file capture_pending_full.ts
 * @description Captures the FULL `/cloud/api/Report/Pending` body and rebuilds `data/live-bets.json`.
 *
 * Why this exists: `scripts/capture/f402_probe.ts` stores only a 2 KB `result.preview` per
 * operation, so a 41 KB Pending response collapses to a single recoverable row. This script
 * keeps the whole body (gitignored, under `scratch/`) so every pending wager reaches the
 * scoreboard.
 *
 * Auth goes through `createF402ReplayTransport()` — WebView profile, session file, or replay
 * proxy. No tokens on the command line, no tokens written to the artifact.
 *
 * Usage:
 *   # live capture for one or more customers, then rebuild the artifact
 *   bun run capture:pending --customer H1716
 *   bun run capture:pending --customer H1716 --customer CC364
 *
 *   # rebuild from a body you already saved (no network, no session)
 *   bun run capture:pending --from-body scratch/f402-captures/pending-H1716.json
 *
 * Outputs:
 *   scratch/f402-captures/pending-<customer>-<ts>.json   raw body (gitignored, PII-bearing)
 *   data/live-bets.json                                  PII-free artifact the server serves
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildArtifact,
  hierarchyIndexFromAgentIndex,
  hierarchyIndexFromTree,
  readHierarchyRows,
  readPendingRows,
  summarizeGames,
  type PendingRow,
} from "../../lib/live_bets.ts";

const REPORT_PENDING_URL = "https://fantasy402.com/cloud/api/Report/Pending";
const OPERATION = "/cloud/api/Report/Pending";
const root = join(import.meta.dir, "../..");

interface Options {
  customers: string[];
  bodies: string[];
  out: string;
  bodyDir: string;
  /** Optional GENERAL rows so wagers carry Level/AgentType. */
  hierarchy: string | null;
  /** Committed identity index; preferred over the tree and raw rows. */
  agentIndex: string | null;
  /** Committed agent tree; structure fallback. */
  agentTree: string | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    customers: [],
    bodies: [],
    out: "data/live-bets.json",
    bodyDir: "scratch/f402-captures",
    hierarchy: null,
    agentIndex: "data/agent-index.json",
    agentTree: "data/agent-tree.json",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case "--customer":
        if (value === undefined) throw new Error("--customer needs an id");
        options.customers.push(value.trim());
        i++;
        break;
      case "--from-body":
        if (value === undefined) throw new Error("--from-body needs a path");
        options.bodies.push(value);
        i++;
        break;
      case "--out":
        if (value === undefined) throw new Error("--out needs a path");
        options.out = value;
        i++;
        break;
      case "--body-dir":
        if (value === undefined) throw new Error("--body-dir needs a path");
        options.bodyDir = value;
        i++;
        break;
      case "--hierarchy":
        if (value === undefined) throw new Error("--hierarchy needs a path");
        options.hierarchy = value;
        i++;
        break;
      case "--agent-index":
        if (value === undefined) throw new Error("--agent-index needs a path");
        options.agentIndex = value;
        i++;
        break;
      case "--no-agent-index":
        options.agentIndex = null;
        break;
      case "--agent-tree":
        if (value === undefined) throw new Error("--agent-tree needs a path");
        options.agentTree = value;
        i++;
        break;
      case "--no-agent-tree":
        options.agentTree = null;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: bun run capture:pending [flags]",
            "",
            "  --customer <id>     customer to query (repeatable; falls back to F402_CUSTOMER_ID)",
            "  --from-body <path>  reuse a saved body instead of calling the API",
            "  --out <path>        artifact path (default data/live-bets.json)",
            "  --body-dir <path>   where raw bodies are saved (default scratch/f402-captures)",
            "  --agent-index <path> identity index (default data/agent-index.json)",
            "  --no-agent-index     skip the identity index",
            "  --agent-tree <path> committed agent tree (default data/agent-tree.json)",
            "  --no-agent-tree     skip tree lookup",
            "  --hierarchy <path>  list-agents envelope to attach Level/AgentType",
            "  --dry-run           capture and report, write nothing",
            "",
            "Auth: a session file (bun run session:login), F402_SESSION_FILE or F402_REPLAY_PROXY_URL.",
            "F402_WEBVIEW_PROFILE is a WebView dataStore, not a session — the transport cannot read it.",
            "Never pass a token on the command line.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${String(flag)}`);
    }
  }

  if (options.customers.length === 0) {
    const envCustomer = Bun.env.F402_CUSTOMER_ID?.trim();
    if (envCustomer !== undefined && envCustomer !== "") {
      options.customers.push(envCustomer);
    }
  }
  if (options.customers.length === 0 && options.bodies.length === 0) {
    throw new Error(
      "nothing to do: pass --customer <id>, --from-body <path>, or set F402_CUSTOMER_ID",
    );
  }
  return options;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function fetchPendingBody(customerID: string): Promise<string> {
  const { createF402ReplayTransport } =
    await import("../../lib/f402_replay_transport.ts");

  // Fail before the request rather than surfacing an openresty 401 page: the transport
  // degrades to a cookie-less fetch when nothing is configured.
  const { readF402Session } = await import("../../lib/f402_session.ts");
  const proxyConfigured = (Bun.env.F402_REPLAY_PROXY_URL ?? "").trim() !== "";
  // A WebView profile is not a session: `createF402ReplayTransport` never reads one
  // (lib/f402_replay_transport.ts:2-3), so counting it here silenced this guard and then sent a
  // cookie-less request into a 401 page.
  if (!proxyConfigured && readF402Session() === null) {
    throw new Error(
      [
        "no F402 session available for a live capture.",
        "Configure one of:",
        "  bun run session:login                       (one WebView login; writes the 0600 cache)",
        "  F402_SESSION_FILE=<session json>            (see lib/f402_session.ts)",
        "  F402_REPLAY_PROXY_URL=<localhost proxy>",
        "F402_WEBVIEW_PROFILE alone is not enough: the transport does not read WebView cookies.",
        "Or rebuild from a body you already saved: --from-body <path>",
      ].join("\n"),
    );
  }

  const transport = await createF402ReplayTransport();
  try {
    const body = new URLSearchParams({
      customerID,
      token: "",
      operation: "Pending",
    });
    const res = await transport.fetch(REPORT_PENDING_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "application/json, text/plain, */*",
      },
      body: body.toString(),
    });
    const text = await res.text();
    console.log(
      `[capture:pending] ${customerID} via ${transport.label} -> HTTP ${res.status}, ${text.length} bytes`,
    );
    if (!res.ok) {
      throw new Error(
        `Report/Pending returned HTTP ${res.status} for ${customerID}: ${text.slice(0, 200)}`,
      );
    }
    return text;
  } finally {
    await transport.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const bodyDir = resolve(root, options.bodyDir);
  mkdirSync(bodyDir, { recursive: true });

  const rows: PendingRow[] = [];
  let capturedAt: string | null = null;
  const stamp = timestamp();

  for (const path of options.bodies) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`not found: ${path}`);
    const text = await file.text();
    const found = readPendingRows(JSON.parse(text));
    console.log(`[capture:pending] ${path}: ${found.length} row(s)`);
    rows.push(...found);
  }

  for (const customerID of options.customers) {
    const text = await fetchPendingBody(customerID);
    capturedAt ??= new Date().toISOString();

    if (!options.dryRun) {
      const safeCustomer = customerID.replace(/[^A-Za-z0-9_-]/g, "_");
      const rawPath = join(bodyDir, `pending-${safeCustomer}-${stamp}.json`);
      await Bun.write(rawPath, text);
      console.log(
        `[capture:pending] raw body -> ${rawPath} (PII-bearing, gitignored)`,
      );
    }

    const found = readPendingRows(JSON.parse(text));
    console.log(`[capture:pending] ${customerID}: ${found.length} row(s)`);
    rows.push(...found);
  }

  if (rows.length === 0) {
    throw new Error("capture produced no pending rows");
  }

  const hierarchy =
    options.hierarchy === null
      ? undefined
      : readHierarchyRows(
          await Bun.file(resolve(root, options.hierarchy)).json(),
        );

  const indexPath = options.agentIndex;
  const treePath = options.agentTree;

  const indexPayload =
    indexPath === null
      ? undefined
      : await (async () => {
          const file = Bun.file(resolve(root, indexPath));
          return (await file.exists()) ? file.json() : undefined;
        })();
  const tree =
    treePath === null
      ? undefined
      : await (async () => {
          const file = Bun.file(resolve(root, treePath));
          return (await file.exists()) ? file.json() : undefined;
        })();

  const artifact = buildArtifact(rows, {
    operation: OPERATION,
    capturedAt,
    ...(indexPayload !== undefined
      ? { hierarchyIndex: hierarchyIndexFromAgentIndex(indexPayload) }
      : tree !== undefined
        ? { hierarchyIndex: hierarchyIndexFromTree(tree) }
        : hierarchy === undefined
          ? {}
          : { hierarchy }),
  });
  const summary = summarizeGames(
    artifact.games,
    artifact.pendingCount,
    artifact.dataSource,
    artifact.capturedAt,
  );

  console.log(
    `[capture:pending] ${summary.totalGames} game(s), wagered ${summary.totalWagered}¢, toWin ${summary.totalToWin}¢`,
  );
  console.log(
    `[capture:pending] bySubSport: ${Object.keys(summary.bySubSport).join(", ") || "(none)"}`,
  );

  if (options.dryRun) {
    console.log("[capture:pending] dry run: artifact not written");
    return;
  }

  const outPath = resolve(root, options.out);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[capture:pending] artifact -> ${options.out}`);
  console.log(`[capture:pending] dataSource: ${artifact.dataSource}`);
  console.log(
    "[capture:pending] restart the server (or it picks this up on next read) to serve it",
  );
}

try {
  await main();
} catch (err) {
  console.error(
    `capture:pending: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
