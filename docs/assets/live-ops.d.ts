/**
 * Types for `docs/live-ops.js` (the /graph Live Wagers & Our Positions helpers).
 *
 * The module is plain browser JS shipped as-is, so this declaration file is the contract
 * the TS tests and the typechecker see. Keep it structural: unknown feed fields stay
 * `unknown` and every accessor is defensive on the runtime side.
 */

export interface WalletProfileRow {
  rank?: number | null;
  proxyWallet?: string | null;
  shortWallet?: string | null;
  f402CustomerId?: string | null;
  agentOwner?: string | null;
  openLegsCount?: number | string | null;
  openVolumeUsd?: number | string | null;
  positionsValueUsd?: number | string | null;
  openPnlUsd?: number | string | null;
  openBetsSummary?: string | null;
  dataSource?: string | null;
  lastSyncedIso?: string | null;
  fetchedAtIso?: string | null;
  walletAddressValid?: boolean | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface PositionRow {
  rank: number;
  proxyWallet: string;
  shortWallet: string;
  customerId: string;
  agentOwner: string;
  legs: number;
  costUsd: number;
  valueUsd: number;
  pnlUsd: number;
  source: string;
  syncedIso: string;
  summary: string;
  error: string;
}

export interface PositionsSummary {
  walletCount: number;
  trackedCount: number;
  liveCount: number;
  staleCount: number;
  fixtureCount: number;
  invalidCount: number;
  openLegs: number;
  openCostUsd: number;
  openValueUsd: number;
  openPnlUsd: number;
  latestSyncIso: string | null;
  rows: PositionRow[];
}

export interface PendingBetRow {
  ticketId?: string | null;
  sourceVenue?: string | null;
  f402CustomerId?: string | null;
  agentOwner?: string | null;
  canonicalMarket?: string | null;
  sportAndPeriod?: string | null;
  riskUsd?: number | string | null;
  toWinUsd?: number | string | null;
  deskVerdict?: string | null;
  placedAtUtc?: string | null;
  lastSyncedUtc?: string | null;
  [key: string]: unknown;
}

export interface PendingBetRowSummary {
  ticketId: string;
  venue: string;
  customerId: string;
  agentOwner: string;
  market: string;
  sportAndPeriod: string;
  riskUsd: number;
  toWinUsd: number;
  verdict: string;
  placedAtUtc: string;
  syncedIso: string;
}

export interface PendingBetsSummary {
  clusterCount: number;
  riskUsd: number;
  toWinUsd: number;
  exposureUsd: number;
  venues: Array<{ venue: string; count: number; riskUsd: number }>;
  rows: PendingBetRowSummary[];
}

export interface LiveTapeRow {
  id: string;
  atIso: string;
  source: string;
  label: string;
  login: string;
  agent: string;
  ticket: string;
  summary: string;
  kind: "tick" | "frame";
}

export interface LiveMode {
  label: string;
  tone: string;
  detail: string;
}

export const LIVE_WS_TOPICS: readonly string[];
export const BRIDGE_LABELS: Record<string, string>;

export function summarizePositions(
  walletProfiles?: readonly WalletProfileRow[] | null,
): PositionsSummary;

export function summarizePendingBets(
  pendingBets?: readonly PendingBetRow[] | null,
): PendingBetsSummary;

export function normalizeTickerRow(
  tick: unknown,
  fallbackSeq?: number,
): LiveTapeRow | null;

export function summarizeBridgeFrame(
  frame: unknown,
  receivedAtIso?: string,
): LiveTapeRow | null;

export function mergeTape(
  rows?: readonly LiveTapeRow[] | null,
  incoming?: readonly (LiveTapeRow | null)[] | null,
  limit?: number,
): LiveTapeRow[];

export function formatAgeMs(ms?: number | null): string;

export function resolveLiveMode(input?: {
  wsState?: string;
  feedAgeMs?: number | null;
  feedDataMode?: string | null;
}): LiveMode;

export function isObservedSource(source: string): boolean;
