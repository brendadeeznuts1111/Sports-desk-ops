#!/usr/bin/env bun
/**
 * Analyze a box-local Fantasy402 puller directory.
 *
 *   bun run f402:analyze link --in /workspace/f402-pull
 *   bun run f402:analyze predict --in /workspace/f402-pull
 *   bun run f402:analyze calibrate --in /workspace/f402-pull
 *   bun run f402:analyze report --in /workspace/f402-pull
 *
 * Output stays under the input directory (default: <in>/analysis) and is
 * gitignored with the pull. IPs are hashed in summaries and stdout.
 * This CLI never calls Fantasy402.
 */

import { parseArgs } from "node:util";

import {
  F402_ANALYZE_DEFAULT_IN_DIR,
  F402AnalyzeError,
  hashIpsDeep,
  runCalibrateAnalysis,
  runLinkAnalysis,
  runPredictAnalysis,
  runReviewAnalysis,
  type F402AnalyzeCommand,
} from "../lib/f402_analyze.ts";

const COMMANDS: readonly F402AnalyzeCommand[] = [
  "link",
  "predict",
  "calibrate",
  "report",
];

function printUsage(): void {
  console.log(`Usage: bun run f402:analyze <link|predict|calibrate|report> [options]

Options:
  --in <dir>             Puller output directory (default: ${F402_ANALYZE_DEFAULT_IN_DIR})
  --out <dir>            Analysis output directory (default: <in>/analysis)
  --now <iso>            Prediction / backtest clock (ISO-8601); default is now
  --horizon-days <n>     Backtest horizon (default: 7)
  --help

Links are evidence-scored guesses, not confirmed identities.
Raw IPs are hashed in every summary and never printed to stdout.
`);
}

function flagString(
  values: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function requireCommand(argv: string[]): F402AnalyzeCommand {
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (positional === undefined || positional === "help") {
    printUsage();
    process.exit(positional === undefined ? 2 : 0);
  }
  if (!(COMMANDS as readonly string[]).includes(positional)) {
    console.error(`unknown command "${positional}"`);
    printUsage();
    process.exit(2);
  }
  return positional as F402AnalyzeCommand;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return 0;
  }
  const command = requireCommand(argv);
  const rest = argv.filter((arg) => arg !== command);
  const { values } = parseArgs({
    args: rest,
    options: {
      in: { type: "string" },
      out: { type: "string" },
      now: { type: "string" },
      "horizon-days": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printUsage();
    return 0;
  }
  const inDir = flagString(values, "in") ?? F402_ANALYZE_DEFAULT_IN_DIR;
  const outDir = flagString(values, "out");
  if (command === "link") {
    const { report, outPath } = runLinkAnalysis(
      inDir,
      outDir === undefined ? {} : { outDir },
    );
    const stdout = hashIpsDeep({
      command,
      disclaimer: report.disclaimer,
      accountCount: report.accountCount,
      edgeCount: report.edgeCount,
      clusterCount: report.clusterCount,
      clusters: report.clusters.map((cluster) => ({
        id: cluster.id,
        accounts: cluster.accounts,
        score: cluster.score,
        label: cluster.label,
        evidenceTypes: [
          ...new Set(
            cluster.edges.flatMap((edge) => edge.evidence.map((e) => e.type)),
          ),
        ],
      })),
      weblogBetLinkCount: report.weblogBetLinks.length,
      outPath,
    });
    console.log(JSON.stringify(stdout));
    return 0;
  }
  const nowRaw = flagString(values, "now");
  const nowMs = nowRaw === undefined ? undefined : Date.parse(nowRaw);
  if (nowRaw !== undefined && !Number.isFinite(nowMs)) {
    throw new F402AnalyzeError(
      "config",
      "predict",
      "invalid --now (use ISO-8601)",
    );
  }
  const horizonRaw = flagString(values, "horizon-days");
  const horizonDays = horizonRaw === undefined ? undefined : Number(horizonRaw);
  if (
    horizonRaw !== undefined &&
    (!Number.isFinite(horizonDays) || horizonDays! <= 0)
  ) {
    throw new F402AnalyzeError("config", command, "invalid --horizon-days");
  }
  const commonOpts: { outDir?: string; nowMs?: number; horizonDays?: number } =
    {};
  if (outDir !== undefined) commonOpts.outDir = outDir;
  if (nowMs !== undefined) commonOpts.nowMs = nowMs;
  if (horizonDays !== undefined) commonOpts.horizonDays = horizonDays;
  if (command === "calibrate") {
    const { report, outPath } = runCalibrateAnalysis(inDir, commonOpts);
    const stdout = hashIpsDeep({
      command,
      brier: report.brier,
      windowCount: report.windowCount,
      lowSample: report.lowSample,
      observedRate: report.observedRate,
      predictedMean: report.predictedMean,
      bins: report.bins,
      outPath,
    });
    console.log(JSON.stringify(stdout));
    return 0;
  }
  if (command === "report") {
    const { outPath, join } = runReviewAnalysis(inDir, commonOpts);
    const stdout = hashIpsDeep({
      command,
      outPath,
      join,
    });
    console.log(JSON.stringify(stdout));
    return 0;
  }
  const { report, outPath } = runPredictAnalysis(inDir, commonOpts);
  const stdout = hashIpsDeep({
    command,
    generatedAtIso: report.generatedAtIso,
    censusSnapshotCount: report.censusSnapshotCount,
    signalsNeedingMultipleCensusSnapshots:
      report.signalsNeedingMultipleCensusSnapshots,
    snapshotCadence: report.snapshotCadence,
    accounts: report.accounts.map((row) => ({
      accountId: row.accountId,
      login: row.login,
      score: row.score,
      label: row.label,
      expectedChange: row.expectedChange,
      signals: row.signals.map((s) => ({
        name: s.name,
        available: s.available,
        value: s.value,
        contribution: s.contribution,
        reason: s.reason,
      })),
    })),
    outPath,
  });
  console.log(JSON.stringify(stdout));
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof F402AnalyzeError) {
      console.error(error.message);
      process.exit(error.code === "config" || error.code === "empty" ? 2 : 1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { main };
