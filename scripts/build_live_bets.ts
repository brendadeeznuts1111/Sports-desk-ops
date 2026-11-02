#!/usr/bin/env bun
/**
 * @file build_live_bets.ts
 * @description Builds `data/live-bets.json` from real F402 `Report/Pending` captures.
 *
 * Accepts any capture shape this repo produces:
 *   --probe scratch/f402-probes/<ts>/Pending.json   (preview-based probe capture)
 *   --body  <file>                                  (raw envelope or single row)
 *   --capture docs/evidence/captures/<date>/X.post.json  (evidence envelope: rows only if present)
 *
 * Output is PII-free: `Password`, `NameFirst` and `Login` are stripped before writing,
 * and the script refuses to write if any of them survive.
 *
 * Usage:
 *   bun scripts/build_live_bets.ts --probe scratch/f402-probes/2026-11-01T02-22-32-829Z/Pending.json
 *   bun scripts/build_live_bets.ts --body tests/f402-pending-wager-sample.json --out data/live-bets.json
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildArtifact,
  hierarchyIndexFromAgentIndex,
  hierarchyIndexFromTree,
  readHierarchyRows,
  readPendingRows,
  summarizeGames,
  type PendingRow,
} from "../lib/live_bets.ts";

interface Args {
  probes: string[];
  bodies: string[];
  out: string;
  capturedAt: string | null;
  operation: string;
  /** Optional GENERAL rows used to attach Level/AgentType to each wager. */
  hierarchy: string | null;
  /** Committed identity index (data/agent-index.json); needs no capture to resolve levels. */
  agentIndex: string | null;
  /** Committed agent tree (data/agent-tree.json); structure fallback. */
  agentTree: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    probes: [],
    bodies: [],
    out: "data/live-bets.json",
    capturedAt: null,
    operation: "/cloud/api/Report/Pending",
    hierarchy: null,
    agentIndex: "data/agent-index.json",
    agentTree: "data/agent-tree.json",
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--probe":
        if (value === undefined) throw new Error("--probe needs a path");
        args.probes.push(value);
        i++;
        break;
      case "--body":
        if (value === undefined) throw new Error("--body needs a path");
        args.bodies.push(value);
        i++;
        break;
      case "--out":
        if (value === undefined) throw new Error("--out needs a path");
        args.out = value;
        i++;
        break;
      case "--hierarchy":
        if (value === undefined) throw new Error("--hierarchy needs a path");
        args.hierarchy = value;
        i++;
        break;
      case "--agent-index":
        if (value === undefined) throw new Error("--agent-index needs a path");
        args.agentIndex = value;
        i++;
        break;
      case "--no-agent-index":
        args.agentIndex = null;
        break;
      case "--agent-tree":
        if (value === undefined) throw new Error("--agent-tree needs a path");
        args.agentTree = value;
        i++;
        break;
      case "--no-agent-tree":
        args.agentTree = null;
        break;
      case "--captured-at":
        if (value === undefined) throw new Error("--captured-at needs a value");
        args.capturedAt = value;
        i++;
        break;
      case "--operation":
        if (value === undefined) throw new Error("--operation needs a value");
        args.operation = value;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: bun scripts/build_live_bets.ts [flags]",
            "",
            "  --probe <path>        probe capture (uses result.preview)",
            "  --body <path>         raw Pending envelope, row array, or single row",
            "  --out <path>          output artifact (default data/live-bets.json)",
            "  --agent-index <path>  committed identity index (default data/agent-index.json)",
            "  --no-agent-index      skip the identity index",
            "  --agent-tree <path>   committed agent tree (default data/agent-tree.json)",
            "  --no-agent-tree       skip tree lookup",
            "  --hierarchy <path>    list-agents envelope or GENERAL rows for Level/AgentType",
            "  --captured-at <iso>   override the capture timestamp",
            "  --operation <name>    operation label recorded in the artifact",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${String(flag)}`);
    }
  }

  if (args.probes.length === 0 && args.bodies.length === 0) {
    throw new Error("at least one --probe or --body is required");
  }
  return args;
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`not found: ${path}`);
  return file.json();
}

function captureTimestamp(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const capturedAt = (payload as Record<string, unknown>).capturedAt;
  return typeof capturedAt === "string" && capturedAt !== ""
    ? capturedAt
    : null;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  const rows = new Map<string, PendingRow>();
  let capturedAt = args.capturedAt;

  for (const path of [...args.probes, ...args.bodies]) {
    const payload = await readJson(path);
    capturedAt ??= captureTimestamp(payload);

    const found = readPendingRows(payload);
    if (found.length === 0) {
      console.warn(`[build_live_bets] no complete rows in ${path}`);
      continue;
    }
    for (const row of found) {
      const key = `${String(row.TicketNumber).trim()}-${String(row.WagerNumber).trim()}`;
      rows.set(key, row);
    }
    console.log(`[build_live_bets] ${path}: ${found.length} row(s)`);
  }

  if (rows.size === 0) {
    throw new Error("no pending rows recovered from the given captures");
  }

  const hierarchy =
    args.hierarchy === null
      ? undefined
      : readHierarchyRows(
          await readJson(resolve(process.cwd(), args.hierarchy)),
        );
  if (args.hierarchy !== null) {
    console.log(
      `[build_live_bets] hierarchy: ${hierarchy?.length ?? 0} agent row(s) from ${args.hierarchy}`,
    );
  }

  const indexPath = args.agentIndex;
  const treePath = args.agentTree;

  const indexPayload =
    indexPath === null
      ? undefined
      : await (async () => {
          const file = Bun.file(resolve(process.cwd(), indexPath));
          return (await file.exists()) ? file.json() : undefined;
        })();
  const tree =
    treePath === null
      ? undefined
      : await (async () => {
          const file = Bun.file(resolve(process.cwd(), treePath));
          return (await file.exists()) ? file.json() : undefined;
        })();

  const artifact = buildArtifact([...rows.values()], {
    operation: args.operation,
    capturedAt,
    ...(indexPayload !== undefined
      ? { hierarchyIndex: hierarchyIndexFromAgentIndex(indexPayload) }
      : tree !== undefined
        ? { hierarchyIndex: hierarchyIndexFromTree(tree) }
        : hierarchy === undefined
          ? {}
          : { hierarchy }),
  });

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const summary = summarizeGames(
    artifact.games,
    artifact.pendingCount,
    artifact.dataSource,
    artifact.capturedAt,
  );
  console.log(
    `[build_live_bets] wrote ${args.out}: ${summary.totalGames} game(s), ` +
      `wagered ${summary.totalWagered}¢, toWin ${summary.totalToWin}¢`,
  );
  console.log(
    `[build_live_bets] bySubSport: ${Object.keys(summary.bySubSport).join(", ")}`,
  );
  console.log(`[build_live_bets] dataSource: ${artifact.dataSource}`);
  const scope = artifact.agents;
  console.log(
    `[build_live_bets] agents: ${scope.agents.length} resolved, ` +
      `${scope.unresolved.length} unresolved, ${scope.unassignedGames} unassigned, ` +
      `maxLevel ${scope.maxLevel ?? "n/a"}` +
      (scope.collisions.length > 0
        ? `, collisions: ${scope.collisions.map((c) => c.key).join(", ")}`
        : ""),
  );
}

try {
  await main();
} catch (err) {
  console.error(
    `build_live_bets: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
