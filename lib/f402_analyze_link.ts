/**
 * Evidence-scored account linker. Every edge is a guess, never a confirmed identity.
 */

import { classifyIp } from "./f402_weblog.ts";
import {
  F402AnalyzeError,
  type AnalyzedAccount,
  type PullProjection,
  type WeblogRow,
} from "./f402_analyze_ingest.ts";

export const LINK_DISCLAIMER =
  "Links are evidence-scored guesses, not confirmed identities.";

export const SHARED_IP_WINDOW_MS = 2 * 60 * 60_000;
export const DEVICE_WINDOW_MS = 15 * 60_000;
export const TRANSFER_WINDOW_MS = 2 * 60 * 60_000;
export const CASH_MATCH_WINDOW_MS = 24 * 60 * 60_000;
export const EDGE_SCORE_MIN = 0.2;

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
  | "matching_deposit_withdrawal";

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
          SHARED_IP_WINDOW_MS,
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
      if (dt > DEVICE_WINDOW_MS) break;
      if (right.fp !== left.fp || right.accountId === left.accountId) continue;
      const key = `${pairKey(left.accountId, right.accountId)}\u0000${left.fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const users = fpCounts.get(left.fp)?.size ?? 2;
      const rarity = ipRarity(users, Math.max(projection.accounts.length, 2));
      const score = clamp01(
        0.55 * Math.max(rarity, 0.25) * timeDecay(dt, DEVICE_WINDOW_MS),
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
  greedyPairs(debits, credits, TRANSFER_WINDOW_MS, (debit, credit, dt) => {
    addEvidence(bag, debit.accountId, credit.accountId, {
      type: "transfer",
      score: clamp01(0.95 * timeDecay(dt, TRANSFER_WINDOW_MS)),
      detail: `T/U pair of ${debit.amountCents} cents ${Math.round(dt / 60000)}m apart`,
      atIso: isoOf(Math.min(debit.ms, credit.ms)),
      amountCents: debit.amountCents,
    });
  });
}

function collectCashMatches(
  projection: PullProjection,
  bag: Map<string, EvidenceItem[]>,
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
  greedyPairs(deposits, withdrawals, CASH_MATCH_WINDOW_MS, (dep, wd, dt) => {
    addEvidence(bag, dep.accountId, wd.accountId, {
      type: "matching_deposit_withdrawal",
      score: clamp01(0.7 * timeDecay(dt, CASH_MATCH_WINDOW_MS)),
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

function buildEdges(bag: Map<string, EvidenceItem[]>): AccountEdge[] {
  const edges: AccountEdge[] = [];
  for (const [key, evidence] of bag) {
    const [left, right] = key.split("\u0000") as [string, string];
    const score = combineEvidenceScores(evidence.map((item) => item.score));
    if (score < EDGE_SCORE_MIN) continue;
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
  options: { readonly hashIp: IpHasher },
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
  collectSharedIp(projection, bag, options.hashIp);
  collectDeviceTiming(projection, bag);
  collectTransfers(projection, bag);
  collectCashMatches(projection, bag);
  collectEnteredBy(projection, bag);
  const edges = buildEdges(bag);
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
      minEdgeScore: EDGE_SCORE_MIN,
      sharedIpWindowMs: SHARED_IP_WINDOW_MS,
      deviceWindowMs: DEVICE_WINDOW_MS,
      transferWindowMs: TRANSFER_WINDOW_MS,
      cashMatchWindowMs: CASH_MATCH_WINDOW_MS,
    },
  };
}
