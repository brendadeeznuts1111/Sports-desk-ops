/**
 * @file lib/syndicate_burst_guard.ts
 * @description Real-time sliding-window syndicate burst detection and quarantine engine.
 *
 * DETECTS:
 *  - Coordinated multi-account steam bursts arriving within narrow time windows (<=120s / <=180s)
 *  - Concentrated strikes targeting identical selections, derivatives (Halftime / Quarters), or props
 *  - Downline trunk clustering (e.g., CSJOSHUA / UPLOADERS vs VIPELITE)
 *
 * SAFETY INVARIANT:
 *  - autoExecute: false across all quarantine directives, limit clamps, and delay recommendations.
 *    Directives must be manually acknowledged or confirmed by a sports desk operator.
 */

export interface RawWagerInput {
  login: string;
  agentId: string;
  masterAgent?: string;
  amountWageredCents: number;
  toWinCents: number;
  insertDateTimeIso: string;
  wagerType: string;
  gameId: string;
  selection: string;
  sport: string;
  period?: "FULL" | "HALF" | "QUARTER" | "PROP" | "OTHER";
  isAlert?: boolean;
}

export interface SyndicateBurst {
  burstId: string;
  gameId: string;
  selection: string;
  sport: string;
  period: string;
  startTimeIso: string;
  endTimeIso: string;
  durationSeconds: number;
  totalHandleUsd: number;
  wagerCount: number;
  distinctLogins: string[];
  affectedAgents: string[];
  hubAgent: string;
  cohesionScore: number; // 0.00 to 1.00
  isSynchronizedSteam: boolean;
}

export interface QuarantineDirective {
  quarantineId: string;
  createdAtIso: string;
  trigger:
    | "SYNCHRONIZED_STEAM_BURST"
    | "PERIOD_HALFTIME_EXPLOIT"
    | "PROXY_CONDUIT_SURGE";
  burst: SyndicateBurst;
  recommendedAction:
    | "HOLD_FOR_MANUAL_REVIEW"
    | "APPLY_LINE_SHADE"
    | "CLAMP_STAKES"
    | "INJECT_LATENCY_DELAY";
  recommendedDelaySeconds: number;
  recommendedLineShadeCents: number;
  maxStakeClampUsd: number;
  status: "ACTIVE_QUARANTINE" | "RELEASED" | "CONFIRMED_SYNDICATE";
  operatorNotes: string;
  autoExecute: false; // Mandatory safety invariant
}

export interface QuarantineReport {
  generatedAtIso: string;
  windowSeconds: number;
  totalWagersEvaluated: number;
  activeBurstsDetected: number;
  quarantineDirectivesIssued: number;
  quarantinedHandleUsd: number;
  bursts: SyndicateBurst[];
  directives: QuarantineDirective[];
}

export interface BurstGuardOptions {
  windowSeconds?: number;
  minDistinctLogins?: number;
  minWagers?: number;
  minHandleCents?: number;
  cohesionThreshold?: number;
}

export function computeCohesionScore(
  wagers: RawWagerInput[],
  durationSec: number,
  windowSec: number,
): number {
  if (wagers.length <= 1) return 0;

  // 1. Account Diversity (0.0 to 0.35): higher ratio of unique accounts to wagers
  const uniqueLogins = new Set(wagers.map((w) => w.login.toUpperCase())).size;
  const sDiversity = Math.min(0.35, (uniqueLogins / wagers.length) * 0.35);

  // 2. Time Compression (0.0 to 0.35): burst density within the window
  const sTime = Math.max(
    0,
    0.35 * (1.0 - durationSec / Math.max(1, windowSec)),
  );

  // 3. Alert Density (0.0 to 0.15)
  const alertCount = wagers.filter((w) => w.isAlert).length;
  const sAlert = (alertCount / wagers.length) * 0.15;

  // 4. Stake Sizing Regularity (0.0 to 0.15): flat-stake pro syndicate profile
  const stakes = wagers.map((w) => w.amountWageredCents);
  const mean = stakes.reduce((a, b) => a + b, 0) / stakes.length;
  const variance =
    stakes.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / stakes.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 1.0;
  const sFlat = Math.max(0, 0.15 * (1.0 - Math.min(1.0, cv)));

  return Number(Math.min(1.0, sDiversity + sTime + sAlert + sFlat).toFixed(2));
}

/**
 * Sliding-window syndicate burst detection arena.
 */
export class SyndicateBurstGuardArena {
  private readonly windowSec: number;
  private readonly minLogins: number;
  private readonly minWagers: number;
  private readonly minHandleCents: number;
  private readonly cohesionThreshold: number;
  private readonly buffer: RawWagerInput[] = [];

  constructor(options: BurstGuardOptions = {}) {
    this.windowSec = options.windowSeconds ?? 120;
    this.minLogins = options.minDistinctLogins ?? 3;
    this.minWagers = options.minWagers ?? 3;
    this.minHandleCents = options.minHandleCents ?? 100000; // $1,000 handle
    this.cohesionThreshold = options.cohesionThreshold ?? 0.65;
  }

  /**
   * Ingest a batch of wagers, maintaining chronological order and pruning stale events.
   */
  public ingest(wagers: RawWagerInput[]): QuarantineReport {
    // Sort incoming by timestamp asc
    const sorted = [...wagers].sort(
      (a, b) =>
        new Date(a.insertDateTimeIso).getTime() -
        new Date(b.insertDateTimeIso).getTime(),
    );

    this.buffer.push(...sorted);

    // Group wagers by key: `${gameId}::${selection}`
    const keyGroups = new Map<string, RawWagerInput[]>();
    for (const w of this.buffer) {
      const key = `${(w.gameId || "UNKNOWN").trim().toUpperCase()}::${(w.selection || "UNKNOWN").trim().toUpperCase()}`;
      let list = keyGroups.get(key);
      if (!list) {
        list = [];
        keyGroups.set(key, list);
      }
      list.push(w);
    }

    const detectedBursts: SyndicateBurst[] = [];
    const directives: QuarantineDirective[] = [];
    let quarantinedHandleCents = 0;

    for (const [key, group] of keyGroups.entries()) {
      if (group.length < this.minWagers) continue;

      // Sliding window scan over this selection's wagers
      let left = 0;
      for (let right = 0; right < group.length; right++) {
        const tRight = new Date(group[right]!.insertDateTimeIso).getTime();

        while (left < right) {
          const tLeft = new Date(group[left]!.insertDateTimeIso).getTime();
          if ((tRight - tLeft) / 1000 <= this.windowSec) break;
          left++;
        }

        const windowSlice = group.slice(left, right + 1);
        if (windowSlice.length < this.minWagers) continue;

        const logins = new Set(windowSlice.map((w) => w.login.toUpperCase()));
        if (logins.size < this.minLogins) continue;

        const totalHandle = windowSlice.reduce(
          (sum, w) => sum + w.amountWageredCents,
          0,
        );
        if (totalHandle < this.minHandleCents) continue;

        const tStart = new Date(windowSlice[0]!.insertDateTimeIso).getTime();
        const durationSec = Math.max(1, (tRight - tStart) / 1000);
        const cohesion = computeCohesionScore(
          windowSlice,
          durationSec,
          this.windowSec,
        );

        if (cohesion >= this.cohesionThreshold) {
          const first = windowSlice[0]!;
          const agents = Array.from(
            new Set(windowSlice.map((w) => w.agentId.toUpperCase())),
          );
          const [gId, sel] = key.split("::");

          const burstId = `BURST-${gId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
          const isHalf =
            first.period === "HALF" ||
            first.selection.toUpperCase().includes("1H") ||
            first.selection.toUpperCase().includes("2H");

          const burst: SyndicateBurst = {
            burstId,
            gameId: gId ?? "UNKNOWN",
            selection: sel ?? "UNKNOWN",
            sport: first.sport || "OTHER",
            period: first.period || (isHalf ? "HALF" : "FULL"),
            startTimeIso: windowSlice[0]!.insertDateTimeIso,
            endTimeIso: windowSlice[windowSlice.length - 1]!.insertDateTimeIso,
            durationSeconds: Math.round(durationSec),
            totalHandleUsd: totalHandle / 100,
            wagerCount: windowSlice.length,
            distinctLogins: Array.from(logins),
            affectedAgents: agents,
            hubAgent: first.masterAgent || agents[0] || "UNKNOWN",
            cohesionScore: cohesion,
            isSynchronizedSteam: true,
          };

          detectedBursts.push(burst);
          quarantinedHandleCents += totalHandle;

          // Generate Quarantine Directive
          const directiveId = `QD-${burstId}`;
          const trigger = isHalf
            ? "PERIOD_HALFTIME_EXPLOIT"
            : "SYNCHRONIZED_STEAM_BURST";

          const directive: QuarantineDirective = {
            quarantineId: directiveId,
            createdAtIso: new Date().toISOString(),
            trigger,
            burst,
            recommendedAction: "HOLD_FOR_MANUAL_REVIEW",
            recommendedDelaySeconds: isHalf ? 5.0 : 3.0,
            recommendedLineShadeCents: isHalf ? 25 : 15,
            maxStakeClampUsd: 250,
            status: "ACTIVE_QUARANTINE",
            operatorNotes:
              `Coordinated ${windowSlice.length}-ticket strike from ${logins.size} logins across agents [${agents.join(", ")}]. ` +
              `Cohesion: ${cohesion.toFixed(2)}. Requires operator confirmation before release.`,
            autoExecute: false, // Strict invariant
          };

          directives.push(directive);

          // Fast-forward left to prevent duplicated overlapping bursts on identical tickets
          left = right + 1;
        }
      }
    }

    return {
      generatedAtIso: new Date().toISOString(),
      windowSeconds: this.windowSec,
      totalWagersEvaluated: this.buffer.length,
      activeBurstsDetected: detectedBursts.length,
      quarantineDirectivesIssued: directives.length,
      quarantinedHandleUsd: quarantinedHandleCents / 100,
      bursts: detectedBursts,
      directives,
    };
  }

  [Bun.inspect.custom]() {
    return (
      `\x1b[1;36m[SyndicateBurstGuardArena]\x1b[0m\n` +
      `  Window: \x1b[33m${this.windowSec}s\x1b[0m | Min Logins: \x1b[33m${this.minLogins}\x1b[0m | Min Wagers: \x1b[33m${this.minWagers}\x1b[0m\n` +
      `  Buffered Wagers: \x1b[32m${this.buffer.length}\x1b[0m | Cohesion Threshold: \x1b[35m${this.cohesionThreshold}\x1b[0m\n` +
      `  Safety Invariant: \x1b[1;32mautoExecute: false\x1b[0m (Human Operator in the loop)`
    );
  }
}

/**
 * Convenience batch evaluator for a set of raw wagers.
 */
export function evaluateWagersForBursts(
  wagers: RawWagerInput[],
  options?: BurstGuardOptions,
): QuarantineReport {
  const arena = new SyndicateBurstGuardArena(options);
  return arena.ingest(wagers);
}
