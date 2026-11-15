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
  loadAnalyzeConfig,
  parseAnalyzeFormat,
  parseAccountList,
  parseMinStake,
  parseSportsList,
  renderAnalyzeOutput,
  runCalibrateAnalysis,
  runDiffAnalysis,
  runExplainAnalysis,
  runLinkAnalysis,
  runPredictAnalysis,
  runReviewAnalysis,
  runRingsAnalysis,
  runTimelineAnalysis,
  type AnalyzeFormat,
  type AnalyzeRunOptions,
  type F402AnalyzeCommand,
} from "../lib/f402_analyze.ts";

const COMMANDS: readonly F402AnalyzeCommand[] = [
  "link",
  "predict",
  "calibrate",
  "report",
  "rings",
  "explain",
  "diff",
  "timeline",
];

function printUsage(): void {
  console.log(`Usage: bun run f402:analyze <link|predict|calibrate|report|rings|explain|diff|timeline> [options]

Options:
  --in <dir>             Puller output directory (default: ${F402_ANALYZE_DEFAULT_IN_DIR})
  --out <dir>            Analysis output directory (default: <in>/analysis)
  --other <dir>          Right-hand pull directory (diff only)
  --account <id>         Account to explain (explain only)
  --accounts <id,id>     Keep only these accounts
  --sports <s,s>         Keep only these sports on wagers
  --min-stake <n>        Minimum wager size (dollars, or cents if the row is in cents)
  --now <iso>            Prediction / backtest clock (ISO-8601); default is now
  --horizon-days <n>     Backtest horizon (default: 7)
  --format <json|csv|md> Stdout format (default json)
  --config <file>        JSON weights/thresholds (unknown keys fail)
  --help

Links and predictions are evidence-scored guesses, not confirmed identities.
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
      other: { type: "string" },
      account: { type: "string" },
      accounts: { type: "string" },
      sports: { type: "string" },
      "min-stake": { type: "string" },
      now: { type: "string" },
      "horizon-days": { type: "string" },
      format: { type: "string" },
      config: { type: "string" },
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
  const format: AnalyzeFormat = parseAnalyzeFormat(
    flagString(values, "format"),
  );
  const configPath = flagString(values, "config");
  const accountsRaw = flagString(values, "accounts");
  const sportsRaw = flagString(values, "sports");
  const minStakeRaw = flagString(values, "min-stake");
  const runOptions: AnalyzeRunOptions = {
    ...(outDir === undefined ? {} : { outDir }),
    ...(nowMs === undefined ? {} : { nowMs }),
    ...(horizonDays === undefined ? {} : { horizonDays }),
    ...(configPath === undefined
      ? {}
      : { config: loadAnalyzeConfig(configPath) }),
    format,
    filters: {
      ...(accountsRaw === undefined
        ? {}
        : { accounts: parseAccountList(accountsRaw, "--accounts") }),
      ...(sportsRaw === undefined
        ? {}
        : { sports: parseSportsList(sportsRaw) }),
      ...(minStakeRaw === undefined
        ? {}
        : { minStake: parseMinStake(minStakeRaw) }),
    },
  };
  const emit = (
    title: string,
    value: unknown,
    csvRows?: Record<string, unknown>[],
  ): void => {
    const hashed = hashIpsDeep(value);
    const text = renderAnalyzeOutput(
      format,
      title,
      hashed,
      csvRows === undefined ? undefined : csvRows,
    );
    console.log(format === "json" ? JSON.stringify(hashed) : text.trimEnd());
  };
  if (command === "link") {
    const { report, outPath, rings } = runLinkAnalysis(inDir, runOptions);
    const payload = {
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
      rings: rings.map((ring) => ({
        id: ring.id,
        accounts: ring.accounts,
        score: ring.score,
        label: ring.label,
        summary: ring.summary,
      })),
      weblogBetLinkCount: report.weblogBetLinks.length,
      outPath,
    };
    emit(
      "Link report",
      payload,
      rings.map((ring) => ({
        id: ring.id,
        accounts: ring.accounts.join(" "),
        score: ring.score,
        label: ring.label,
        tightness: ring.summary.tightness,
      })),
    );
    return 0;
  }
  if (command === "calibrate") {
    const { report, outPath } = runCalibrateAnalysis(inDir, runOptions);
    const payload = {
      command,
      brier: report.brier,
      windowCount: report.windowCount,
      lowSample: report.lowSample,
      observedRate: report.observedRate,
      predictedMean: report.predictedMean,
      bins: report.bins,
      ablation: report.ablation,
      outPath,
    };
    emit(
      "Calibration",
      payload,
      report.ablation.map((row) => ({ ...row })),
    );
    return 0;
  }
  if (command === "report") {
    const { outPath, join } = runReviewAnalysis(inDir, runOptions);
    emit("Review", { command, outPath, join });
    return 0;
  }
  if (command === "rings") {
    const { rings, outPath } = runRingsAnalysis(inDir, runOptions);
    emit(
      "Rings",
      {
        command,
        disclaimer:
          "Rings are evidence-scored guesses, not confirmed identities.",
        rings,
        outPath,
      },
      rings.map((ring) => ({
        id: ring.id,
        accounts: ring.accounts.join(" "),
        score: ring.score,
        tightness: ring.summary.tightness,
      })),
    );
    return 0;
  }
  if (command === "timeline") {
    const report = runTimelineAnalysis(inDir, runOptions);
    emit(
      "Timeline",
      report,
      report.accounts.flatMap((account) =>
        account.events.map((event) => ({
          accountId: event.accountId,
          kind: event.kind,
          from: event.fromValue,
          to: event.toValue,
          atIso: event.atIso,
          label: event.label,
        })),
      ),
    );
    return 0;
  }
  if (command === "explain") {
    const account = flagString(values, "account");
    const { explain, outPath } = runExplainAnalysis(inDir, {
      ...runOptions,
      ...(account === undefined ? {} : { account }),
    });
    emit("Account explain", { command, ...explain, outPath });
    return 0;
  }
  if (command === "diff") {
    const other = flagString(values, "other");
    if (other === undefined) {
      throw new F402AnalyzeError("config", "diff", "missing --other");
    }
    const { diff, outPath } = runDiffAnalysis(inDir, other, runOptions);
    emit("Pull diff", { command, ...diff, outPath });
    return 0;
  }
  const { report, outPath } = runPredictAnalysis(inDir, runOptions);
  const payload = {
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
  };
  emit(
    "Predictions",
    payload,
    payload.accounts.map((row) => ({
      accountId: row.accountId,
      score: row.score,
      label: row.label,
    })),
  );
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
