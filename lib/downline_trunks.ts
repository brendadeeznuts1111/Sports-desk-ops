import type {
  BatchedRankingResult,
  PlayerRankingRecord,
} from "./customer_rankings.ts";

export type DownlineTrunkId = "TRACKTHIS" | "NOLAPPH" | "OTHER";

export interface DownlineTrunkBranch {
  readonly id: DownlineTrunkId;
  readonly label: string;
  readonly handleUsd: number;
  readonly wagers: number;
  readonly bettors: number;
  readonly avgTicketUsd: number;
  readonly alertRatePct: number;
  readonly subAgentCount: number;
  readonly role: string;
}

export interface DownlineTrunkReport {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly forestHandleUsd: number;
  readonly forestWagers: number;
  readonly forestBettors: number;
  readonly subAgentCount: number;
  readonly branches: readonly DownlineTrunkBranch[];
  readonly structuralFinding: string;
  readonly provenance: "batched_ranking" | "static_fixture";
}

const TRUNK_ROLE: Readonly<Record<DownlineTrunkId, string>> = {
  TRACKTHIS: "VIP / Syndicate Engine (high alert density)",
  NOLAPPH: "Retail PPH Downline (Recreational)",
  OTHER: "External / sibling master forests",
};

function classifyMaster(masterAgent: string): DownlineTrunkId {
  const key = masterAgent.trim().toUpperCase();
  if (key === "TRACKTHIS" || key.includes("TRACKTHIS")) {
    return "TRACKTHIS";
  }
  if (key === "NOLAPPH" || key.includes("NOLAPPH")) {
    return "NOLAPPH";
  }
  return "OTHER";
}

function accumulateAlertRates(
  players: readonly PlayerRankingRecord[],
): ReadonlyMap<string, { wagers: number; alertWagers: number }> {
  const map = new Map<string, { wagers: number; alertWagers: number }>();
  for (const p of players) {
    const master = p.masterAgent.trim().toUpperCase();
    const bucket = map.get(master) ?? { wagers: 0, alertWagers: 0 };
    bucket.wagers += p.totalWagers;
    bucket.alertWagers += p.totalWagers * (p.alertRatePct / 100);
    map.set(master, bucket);
  }
  return map;
}

export function buildDownlineTrunkReport(
  data: BatchedRankingResult,
): DownlineTrunkReport {
  const alertByMaster = accumulateAlertRates(data.topRankedPlayers);
  const branchAcc = new Map<
    DownlineTrunkId,
    {
      handleUsd: number;
      wagers: number;
      bettors: number;
      subAgents: Set<string>;
      alertWagers: number;
      alertDenom: number;
    }
  >();

  for (const id of ["TRACKTHIS", "NOLAPPH", "OTHER"] as const) {
    branchAcc.set(id, {
      handleUsd: 0,
      wagers: 0,
      bettors: 0,
      subAgents: new Set(),
      alertWagers: 0,
      alertDenom: 0,
    });
  }

  for (const sub of data.topSubAgents) {
    const trunk = classifyMaster(sub.masterAgent);
    const acc = branchAcc.get(trunk)!;
    acc.handleUsd += sub.totalHandleUsd;
    acc.wagers += sub.totalWagers;
    acc.bettors += sub.customerCount;
    acc.subAgents.add(sub.agentId);
    const alert = alertByMaster.get(sub.masterAgent.trim().toUpperCase());
    if (alert) {
      acc.alertWagers += alert.alertWagers;
      acc.alertDenom += alert.wagers;
    }
  }

  const branches: DownlineTrunkBranch[] = (
    ["TRACKTHIS", "NOLAPPH", "OTHER"] as const
  ).map((id) => {
    const acc = branchAcc.get(id)!;
    const alertRatePct =
      acc.alertDenom > 0 ? (acc.alertWagers / acc.alertDenom) * 100 : 0;
    return {
      id,
      label: id === "OTHER" ? "OTHER FORESTS" : id,
      handleUsd: acc.handleUsd,
      wagers: acc.wagers,
      bettors: acc.bettors,
      avgTicketUsd: acc.wagers > 0 ? acc.handleUsd / acc.wagers : 0,
      alertRatePct,
      subAgentCount: acc.subAgents.size,
      role: TRUNK_ROLE[id],
    };
  });

  const track = branches.find((b) => b.id === "TRACKTHIS");
  const nola = branches.find((b) => b.id === "NOLAPPH");
  const forestHandle = data.totalHandleUsd;
  const trackShare =
    track && forestHandle > 0 ? (track.handleUsd / forestHandle) * 100 : 0;
  const alertRatio =
    track && nola && nola.alertRatePct > 0
      ? track.alertRatePct / nola.alertRatePct
      : 0;
  const structuralFinding =
    track && nola
      ? `TRACKTHIS drives ${trackShare.toFixed(1)}% of desk handle with ${alertRatio >= 1 ? `${alertRatio.toFixed(1)}x` : "similar"} alert rate vs NOLAPPH retail trunk.`
      : "Trunk comparison from live 30d batched corpus (autoExecute: false).";

  return {
    windowStart: data.windowStart,
    windowEnd: data.windowEnd,
    forestHandleUsd: forestHandle,
    forestWagers: data.inWindowWagers,
    forestBettors: data.activeCustomerCount,
    subAgentCount: data.activeSubAgentCount,
    branches,
    structuralFinding,
    provenance: "batched_ranking",
  };
}

export function staticNolawolfTrunkFixture(): DownlineTrunkReport {
  return {
    windowStart: "2026-10-10",
    windowEnd: "2026-11-09",
    forestHandleUsd: 240_101_982.77,
    forestWagers: 628_599,
    forestBettors: 7_435,
    subAgentCount: 566,
    provenance: "static_fixture",
    structuralFinding:
      "TRACKTHIS generates 75.5% of desk volume with ~10x higher alert frequency vs NOLAPPH.",
    branches: [
      {
        id: "TRACKTHIS",
        label: "TRACKTHIS",
        handleUsd: 202_991_868.27,
        wagers: 258_927,
        bettors: 3_243,
        avgTicketUsd: 783.97,
        alertRatePct: 33.35,
        subAgentCount: 0,
        role: TRUNK_ROLE.TRACKTHIS,
      },
      {
        id: "NOLAPPH",
        label: "NOLAPPH",
        handleUsd: 37_450_599.89,
        wagers: 247_056,
        bettors: 4_198,
        avgTicketUsd: 151.59,
        alertRatePct: 3.26,
        subAgentCount: 0,
        role: TRUNK_ROLE.NOLAPPH,
      },
      {
        id: "OTHER",
        label: "OTHER FORESTS",
        handleUsd: 28_883_488.77,
        wagers: 122_616,
        bettors: 1_712,
        avgTicketUsd: 235.56,
        alertRatePct: 39.44,
        subAgentCount: 0,
        role: "CUB22A, DAN318, BIGDAD external trees",
      },
    ],
  };
}

export function formatDownlineTrunksAnsi(
  report: DownlineTrunkReport,
  options?: {
    readonly branchFilter?: DownlineTrunkId | undefined;
    readonly detail?: boolean | undefined;
    readonly linkAgent?: (agentId: string, label: string) => string;
  },
): string {
  const prov =
    report.provenance === "batched_ranking"
      ? "\x1b[32mLIVE CORPUS\x1b[0m"
      : "\x1b[33mSTATIC FIXTURE\x1b[0m";
  const rows = [
    `\x1b[1;36m🌲 NOLAWOLF MASTER FOREST: TWO-TRUNK TOPOLOGY COMPARISON (30-DAY WINDOW)\x1b[0m`,
    `\x1b[90mForest Total: $${report.forestHandleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} USD across ${report.subAgentCount.toLocaleString()} sub-agents and ${report.forestBettors.toLocaleString()} active bettors · ${prov}\x1b[0m`,
    `\x1b[90mWindow: ${report.windowStart} .. ${report.windowEnd}\x1b[0m`,
    "┌────────────────┬────────────────────┬──────────┬───────────┬──────────────┬────────────┬──────────┬────────────────────────────────────────┐",
    "│ Trunk Branch   │ 30d Handle (USD)   │ Wagers   │ Bettors   │ Avg Ticket   │ Alert Rate │ Sub-Agts │ Operating Role & Profile               │",
    "├────────────────┼────────────────────┼──────────┼───────────┼──────────────┼────────────┼──────────┼────────────────────────────────────────┤",
  ];

  const palette: Readonly<Record<DownlineTrunkId, string>> = {
    TRACKTHIS: "\x1b[1;33m",
    NOLAPPH: "\x1b[1;32m",
    OTHER: "\x1b[1;36m",
  };

  for (const branch of report.branches) {
    if (
      options?.branchFilter !== undefined &&
      options.branchFilter !== branch.id
    ) {
      continue;
    }
    const color = palette[branch.id];
    const alertColor =
      branch.alertRatePct >= 15
        ? "\x1b[1;31m"
        : branch.alertRatePct >= 8
          ? "\x1b[1;33m"
          : "\x1b[0m";
    const handle =
      branch.id === "TRACKTHIS"
        ? `\x1b[1m$${branch.handleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}\x1b[0m`
        : `$${branch.handleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`.padStart(
            18,
          );
    rows.push(
      `│ ${color}${padCell(branch.label, 14)}\x1b[0m │ ${typeof handle === "string" && handle.startsWith("\x1b") ? handle.padStart(28) : handle} │ ${padNum(branch.wagers, 8)} │ ${padNum(branch.bettors, 9)} │ ${padMoney(branch.avgTicketUsd, 12)} │ ${alertColor}${padPct(branch.alertRatePct, 10)}\x1b[0m │ ${padNum(branch.subAgentCount, 8)} │ ${padCell(branch.role, 38)} │`,
    );
  }

  rows.push(
    "└────────────────┴────────────────────┴──────────┴───────────┴──────────────┴────────────┴──────────┴────────────────────────────────────────┘",
    `\x1b[90mStructural Finding: ${report.structuralFinding}\x1b[0m`,
    `\x1b[90mDrill-down: trunks detail · Filter: trunks trackthis | trunks nolapph | trunks other · Pair with: bursts, conduits, rankings\x1b[0m`,
  );

  return rows.join("\n");
}

function padCell(text: string, width: number): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return clipped.padEnd(width);
}

function padNum(n: number, width: number): string {
  return n.toLocaleString().padStart(width);
}

function padMoney(n: number, width: number): string {
  return `$${n.toFixed(2)}`.padStart(width);
}

function padPct(n: number, width: number): string {
  return `${n.toFixed(2)}%`.padStart(width);
}

export function buildDownlineTrunkDetailRows(
  data: BatchedRankingResult,
  trunk: DownlineTrunkId,
  linkAgent?: (agentId: string, label: string) => string,
): string[] {
  const rows = data.topSubAgents
    .filter((s) => classifyMaster(s.masterAgent) === trunk)
    .sort((a, b) => b.totalHandleUsd - a.totalHandleUsd)
    .slice(0, 8);
  if (rows.length === 0) {
    return [
      `\x1b[90mNo sub-agents in corpus for trunk ${trunk} (run rankings after F402 ingest).\x1b[0m`,
    ];
  }
  const out = [
    `\x1b[1;35m🌿 ${trunk} SUB-AGENT TRUNK (top ${rows.length} by handle)\x1b[0m`,
    "┌──────────────┬──────────────┬──────────────┬───────────┬──────────────┬──────────────────┐",
    "│ Sub-Agent    │ Master       │ 30d Handle   │ Wagers    │ Bettors      │ Conduit          │",
    "├──────────────┼──────────────┼──────────────┼───────────┼──────────────┼──────────────────┤",
  ];
  for (const s of rows) {
    const sa = linkAgent
      ? linkAgent(s.agentId, padCell(s.agentId, 12))
      : padCell(s.agentId, 12);
    out.push(
      `│ \x1b[1m${sa}\x1b[0m │ ${padCell(s.masterAgent, 12)} │ $${s.totalHandleUsd.toLocaleString().padStart(12)} │ ${padNum(s.totalWagers, 9)} │ ${padNum(s.customerCount, 12)} │ ${s.isProxyConduit ? "\x1b[31mPROXY\x1b[0m" : "\x1b[32mok\x1b[0m".padStart(16)} │`,
    );
  }
  out.push(
    "└──────────────┴──────────────┴──────────────┴───────────┴──────────────┴──────────────────┘",
  );
  return out;
}

export function parseTrunksCliArgs(args: readonly string[]): {
  readonly detail: boolean;
  readonly branchFilter: DownlineTrunkId | undefined;
  readonly json: boolean;
} {
  const tokens = args
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a !== "");
  let branchFilter: DownlineTrunkId | undefined;
  for (const t of tokens) {
    if (t === "detail" || t === "--detail") {
      continue;
    }
    if (t === "json" || t === "--json") {
      continue;
    }
    if (t.includes("track")) {
      branchFilter = "TRACKTHIS";
    } else if (t.includes("nola") || t.includes("pph")) {
      branchFilter = "NOLAPPH";
    } else if (t === "other" || t === "forests") {
      branchFilter = "OTHER";
    }
  }
  return {
    detail: tokens.some((t) => t === "detail" || t === "--detail"),
    branchFilter,
    json: tokens.some((t) => t === "json" || t === "--json"),
  };
}
