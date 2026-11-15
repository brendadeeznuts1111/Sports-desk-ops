/**
 * Evidence-scored account linker. Every edge is a guess, never a confirmed identity.
 */

import { classifyIp } from "./f402_weblog.ts";
import {
  F402AnalyzeError,
  groupWagersByTicket,
  type AnalyzedAccount,
  type PullProjection,
  type WagerRow,
  type WeblogRow,
} from "./f402_analyze_ingest.ts";
import {
  resolvedLinkThresholds,
  type AnalyzeConfig,
  type LinkEvidenceTypeName,
  type LinkThresholdName,
} from "./f402_analyze_config.ts";

export const LINK_DISCLAIMER =
  "Links are evidence-scored guesses, not confirmed identities.";

export const SHARED_IP_WINDOW_MS = 2 * 60 * 60_000;
export const DEVICE_WINDOW_MS = 15 * 60_000;
export const TRANSFER_WINDOW_MS = 2 * 60 * 60_000;
export const CASH_MATCH_WINDOW_MS = 24 * 60 * 60_000;
export const EDGE_SCORE_MIN = 0.2;
export const PARLAY_WINDOW_MS = 60 * 60_000;
export const STEAM_WINDOW_MS = 5 * 60_000;
export const PARLAY_JACCARD_MIN = 0.8;

export const GENERIC_ENTERED_BY = new Set([
  "",
  "system",
  "internet",
  "ggl-livedealer",
]);

export const SHARED_INFRA_CLASSES = new Set([
  "CGNAT",
  "T_MOBILE",
  "VERIZON_192",
  "VERIZON_208",
  "ICLOUD_RELAY",
  "BOT_RING_140_248",
  "IPV6_CARRIER:T_MOBILE",
  "IPV6_CARRIER:VERIZON",
  "IPV6_CARRIER:ATT",
  "IPV6_CARRIER:ICLOUD",
]);

export type EvidenceType =
  | "shared_ip"
  | "same_device_timing"
  | "transfer"
  | "same_entered_by"
  | "matching_deposit_withdrawal"
  | "shared_parlay_legs"
  | "stake_fingerprint"
  | "steam_chase"
  | "sport_market_mix"
  | "clv_beat"
  | "middling_arb"
  | "login_then_bet";

export interface EvidenceItem {
  readonly type: EvidenceType;
  readonly score: number;
  readonly detail: string;
  readonly atIso: string | null;
  readonly ipHash?: string;
  readonly amountCents?: number;
}

export interface AccountEdge {
  readonly a: string;
  readonly b: string;
  readonly score: number;
  readonly label: "evidence-scored guess";
  readonly evidence: readonly EvidenceItem[];
}

export interface AccountCluster {
  readonly id: string;
  readonly accounts: readonly string[];
  readonly score: number;
  readonly label: "evidence-scored guess";
  readonly edges: readonly AccountEdge[];
}

export interface WeblogBetLink {
  readonly loginId: string;
  readonly ticket: string;
  readonly ipHash: string;
  readonly accessDateTime: string;
  readonly actionKind: string;
  readonly risk: number | null;
  readonly win: number | null;
}

export interface LinkReport {
  readonly disclaimer: typeof LINK_DISCLAIMER;
  readonly accountCount: number;
  readonly edgeCount: number;
  readonly clusterCount: number;
  readonly edges: readonly AccountEdge[];
  readonly clusters: readonly AccountCluster[];
  readonly weblogBetLinks: readonly WeblogBetLink[];
  readonly thresholds: {
    readonly minEdgeScore: number;
    readonly sharedIpWindowMs: number;
    readonly deviceWindowMs: number;
    readonly transferWindowMs: number;
    readonly cashMatchWindowMs: number;
  };
}

export type IpHasher = (ip: string) => string;

export interface LinkOptions {
  readonly hashIp: IpHasher;
  readonly config?: AnalyzeConfig;
  readonly minEdgeScore?: number;
}

export type LinkThresholds = { readonly [K in LinkThresholdName]: number };

function thresholdsFrom(options: LinkOptions): LinkThresholds {
  const resolved = resolvedLinkThresholds(options.config);
  if (options.minEdgeScore !== undefined) {
    return { ...resolved, minEdgeScore: options.minEdgeScore };
  }
  return resolved;
}

function evidenceWeight(
  type: EvidenceType,
  config: AnalyzeConfig | undefined,
): number {
  return config?.weights.link[type as LinkEvidenceTypeName] ?? 1;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function combineEvidenceScores(scores: readonly number[]): number {
  let remain = 1;
  for (const score of scores) remain *= 1 - clamp01(score);
  return clamp01(1 - remain);
}

export function ipRarity(accountsOnIp: number, totalAccounts: number): number {
  if (accountsOnIp <= 1 || totalAccounts <= 1) return 0;
  if (accountsOnIp >= totalAccounts) return 0;
  return clamp01(
    Math.log2(totalAccounts / accountsOnIp) / Math.log2(totalAccounts),
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function endpoints(a: string, b: string): { a: string; b: string } {
  return a < b ? { a, b } : { a: b, b: a };
}

function isoOf(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function timeDecay(dtMs: number, windowMs: number): number {
  if (!Number.isFinite(dtMs) || dtMs < 0 || dtMs > windowMs) return 0;
  return 0.7 + 0.3 * (1 - dtMs / windowMs);
}

function overlapOrProximity(
  aTimes: readonly number[],
  bTimes: readonly number[],
  windowMs: number,
): { hit: boolean; nearestMs: number; overlap: boolean } {
  const a = aTimes
    .filter(Number.isFinite)
    .slice()
    .sort((x, y) => x - y);
  const b = bTimes
    .filter(Number.isFinite)
    .slice()
    .sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) {
    return { hit: false, nearestMs: Number.POSITIVE_INFINITY, overlap: false };
  }
  const aMin = a[0]!;
  const aMax = a[a.length - 1]!;
  const bMin = b[0]!;
  const bMax = b[b.length - 1]!;
  const overlap = aMin <= bMax && bMin <= aMax;
  let nearest = Number.POSITIVE_INFINITY;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const dt = Math.abs(a[i]! - b[j]!);
    if (dt < nearest) nearest = dt;
    if (a[i]! < b[j]!) i += 1;
    else j += 1;
  }
  return { hit: overlap || nearest <= windowMs, nearestMs: nearest, overlap };
}

function resolveAccountId(
  loginOrId: string,
  accounts: readonly AnalyzedAccount[],
): string | null {
  const key = loginOrId.trim().toLowerCase();
  if (key === "") return null;
  for (const account of accounts) {
    if (
      account.accountId.toLowerCase() === key ||
      account.login.toLowerCase() === key
    ) {
      return account.accountId;
    }
  }
  return loginOrId.trim();
}

const GENERIC_DEVICE = "UNKNOWN||";

function deviceFingerprint(row: WeblogRow): string | null {
  const version = row.clientVersion ?? "";
  const skin = row.skinDomain ?? "";
  if (row.deviceClass === "UNKNOWN" && version === "") return null;
  return `${row.deviceClass}|${version}|${skin}`;
}

function addEvidence(
  bag: Map<string, EvidenceItem[]>,
  a: string,
  b: string,
  item: EvidenceItem,
): void {
  if (a === b || item.score < 0.05) return;
  const key = pairKey(a, b);
  const list = bag.get(key) ?? [];
  list.push(item);
  bag.set(key, list);
}

function collectSharedIp(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  hashIp: IpHasher,
  th: LinkThresholds,
): void {
  const byIp = new Map<string, Map<string, number[]>>();
  for (const row of projection.weblog) {
    if (row.ipAddress === "") continue;
    const accountId = resolveAccountId(row.loginId, projection.accounts);
    if (accountId === null) continue;
    let accounts = byIp.get(row.ipAddress);
    if (accounts === undefined) {
      accounts = new Map();
      byIp.set(row.ipAddress, accounts);
    }
    const times = accounts.get(accountId) ?? [];
    times.push(row.accessMs);
    accounts.set(accountId, times);
  }
  const total = Math.max(projection.accounts.length, 1);
  for (const [ip, accounts] of byIp) {
    const ids = [...accounts.keys()];
    if (ids.length < 2) continue;
    const rarity = ipRarity(ids.length, total);
    const infra = SHARED_INFRA_CLASSES.has(classifyIp(ip));
    const infraPenalty = infra ? 0.25 : 1;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        const prox = overlapOrProximity(
          accounts.get(a) ?? [],
          accounts.get(b) ?? [],
          th.sharedIpWindowMs,
        );
        const overlapFactor = prox.overlap ? 1 : prox.hit ? 0.6 : 0.15;
        const score = clamp01(0.85 * rarity * overlapFactor * infraPenalty);
        const hashed = hashIp(ip);
        addEvidence(bag, a, b, {
          type: "shared_ip",
          score,
          detail: prox.overlap
            ? `shared IP ${hashed} with overlapping activity (rarity ${rarity.toFixed(2)}${infra ? ", shared infrastructure" : ""})`
            : `shared IP ${hashed} (rarity ${rarity.toFixed(2)}, nearest ${Math.round(prox.nearestMs / 60000)}m)`,
          atIso: isoOf(
            Number.isFinite(prox.nearestMs) ? Date.now() : Number.NaN,
          )
            ? isoOf(
                Math.min(
                  ...(accounts.get(a) ?? []),
                  ...(accounts.get(b) ?? []),
                ),
              )
            : null,
          ipHash: hashed,
        });
      }
    }
  }
}

function collectDeviceTiming(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const events: { accountId: string; ms: number; fp: string }[] = [];
  const fpCounts = new Map<string, Set<string>>();
  for (const row of projection.weblog) {
    const fp = deviceFingerprint(row);
    if (fp === null || fp === GENERIC_DEVICE) continue;
    const accountId = resolveAccountId(row.loginId, projection.accounts);
    if (accountId === null || !Number.isFinite(row.accessMs)) continue;
    events.push({ accountId, ms: row.accessMs, fp });
    const set = fpCounts.get(fp) ?? new Set();
    set.add(accountId);
    fpCounts.set(fp, set);
  }
  events.sort((a, b) => a.ms - b.ms);
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i += 1) {
    const left = events[i]!;
    for (let j = i + 1; j < events.length; j += 1) {
      const right = events[j]!;
      const dt = right.ms - left.ms;
      if (dt > th.deviceWindowMs) break;
      if (right.fp !== left.fp || right.accountId === left.accountId) continue;
      const key = `${pairKey(left.accountId, right.accountId)}\u0000${left.fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const users = fpCounts.get(left.fp)?.size ?? 2;
      const rarity = ipRarity(users, Math.max(projection.accounts.length, 2));
      const score = clamp01(
        0.55 * Math.max(rarity, 0.25) * timeDecay(dt, th.deviceWindowMs),
      );
      addEvidence(bag, left.accountId, right.accountId, {
        type: "same_device_timing",
        score,
        detail: `same device fingerprint within ${Math.round(dt / 60000)}m`,
        atIso: isoOf(left.ms),
      });
    }
  }
}

interface CashEvent {
  readonly accountId: string;
  readonly ms: number;
  readonly amountCents: number;
  readonly documentNumber: number;
}

function greedyPairs(
  left: readonly CashEvent[],
  right: readonly CashEvent[],
  windowMs: number,
  onMatch: (a: CashEvent, b: CashEvent, dt: number) => void,
): void {
  const candidates: { i: number; j: number; dt: number }[] = [];
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      const a = left[i]!;
      const b = right[j]!;
      if (a.accountId === b.accountId) continue;
      if (a.amountCents !== b.amountCents) continue;
      if (!Number.isFinite(a.ms) || !Number.isFinite(b.ms)) continue;
      const dt = Math.abs(a.ms - b.ms);
      if (dt > windowMs) continue;
      candidates.push({ i, j, dt });
    }
  }
  candidates.sort((x, y) => x.dt - y.dt);
  const usedL = new Set<number>();
  const usedR = new Set<number>();
  for (const cand of candidates) {
    if (usedL.has(cand.i) || usedR.has(cand.j)) continue;
    usedL.add(cand.i);
    usedR.add(cand.j);
    onMatch(left[cand.i]!, right[cand.j]!, cand.dt);
  }
}

function collectTransfers(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const credits: CashEvent[] = [];
  const debits: CashEvent[] = [];
  for (const row of projection.ledger) {
    if (row.tranType !== "T" && row.tranType !== "U") continue;
    const event: CashEvent = {
      accountId: row.accountId,
      ms: row.tranMs,
      amountCents: row.amountCents,
      documentNumber: row.documentNumber,
    };
    if (row.tranType === "T") credits.push(event);
    else debits.push(event);
  }
  greedyPairs(debits, credits, th.transferWindowMs, (debit, credit, dt) => {
    addEvidence(bag, debit.accountId, credit.accountId, {
      type: "transfer",
      score: clamp01(0.95 * timeDecay(dt, th.transferWindowMs)),
      detail: `T/U pair of ${debit.amountCents} cents ${Math.round(dt / 60000)}m apart`,
      atIso: isoOf(Math.min(debit.ms, credit.ms)),
      amountCents: debit.amountCents,
    });
  });
}

function collectCashMatches(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const deposits: CashEvent[] = [];
  const withdrawals: CashEvent[] = [];
  for (const row of projection.ledger) {
    if (row.tranType !== "E" && row.tranType !== "I") continue;
    const event: CashEvent = {
      accountId: row.accountId,
      ms: row.tranMs,
      amountCents: row.amountCents,
      documentNumber: row.documentNumber,
    };
    if (row.tranType === "E") deposits.push(event);
    else withdrawals.push(event);
  }
  greedyPairs(deposits, withdrawals, th.cashMatchWindowMs, (dep, wd, dt) => {
    addEvidence(bag, dep.accountId, wd.accountId, {
      type: "matching_deposit_withdrawal",
      score: clamp01(0.7 * timeDecay(dt, th.cashMatchWindowMs)),
      detail: `deposit and withdrawal of ${dep.amountCents} cents ${Math.round(dt / 60000)}m apart`,
      atIso: isoOf(Math.min(dep.ms, wd.ms)),
      amountCents: dep.amountCents,
    });
  });
}

function collectEnteredBy(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
): void {
  const byClerk = new Map<string, Map<string, number>>();
  for (const row of projection.ledger) {
    if (row.family !== "adjustment") continue;
    const clerk = row.enteredBy.trim().toLowerCase();
    if (GENERIC_ENTERED_BY.has(clerk)) continue;
    let accounts = byClerk.get(clerk);
    if (accounts === undefined) {
      accounts = new Map();
      byClerk.set(clerk, accounts);
    }
    accounts.set(row.accountId, (accounts.get(row.accountId) ?? 0) + 1);
  }
  const total = Math.max(projection.accounts.length, 1);
  for (const [clerk, accounts] of byClerk) {
    const ids = [...accounts.keys()];
    if (ids.length < 2) continue;
    const rarity = ipRarity(ids.length, total);
    const score = clamp01(0.4 * rarity);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        addEvidence(bag, ids[i]!, ids[j]!, {
          type: "same_entered_by",
          score,
          detail: `same EnteredBy on adjustments (${accounts.get(ids[i]!)! + accounts.get(ids[j]!)!} rows, rarity ${rarity.toFixed(2)})`,
          atIso: null,
        });
      }
    }
    void clerk;
  }
}

function ticketLegSet(rows: readonly WagerRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const leg of row.legs) {
      if (leg.lineKey !== "|||other|") keys.add(leg.lineKey);
    }
  }
  return keys;
}

export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const key of a) if (b.has(key)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function collectSharedParlay(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const tickets = [...groupWagersByTicket(projection.wagers).entries()]
    .map(([ticket, rows]) => {
      const legs = ticketLegSet(rows);
      const first = rows[0]!;
      return {
        ticket,
        accountId: first.accountId,
        ms: first.acceptedMs,
        type: first.wagerType,
        legs,
      };
    })
    .filter((row) => row.legs.size >= 2 && Number.isFinite(row.ms));
  const signatureCounts = new Map<string, number>();
  const sigOf = (legs: Set<string>): string => [...legs].sort().join("\u0001");
  for (const row of tickets) {
    const sig = sigOf(row.legs);
    signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
  }
  const total = Math.max(projection.accounts.length, 2);
  for (let i = 0; i < tickets.length; i += 1) {
    const left = tickets[i]!;
    for (let j = i + 1; j < tickets.length; j += 1) {
      const right = tickets[j]!;
      if (left.accountId === right.accountId) continue;
      const dt = Math.abs(left.ms - right.ms);
      if (dt > th.parlayWindowMs) continue;
      const jac = jaccard(left.legs, right.legs);
      if (jac < th.parlayJaccardMin) continue;
      const sig = sigOf(left.legs);
      const rarity = ipRarity(signatureCounts.get(sig) ?? 2, total);
      const score = clamp01(
        0.9 * jac * Math.max(rarity, 0.3) * timeDecay(dt, th.parlayWindowMs),
      );
      addEvidence(bag, left.accountId, right.accountId, {
        type: "shared_parlay_legs",
        score,
        detail: `${jac === 1 ? "identical" : "near-same"} ${left.legs.size}-leg set within ${Math.round(dt / 60000)}m (rarity ${rarity.toFixed(2)})`,
        atIso: isoOf(Math.min(left.ms, right.ms)),
      });
    }
  }
}

function stakeBucket(amount: number): string {
  const abs = Math.abs(amount);
  const dollars = abs >= 1000 ? abs / 100 : abs;
  if (dollars >= 10000) return "10k+";
  if (dollars >= 2500) return "2.5k+";
  if (dollars >= 1000) return "1k+";
  if (dollars >= 500) return "500+";
  if (dollars >= 200) return "200+";
  if (dollars >= 100) return "100+";
  if (dollars >= 50) return "50+";
  return "<50";
}

function isRoundStake(amount: number): boolean {
  const abs = Math.abs(Math.trunc(amount));
  const cents = abs >= 1000 || abs % 100 === 0 ? abs : Math.round(abs * 100);
  return cents % 10000 === 0 || cents % 5000 === 0;
}

function collectStakeFingerprint(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
): void {
  const byAccount = new Map<string, WagerRow[]>();
  for (const row of projection.wagers) {
    if (row.amountWagered === 0) continue;
    const list = byAccount.get(row.accountId) ?? [];
    list.push(row);
    byAccount.set(row.accountId, list);
  }
  const profiles = [...byAccount.entries()]
    .filter(([, rows]) => rows.length >= 3)
    .map(([accountId, rows]) => {
      const buckets = new Map<string, number>();
      let round = 0;
      for (const row of rows) {
        const bucket = stakeBucket(row.amountWagered);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        if (isRoundStake(row.amountWagered)) round += 1;
      }
      return {
        accountId,
        buckets,
        roundRate: round / rows.length,
        n: rows.length,
      };
    });
  const total = Math.max(projection.accounts.length, 2);
  for (let i = 0; i < profiles.length; i += 1) {
    const left = profiles[i]!;
    for (let j = i + 1; j < profiles.length; j += 1) {
      const right = profiles[j]!;
      const keys = new Set([...left.buckets.keys(), ...right.buckets.keys()]);
      let dot = 0;
      let nL = 0;
      let nR = 0;
      for (const key of keys) {
        const a = (left.buckets.get(key) ?? 0) / left.n;
        const b = (right.buckets.get(key) ?? 0) / right.n;
        dot += a * b;
        nL += a * a;
        nR += b * b;
      }
      const cosine = nL > 0 && nR > 0 ? dot / Math.sqrt(nL * nR) : 0;
      const roundClose = 1 - Math.abs(left.roundRate - right.roundRate);
      if (cosine < 0.85 || roundClose < 0.7) continue;
      const preferred =
        [...left.buckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const sharing = profiles.filter(
        (p) => (p.buckets.get(preferred) ?? 0) / p.n >= 0.4,
      ).length;
      const rarity = ipRarity(Math.max(sharing, 2), total);
      const score = clamp01(0.55 * cosine * roundClose * Math.max(rarity, 0.2));
      addEvidence(bag, left.accountId, right.accountId, {
        type: "stake_fingerprint",
        score,
        detail: `similar stake mix (cosine ${cosine.toFixed(2)}, round-rate Δ ${Math.abs(left.roundRate - right.roundRate).toFixed(2)})`,
        atIso: null,
      });
    }
  }
}

function collectSteam(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const byLine = new Map<string, WagerRow[]>();
  for (const row of projection.wagers) {
    const key = row.legs[0]?.lineKey ?? "";
    if (key === "" || key === "|||other|") continue;
    const list = byLine.get(key) ?? [];
    list.push(row);
    byLine.set(key, list);
  }
  const total = Math.max(projection.accounts.length, 2);
  for (const [lineKey, rows] of byLine) {
    const sorted = rows
      .filter((row) => Number.isFinite(row.acceptedMs))
      .slice()
      .sort((a, b) => a.acceptedMs - b.acceptedMs);
    if (sorted.length < 2) continue;
    const accounts = new Set(sorted.map((row) => row.accountId));
    if (accounts.size < 2) continue;
    for (let i = 0; i < sorted.length; i += 1) {
      const start = sorted[i]!;
      const window: WagerRow[] = [start];
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (sorted[j]!.acceptedMs - start.acceptedMs > th.steamWindowMs) break;
        window.push(sorted[j]!);
      }
      const ids = [...new Set(window.map((row) => row.accountId))];
      if (ids.length < 2) continue;
      const moved =
        window.some(
          (row) =>
            row.origLine !== null &&
            row.adjLine !== null &&
            row.origLine !== row.adjLine,
        ) ||
        window.some(
          (row, idx, arr) =>
            idx > 0 &&
            row.adjLine !== null &&
            arr[0]!.adjLine !== null &&
            row.adjLine !== arr[0]!.adjLine,
        );
      if (ids.length < 3 && !moved) continue;
      const rarity = ipRarity(ids.length, total);
      const burst = timeDecay(
        window[window.length - 1]!.acceptedMs - start.acceptedMs,
        th.steamWindowMs,
      );
      const score = clamp01(
        (moved ? 0.9 : 0.7) * Math.max(rarity, 0.35) * burst,
      );
      for (let a = 0; a < ids.length; a += 1) {
        for (let b = a + 1; b < ids.length; b += 1) {
          addEvidence(bag, ids[a]!, ids[b]!, {
            type: "steam_chase",
            score,
            detail: `${ids.length} accounts hit ${lineKey} within ${Math.round((window[window.length - 1]!.acceptedMs - start.acceptedMs) / 60000)}m${moved ? " after a line move" : ""}`,
            atIso: isoOf(start.acceptedMs),
          });
        }
      }
    }
  }
}

function collectSportMarketMix(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
): void {
  const byAccount = new Map<string, Map<string, number>>();
  for (const row of projection.wagers) {
    const mix = `${row.sport}|${row.market}|${row.period}`.toLowerCase();
    if (mix === "||") continue;
    let counts = byAccount.get(row.accountId);
    if (counts === undefined) {
      counts = new Map();
      byAccount.set(row.accountId, counts);
    }
    counts.set(mix, (counts.get(mix) ?? 0) + 1);
  }
  const profiles = [...byAccount.entries()]
    .map(([accountId, counts]) => {
      const n = [...counts.values()].reduce((s, v) => s + v, 0);
      return { accountId, counts, n };
    })
    .filter((row) => row.n >= 5);
  const total = Math.max(projection.accounts.length, 2);
  for (let i = 0; i < profiles.length; i += 1) {
    const left = profiles[i]!;
    for (let j = i + 1; j < profiles.length; j += 1) {
      const right = profiles[j]!;
      const keys = new Set([...left.counts.keys(), ...right.counts.keys()]);
      let dot = 0;
      let nL = 0;
      let nR = 0;
      for (const key of keys) {
        const a = (left.counts.get(key) ?? 0) / left.n;
        const b = (right.counts.get(key) ?? 0) / right.n;
        dot += a * b;
        nL += a * a;
        nR += b * b;
      }
      const cosine = nL > 0 && nR > 0 ? dot / Math.sqrt(nL * nR) : 0;
      if (cosine < 0.85) continue;
      const preferred =
        [...left.counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const sharing = profiles.filter(
        (p) => (p.counts.get(preferred) ?? 0) / p.n >= 0.3,
      ).length;
      const rarity = ipRarity(Math.max(sharing, 2), total);
      const score = clamp01(0.45 * cosine * Math.max(rarity, 0.2));
      addEvidence(bag, left.accountId, right.accountId, {
        type: "sport_market_mix",
        score,
        detail: `similar sport/market mix (cosine ${cosine.toFixed(2)}, rarity ${rarity.toFixed(2)})`,
        atIso: null,
      });
    }
  }
}

function numericLine(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Bettor beat the adjusted/close line when orig vs adj is present. */
export function beatClosingLine(wager: WagerRow): boolean | null {
  const orig = numericLine(wager.origLine);
  const adj = numericLine(wager.adjLine);
  if (orig === null || adj === null || orig === adj) return null;
  const market = wager.market;
  const leg = wager.legs[0];
  if (market === "total") {
    const token = (leg?.line ?? "").toUpperCase();
    const ou = token.startsWith("U") ? "U" : "O";
    return ou === "O" ? orig < adj : orig > adj;
  }
  // Spread or money: a more favorable number for the bettor is algebraically larger
  // (e.g. orig -3 vs adj -3.5, or orig +150 vs adj +130).
  return orig > adj;
}

function collectClvBeat(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const byAccount = new Map<string, WagerRow[]>();
  for (const row of projection.wagers) {
    if (beatClosingLine(row) !== true) continue;
    if (row.accountId === "") continue;
    const list = byAccount.get(row.accountId) ?? [];
    list.push(row);
    byAccount.set(row.accountId, list);
  }
  const ids = [...byAccount.keys()].sort();
  const minShared = Math.max(1, Math.trunc(th.clvMinSharedEvents));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = ids[i]!;
      const right = ids[j]!;
      const leftKeys = new Set(
        (byAccount.get(left) ?? []).map(
          (row) => row.legs[0]?.eventKey ?? row.sport,
        ),
      );
      const shared = (byAccount.get(right) ?? []).filter((row) =>
        leftKeys.has(row.legs[0]?.eventKey ?? row.sport),
      );
      if (shared.length < minShared) continue;
      const rarity = 1 / Math.max(shared.length + 1, 2);
      const score = clamp01(
        0.55 + 0.15 * Math.min(shared.length, 4) * Math.max(rarity, 0.2),
      );
      addEvidence(bag, left, right, {
        type: "clv_beat",
        score,
        detail: `both beat the close on ${shared.length} shared event(s)`,
        atIso: isoOf(shared[0]!.acceptedMs),
      });
    }
  }
}

function impliedMoneyProb(line: number): number | null {
  if (!Number.isFinite(line) || line === 0) return null;
  if (line < 0) return -line / (-line + 100);
  return 100 / (line + 100);
}

function collectMiddlingArb(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const byEvent = new Map<string, WagerRow[]>();
  for (const row of projection.wagers) {
    const key = row.legs[0]?.eventKey ?? "";
    if (key === "") continue;
    const list = byEvent.get(key) ?? [];
    list.push(row);
    byEvent.set(key, list);
  }
  const windowMs = th.middleWindowMs;
  for (const [eventKey, rows] of byEvent) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (a.accountId === b.accountId) continue;
        const dt = Math.abs(a.acceptedMs - b.acceptedMs);
        if (!Number.isFinite(dt) || dt > windowMs) continue;
        const aLeg = a.legs[0];
        const bLeg = b.legs[0];
        if (aLeg === undefined || bLeg === undefined) continue;
        let kind: "middle" | "arb" | null = null;
        if (a.market === "spread" && b.market === "spread") {
          if (aLeg.chosen === bLeg.chosen && aLeg.chosen !== "") continue;
          const la = numericLine(aLeg.line || a.origLine);
          const lb = numericLine(bLeg.line || b.origLine);
          if (la === null || lb === null) continue;
          const opposite =
            aLeg.chosen !== "" &&
            bLeg.chosen !== "" &&
            aLeg.chosen.toLowerCase() !== bLeg.chosen.toLowerCase();
          if (opposite && la + lb > 0) kind = "middle";
        } else if (a.market === "money" && b.market === "money") {
          if (
            aLeg.chosen !== "" &&
            bLeg.chosen !== "" &&
            aLeg.chosen.toLowerCase() === bLeg.chosen.toLowerCase()
          ) {
            continue;
          }
          const pa = impliedMoneyProb(
            numericLine(aLeg.line || a.origLine) ?? Number.NaN,
          );
          const pb = impliedMoneyProb(
            numericLine(bLeg.line || b.origLine) ?? Number.NaN,
          );
          if (pa !== null && pb !== null && pa + pb < 1) kind = "arb";
        } else if (a.market === "total" && b.market === "total") {
          const aOu = aLeg.line.toUpperCase().startsWith("U") ? "U" : "O";
          const bOu = bLeg.line.toUpperCase().startsWith("U") ? "U" : "O";
          if (aOu === bOu) continue;
          const la = numericLine(a.origLine ?? aLeg.line.split(":")[1] ?? null);
          const lb = numericLine(b.origLine ?? bLeg.line.split(":")[1] ?? null);
          if (la !== null && lb !== null && la !== lb) kind = "middle";
        }
        if (kind === null) continue;
        const score = clamp01(
          (kind === "middle" ? 0.85 : 0.8) * timeDecay(dt, windowMs),
        );
        addEvidence(bag, a.accountId, b.accountId, {
          type: "middling_arb",
          score,
          detail: `${kind} on ${eventKey} ${Math.round(dt / 60000)}m apart`,
          atIso: isoOf(Math.min(a.acceptedMs, b.acceptedMs)),
        });
      }
    }
  }
}

function latencyBucket(ms: number): string {
  if (ms < 10_000) return "0-10s";
  if (ms < 30_000) return "10-30s";
  if (ms < 60_000) return "30-60s";
  if (ms < 5 * 60_000) return "1-5m";
  if (ms < 15 * 60_000) return "5-15m";
  if (ms < 60 * 60_000) return "15-60m";
  return "60m+";
}

function collectLoginThenBet(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
  th: LinkThresholds,
): void {
  const loginsByAccount = new Map<string, number[]>();
  for (const row of projection.weblog) {
    if (row.actionKind !== "login" && row.actionKind !== "token") continue;
    const accountId = resolveAccountId(row.loginId, projection.accounts);
    if (accountId === null || accountId === "") continue;
    const list = loginsByAccount.get(accountId) ?? [];
    list.push(row.accessMs);
    loginsByAccount.set(accountId, list);
  }
  for (const list of loginsByAccount.values()) list.sort((a, b) => a - b);

  const counts = new Map<string, Record<string, number>>();
  const pairCounts = new Map<string, number>();
  for (const wager of projection.wagers) {
    if (!Number.isFinite(wager.acceptedMs) || wager.accountId === "") continue;
    const times = loginsByAccount.get(wager.accountId);
    if (times === undefined) continue;
    let loginMs: number | null = null;
    for (let i = times.length - 1; i >= 0; i -= 1) {
      const candidate = times[i]!;
      const dt = wager.acceptedMs - candidate;
      if (dt < 0) continue;
      if (dt > th.loginBetWindowMs) break;
      loginMs = candidate;
      break;
    }
    if (loginMs === null) continue;
    const dt = wager.acceptedMs - loginMs;
    const bucket = latencyBucket(dt);
    const bags = counts.get(wager.accountId) ?? {};
    bags[bucket] = (bags[bucket] ?? 0) + 1;
    counts.set(wager.accountId, bags);
    pairCounts.set(wager.accountId, (pairCounts.get(wager.accountId) ?? 0) + 1);
  }

  const minPairs = Math.max(1, Math.trunc(th.loginBetMinPairs));
  const ids = [...counts.keys()]
    .filter((id) => (pairCounts.get(id) ?? 0) >= minPairs)
    .sort();
  const buckets = [
    "0-10s",
    "10-30s",
    "30-60s",
    "1-5m",
    "5-15m",
    "15-60m",
    "60m+",
  ];
  const cosine = (
    a: Record<string, number>,
    b: Record<string, number>,
  ): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const key of buckets) {
      const x = a[key] ?? 0;
      const y = b[key] ?? 0;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
  };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = ids[i]!;
      const right = ids[j]!;
      const sim = cosine(counts.get(left)!, counts.get(right)!);
      if (sim < 0.85) continue;
      const rarity = ipRarity(2, Math.max(projection.accounts.length, 2));
      const score = clamp01(0.35 * sim * Math.max(rarity, 0.3));
      addEvidence(bag, left, right, {
        type: "login_then_bet",
        score,
        detail: `similar login-to-bet latency (cosine ${sim.toFixed(2)}, n=${pairCounts.get(left)}/${pairCounts.get(right)})`,
        atIso: null,
      });
    }
  }
}

function applyEvidenceWeights(
  bag: Map<string, EvidenceItem[]>,
  config: AnalyzeConfig | undefined,
): Map<string, EvidenceItem[]> {
  if (config === undefined) return bag;
  const out = new Map<string, EvidenceItem[]>();
  for (const [key, evidence] of bag) {
    out.set(
      key,
      evidence.map((item) => ({
        ...item,
        score: clamp01(item.score * evidenceWeight(item.type, config)),
      })),
    );
  }
  return out;
}

function buildEdges(
  bag: Map<string, EvidenceItem[]>,
  minEdgeScore: number = EDGE_SCORE_MIN,
): AccountEdge[] {
  const edges: AccountEdge[] = [];
  for (const [key, evidence] of bag) {
    const [left, right] = key.split("\u0000") as [string, string];
    const score = combineEvidenceScores(evidence.map((item) => item.score));
    if (score < minEdgeScore) continue;
    const ends = endpoints(left, right);
    edges.push({
      a: ends.a,
      b: ends.b,
      score: Number(score.toFixed(4)),
      label: "evidence-scored guess",
      evidence: evidence
        .slice()
        .sort((x, y) => y.score - x.score)
        .map((item) => ({ ...item, score: Number(item.score.toFixed(4)) })),
    });
  }
  edges.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));
  return edges;
}

function clustersFromEdges(edges: readonly AccountEdge[]): AccountCluster[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const cur = parent.get(id) ?? id;
    if (cur !== id) {
      const root = find(cur);
      parent.set(id, root);
      return root;
    }
    parent.set(id, cur);
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const edge of edges) union(edge.a, edge.b);
  const groups = new Map<string, AccountEdge[]>();
  for (const edge of edges) {
    const root = find(edge.a);
    const list = groups.get(root) ?? [];
    list.push(edge);
    groups.set(root, list);
  }
  const clusters: AccountCluster[] = [];
  let n = 1;
  for (const groupEdges of groups.values()) {
    const accounts = [
      ...new Set(groupEdges.flatMap((edge) => [edge.a, edge.b])),
    ].sort();
    const score = groupEdges.reduce(
      (max, edge) => Math.max(max, edge.score),
      0,
    );
    clusters.push({
      id: `cluster-${n}`,
      accounts,
      score: Number(score.toFixed(4)),
      label: "evidence-scored guess",
      edges: groupEdges,
    });
    n += 1;
  }
  clusters.sort(
    (a, b) => b.score - a.score || a.accounts[0]!.localeCompare(b.accounts[0]!),
  );
  return clusters.map((cluster, index) => ({
    ...cluster,
    id: `cluster-${index + 1}`,
  }));
}

export function linkAccounts(
  projection: PullProjection,
  options: LinkOptions,
): LinkReport {
  if (
    projection.accounts.length === 0 &&
    projection.ledger.length === 0 &&
    projection.weblog.length === 0
  ) {
    throw new F402AnalyzeError(
      "empty",
      "link",
      "no accounts, ledger rows, or weblog rows to link",
    );
  }
  const bag = new Map<string, EvidenceItem[]>();
  const th = thresholdsFrom(options);
  collectSharedIp(projection, bag, options.hashIp, th);
  collectDeviceTiming(projection, bag, th);
  collectTransfers(projection, bag, th);
  collectCashMatches(projection, bag, th);
  collectEnteredBy(projection, bag);
  collectSharedParlay(projection, bag, th);
  collectStakeFingerprint(projection, bag);
  collectSteam(projection, bag, th);
  collectSportMarketMix(projection, bag);
  collectClvBeat(projection, bag, th);
  collectMiddlingArb(projection, bag, th);
  collectLoginThenBet(projection, bag, th);
  const weighted = applyEvidenceWeights(bag, options.config);
  const minEdgeScore = th.minEdgeScore;
  const edges = buildEdges(weighted, minEdgeScore);
  const clusters = clustersFromEdges(edges);
  const weblogBetLinks: WeblogBetLink[] = [];
  for (const row of projection.weblog) {
    if (row.ticket === null || row.ticket === "") continue;
    weblogBetLinks.push({
      loginId: row.loginId,
      ticket: row.ticket,
      ipHash: row.ipAddress === "" ? "" : options.hashIp(row.ipAddress),
      accessDateTime: row.accessDateTime,
      actionKind: row.actionKind,
      risk: row.risk,
      win: row.win,
    });
  }
  return {
    disclaimer: LINK_DISCLAIMER,
    accountCount: projection.accounts.length,
    edgeCount: edges.length,
    clusterCount: clusters.length,
    edges,
    clusters,
    weblogBetLinks,
    thresholds: {
      minEdgeScore,
      sharedIpWindowMs: th.sharedIpWindowMs,
      deviceWindowMs: th.deviceWindowMs,
      transferWindowMs: th.transferWindowMs,
      cashMatchWindowMs: th.cashMatchWindowMs,
    },
  };
}
