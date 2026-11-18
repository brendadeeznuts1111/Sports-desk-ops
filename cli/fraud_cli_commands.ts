/**
 * @file fraud_cli_commands.ts
 * @description Frozen command-help registry for `cli/sportsdesk_fraud_cli.ts`.
 *
 * Zero imports by design: the contract conformance gate
 * (`tests/security_plugin_contract.test.ts`) imports this module without pulling the CLI, its
 * dependency graph, or anything that needs node_modules. The string literals below mirror
 * `FRAUD_CATEGORIES` (lib/fraud_patterns.ts) and the two canonical manifest keys; the gate
 * asserts them against the source constants.
 */

export interface HelpRow {
  readonly flags: string;
  readonly description: string;
}

export interface CommandHelp {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly detail: readonly string[];
  readonly arguments?: readonly HelpRow[];
  readonly options: readonly HelpRow[];
  readonly examples: readonly string[];
}

export const HELP_COMMANDS: readonly CommandHelp[] = [
  {
    name: "status",
    summary: "Source matrix, corpus summary, model state and next step",
    usage: "status [flags]",
    detail: [
      "Prints the measured state of all 11 security sources (exists/bytes/age/stale/",
      "provenance/sha256/state/note), the parsed corpus summary and the fitted-model state.",
      "A missing source is reported as MISSING with its reason, never as zero records.",
      "integrity: bet-group ownership/financial-field validation over every discoverable",
      "capture (status verified|incomplete|invalid|unavailable; zero violations is only clean",
      "when coverage completed).",
      "settlementVerification: reported separately and stays unverified while no same-book",
      "settlement ledger is available; it is never mixed into the integrity status.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts status --json"],
  },
  {
    name: "bets",
    summary:
      "Filtered, masked bet rows plus an aggregate (never the whole corpus)",
    usage:
      "bets [--agent <id>] [--account <id>] [--state <code>] [--since <iso>] [--limit N] [--include-bots <bool>] [flags]",
    detail: [
      "Normalizes getBetReport rows to the frozen BetRecord shape. IP addresses are masked",
      "(ipMasked/ipTag/ipPrefix24) at the parse boundary; a raw address is never emitted.",
      "The aggregate covers the filtered set; `sample` is capped by --limit.",
      "integrity: the loaded corpus's bet-group integrity object (same contract as status).",
    ],
    options: [
      { flags: "--agent <id>", description: "Filter to one agent login." },
      {
        flags: "--account <id>",
        description: "Filter to one betReport userID.",
      },
      {
        flags: "--state <code>",
        description: "Filter to one raw wager state code.",
      },
      {
        flags: "--since <iso>",
        description: "Only rows placed at/after this timestamp.",
      },
      {
        flags: "-l, --limit <N>",
        description: "Sample rows to return (1-200, default 25).",
      },
      {
        flags: "--include-bots <bool>",
        description: "Include isSuspectedBot rows (true|false, default true).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts bets --json --limit 10",
      "bun run cli/sportsdesk_fraud_cli.ts bets --state 1 --include-bots false --json",
    ],
  },
  {
    name: "queue",
    summary:
      "Ranked triage queue: flags, findings, model score, rule evidence, bets",
    usage: "queue [--limit N] [flags] | queue build --dry-run [flags]",
    detail: [
      "Orders the accounts with at least one non-data-quality account finding or one",
      "suspected-bot / reversed-credit / manual-log / odds-drift row. Order is lexicographic:",
      "direct desk-flag rows, then critical/high/medium/low/info account-finding counts, then",
      "odds-drift rows, then the fitted model's 0-100 proxy score (null last), then unreviewed",
      "applied-rule hits, then confirmed applied-rule hits, then bet rows, then account id.",
      "Rule evidence is a tie-break after the model score and never adds points; only rules",
      "the readiness gate applied after >= 5 confirmed reviews can contribute. Each row also",
      "carries ruleEvidenceStatus: bridged (lookup ran), unmatched (identity join failed), or",
      "not_applied (no rule reached the gate), so 'no hit' is distinct from 'could not check'.",
      "No finding is converted to an invented point score and the model column is not a",
      "probability. Detectors are mostly book/agent-level aggregates, so account finding",
      "counts are usually 0; model-missing is reported as null scores, never as zeros.",
      "queue build reads two bridge artifacts: reports/security/bridge-coverage.json (the",
      "measured join count) and reports/security/bridge-representativeness.json (the study;",
      "`representative` is the only field the gate reads). A missing study blocks execution;",
      "a missing coverage file falls back to the committed 2026-11-05 baseline, with its",
      "measurement time, rather than reporting 0%.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Rows to return (1-100, default 25).",
      },
      {
        flags: "build --dry-run",
        description:
          "Only mode implemented: call the readiness gate and build the queue in memory. Write mode is pending a persistence contract.",
      },
      {
        flags: "--review-db <path>",
        description: "Review ledger used by the queue-build readiness gate.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts queue --json",
      "bun run cli/sportsdesk_fraud_cli.ts queue --limit 10 --json",
      "bun run cli/sportsdesk_fraud_cli.ts queue build --dry-run --json",
    ],
  },
  {
    name: "ip-graph",
    summary: "Masked IP clusters and account fan-out summary",
    usage: "ip-graph [--min-accounts N] [--limit N] [--prefix24 a.b.c] [flags]",
    detail: [
      "Groups rows by the stable ip:<sha256:8> tag (or by /24 with --prefix24) and reports",
      "distinct-account/bet counts. Clusters are masked; no raw address is emitted.",
    ],
    options: [
      {
        flags: "--min-accounts <N>",
        description:
          "Only clusters with at least N distinct accounts (default 2).",
      },
      {
        flags: "-l, --limit <N>",
        description: "Maximum clusters (1-100, default 25).",
      },
      {
        flags: "--prefix24 <a.b.c>",
        description: "Only clusters on this /24 prefix.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts ip-graph --json",
      "bun run cli/sportsdesk_fraud_cli.ts ip-graph --min-accounts 5 --limit 10 --json",
    ],
  },
  {
    name: "weblog",
    summary:
      "F402 WebLog rollup posture, detector flags, gates and GSLive activity",
    usage: "weblog [flags]",
    detail: [
      "Derives the zero-PII F402 WebLog posture from the newest valid rollup and runs the",
      "rollup detectors. The GSLive WebLog activity artifact is currently MISSING (session",
      "expired, HTTP 401): its six detectors report insufficientData, not zero.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts weblog --json"],
  },
  {
    name: "patterns",
    summary: "The frozen detector catalog as FraudFinding[] with counts",
    usage:
      "patterns [--min-severity critical|high|medium|low|info] [--category <category>] [--agent <id>] [--limit N] [flags]",
    detail: [
      "Runs every frozen detector id (11 bet-report, 7 WebLog-rollup, 6 GSLive-activity,",
      "6 F402-ticket, 4 data-quality) and reports severity/category counts. Findings with",
      "insufficientData say which source was missing; they are never a fabricated zero.",
    ],
    options: [
      {
        flags: "--min-severity <level>",
        description: "Inclusive minimum severity (default info).",
      },
      {
        flags: "--category <category>",
        description: `One of courtsiding, multi_accounting, line_shopping, match_integrity, agent_scheme, ticket_anomaly, ip_network, data_quality.`,
      },
      {
        flags: "--agent <id>",
        description: "Only findings about this agent login.",
      },
      {
        flags: "-l, --limit <N>",
        description: "Maximum findings (1-200, default 100).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts patterns --json",
      "bun run cli/sportsdesk_fraud_cli.ts patterns --min-severity high --json",
    ],
  },
  {
    name: "explore",
    summary:
      "Read-only pattern exploration: research-backlog field coverage + descriptive candidates",
    usage: "explore [--limit N] [flags]",
    detail: [
      "Maps config/fraud-research.json's proposed detectors to the raw fields this corpus",
      "actually carries (available/missing per field), then ranks three descriptive account",
      "candidates: low market-entropy specialisation, manual-log rows without an adminUser,",
      "and stake concentration. It adds no frozen detector and changes none.",
      "Every candidate is labelled exploratory and carries no threshold verdict. No account",
      "decision should cite it as evidence.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Candidate rows per list (1-50, default 10).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts explore --json",
      "bun run cli/sportsdesk_fraud_cli.ts explore --limit 5 --json",
    ],
  },
  {
    name: "model",
    summary: "Weak-label model: report | fit [--write] | score <accountId>",
    usage:
      "model [report] [--include-score-map] | model fit [--write] [--split 0.5-0.9] [--l2 0-1] [--epochs 100-5000] [--proxy desk_flag|suspected_bot|reversed_credit] | model score <accountId>",
    detail: [
      "Transparent logistic ranker over getBetReport rows. It predicts a desk-flag PROXY,",
      "not fraud. History features use only strictly earlier logTime rows; fit is",
      "deterministic with a temporal split and reports AUC/AP/precision@1%/5%/Brier/",
      "calibration plus stability and drift. `fit` is a DRY RUN unless --write is passed;",
      "the only write in this plugin is reports/security/fraud-model.json (0600, atomic).",
    ],
    arguments: [
      {
        flags: "<accountId>",
        description: "score: betReport userID to score.",
      },
    ],
    options: [
      {
        flags: "--write",
        description: "Persist the fitted artifact (operator-gated).",
      },
      {
        flags: "--include-score-map",
        description:
          "report only: include the full 1001-point train-CDF quantile array (~19 KB). Without it the payload reports scoreMap as {size, quantileCount} only; the artifact always keeps the quantiles.",
      },
      {
        flags: "--split <0.5-0.9>",
        description: "Temporal train fraction (default 0.7).",
      },
      {
        flags: "--l2 <0-1>",
        description: "L2 regularization strength (default 0.01).",
      },
      {
        flags: "--epochs <100-5000>",
        description:
          "Full-batch gradient-descent epoch budget (default 4000; converges at ~1250 measured on the live corpus).",
      },
      {
        flags: "--proxy <label>",
        description:
          "Weak label: desk_flag (default), suspected_bot, reversed_credit.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts model fit --json",
      "bun run cli/sportsdesk_fraud_cli.ts model fit --write --json",
      "bun run cli/sportsdesk_fraud_cli.ts model report --json",
      "bun run cli/sportsdesk_fraud_cli.ts model score 983516 --json",
    ],
  },
  {
    name: "dossier",
    summary:
      "One account/agent: hierarchy, bet aggregates, findings, score, masked IPs",
    usage: "dossier <accountId|agentId> [flags]",
    detail: [
      "Resolves an account (betReport userID) or agent login, then reports the agent-tree",
      "hierarchy, bet aggregates, detector findings, the model score (when fitted), the",
      "masked IP clusters and source freshness. An unknown id is a structured refusal",
      "(unknown_subject, exit 3).",
    ],
    arguments: [
      {
        flags: "<accountId|agentId>",
        description: "betReport userID or desk agent login.",
      },
    ],
    options: [],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts dossier 983516 --json",
      "bun run cli/sportsdesk_fraud_cli.ts dossier MARCO1022 --json",
    ],
  },
  {
    name: "research",
    summary: "Prior-art catalog and the model's explicit limits list",
    usage: "research [flags]",
    detail: [
      "Returns the Lead-owned config/fraud-research.json catalog (present:false when absent)",
      "and the model limits every answer must carry. Read-only; no network.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts research --json"],
  },
  {
    name: "cross-ref",
    summary: "Live R2-backed columnar pairwise customer wager cross-reference",
    usage:
      "cross-ref <customerA> <customerB> [--bridge all|f402|gslive] [--max-overlaps N] [flags]",
    detail: [
      `Hydrates contiguous SoA columns via Bun.S3Client from sportsdesk-ops-reports R2 manifests`,
      `(manifests/wagers-by-state/latest and manifests/syndicate-rings/latest) and runs`,
      "zero-Map/zero-Set deduplicated follower attribution between customerA and customerB.",
      "Local file flags (--input/--file) and .json/.jsonl/.sqlite/.dodbin paths fail closed",
      "with ERR_OPS_LOCAL_JSON_FORBIDDEN (exit 78).",
      "Declared networked exception (contract rev 3): reads R2_ACCESS_KEY_ID and",
      "R2_SECRET_ACCESS_KEY from the environment; writes nothing; prints no tokens.",
      "Exit classes: 65 data/reconciliation, 70 integrity, 74 CAS/IO, 77 token isolation,",
      "78 config.",
    ],
    arguments: [
      {
        flags: "<customerA>",
        description: "Primary / reference customer login (e.g. C001).",
      },
      {
        flags: "<customerB>",
        description: "Comparison customer login (e.g. C002).",
      },
    ],
    options: [
      {
        flags: "--bridge <all|f402|gslive>",
        description:
          "Filter evaluation to one bridge or all bridges (default: all).",
      },
      {
        flags: "--max-overlaps <N>",
        description:
          "Maximum sample overlaps in --json output (0-1024, default 16).",
      },
    ],
    examples: [
      "bun x sportsdesk-fraud cross-ref C001 C002 --json",
      "bun x sportsdesk-fraud cross-ref C001 C002 --bridge f402 --max-overlaps 32 --json",
    ],
  },
];
