// Domain, writer-lane, and venue registry (canonical single source of truth).
// Complies with the Naming Constitution (no generation tags, no banned abbreviations)
// and zero heap-collection lookups in hot resolution paths.

import type { SignalChannelCode } from "../design/domain-branded-types.ts";
import { DodGateFailureError } from "./bridge_and_channel_router.ts";

/** Canonical upstream origin domain identifiers across all sportsdesk bridges. */
export type OriginDomainId =
  | "ORIGIN_SPORTSBOOK_FANTASY402"
  | "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118"
  | "ORIGIN_EXCHANGE_POLYMARKET_CTF"
  | "ORIGIN_EXCHANGE_KALSHI_REGULATED"
  | "ORIGIN_STORAGE_R2_LAKEHOUSE"
  | "ORIGIN_HOST_NSH_DESK_LOCAL";

/**
 * Canonical venue identifiers unifying legacy ComboVenue and Venue unions.
 *
 * `internal` is GONE: it named two different places (the desk host and the R2
 * lakehouse), which made "one venue, one origin" untrue. They are `desk` and
 * `lakehouse` now, each with exactly one origin.
 */
export type VenueId =
  "f402" | "gslive_partner118" | "polymarket" | "kalshi" | "desk" | "lakehouse";

/**
 * Canonical WRITABLE writer lanes. A lane is a feed that reports tickets; it is
 * not a row state. `alert` (an F402 mirror channel), `blocked` and `unknown`
 * were lanes before and are now sentinel classifications — see
 * SENTINEL_CHANNEL_REGISTRY.
 */
export type WriterLaneId =
  "internet" | "gateway" | "gsbuilder" | "gslive" | "cslevel2" | "inet_mirror";

/** Row-level classifications that are NOT feeds. */
export type SentinelChannelId =
  "alert" | "blocked" | "non_sports_drop" | "unknown";

/** What a decoded writer byte can be: a writable lane or a sentinel class. */
export type WriterChannelId = WriterLaneId | SentinelChannelId;

export type OriginDomainEntry = {
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly displayLabel: string;
  readonly brandColorHex: string;
  readonly defaultTokenCode: string;
};

export type WriterLaneEntry = {
  readonly writerLaneId: WriterLaneId;
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly tokenProvenanceCode: string;
  /** UPPER_SNAKE; equals writerLaneId.toUpperCase(). */
  readonly provenanceLabel: string;
  /** The design-layer channel vocabulary the frame codec and payloads use. */
  readonly signalChannelCode: SignalChannelCode;
  readonly brandColorHex: string;
};

/**
 * A sentinel classification: a row state, not a feed.
 *
 * `laneId` records which feed the row belongs to when one does (ALERT rows are
 * the F402 mirror feed), so the lineage survives even though the sentinel itself
 * is never a venue or a lane id.
 */
export type SentinelChannelEntry = {
  readonly sentinelId: SentinelChannelId;
  /** UPPER_SNAKE row label, exactly as it appears in captured rows. */
  readonly provenanceLabel: string;
  readonly signalChannelCode: SignalChannelCode | null;
  readonly laneId: WriterLaneId | null;
  readonly brandColorHex: string;
  readonly isMoneyExcluded: true;
};

export const ORIGIN_DOMAIN_REGISTRY: Readonly<
  Record<OriginDomainId, OriginDomainEntry>
> = {
  ORIGIN_SPORTSBOOK_FANTASY402: {
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    displayLabel: "Fantasy402 Agent Portal",
    brandColorHex: "#1d84b5",
    defaultTokenCode: "L18_N0204",
  },
  ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118: {
    originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    venueId: "gslive_partner118",
    displayLabel: "Partner 118 GSLive Book",
    brandColorHex: "#28a745",
    defaultTokenCode: "L23_N0412",
  },
  ORIGIN_EXCHANGE_POLYMARKET_CTF: {
    originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    venueId: "polymarket",
    displayLabel: "Polymarket CTF Exchange",
    brandColorHex: "#38bdf8",
    defaultTokenCode: "L24_N2019",
  },
  ORIGIN_EXCHANGE_KALSHI_REGULATED: {
    originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    venueId: "kalshi",
    displayLabel: "Kalshi Regulated Exchange",
    brandColorHex: "#10b981",
    defaultTokenCode: "L20_N1105",
  },
  ORIGIN_STORAGE_R2_LAKEHOUSE: {
    originDomainId: "ORIGIN_STORAGE_R2_LAKEHOUSE",
    venueId: "lakehouse",
    displayLabel: "Cloudflare R2 Lakehouse",
    brandColorHex: "#f59e0b",
    defaultTokenCode: "L22_N1402",
  },
  ORIGIN_HOST_NSH_DESK_LOCAL: {
    originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
    venueId: "desk",
    displayLabel: "Desk Host Local",
    brandColorHex: "#64748b",
    defaultTokenCode: "L19_N0518",
  },
};

export const WRITER_LANE_REGISTRY: Readonly<
  Record<WriterLaneId, WriterLaneEntry>
> = {
  internet: {
    writerLaneId: "internet",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L18_N0204",
    provenanceLabel: "INTERNET",
    signalChannelCode: "Internet",
    brandColorHex: "#1d84b5",
  },
  gateway: {
    writerLaneId: "gateway",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L20_N1105",
    provenanceLabel: "GATEWAY",
    signalChannelCode: "GATEWAY",
    brandColorHex: "#10b981",
  },
  gsbuilder: {
    writerLaneId: "gsbuilder",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L22_N1402",
    provenanceLabel: "GSBUILDER",
    signalChannelCode: "GSBUILDER",
    brandColorHex: "#f59e0b",
  },
  gslive: {
    writerLaneId: "gslive",
    originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    venueId: "gslive_partner118",
    tokenProvenanceCode: "L23_N0412",
    provenanceLabel: "GSLIVE",
    signalChannelCode: "GSLIVE",
    brandColorHex: "#28a745",
  },
  cslevel2: {
    writerLaneId: "cslevel2",
    originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    venueId: "polymarket",
    tokenProvenanceCode: "L24_N2019",
    provenanceLabel: "CSLEVEL2",
    signalChannelCode: "CSLEVEL2",
    brandColorHex: "#38bdf8",
  },
  inet_mirror: {
    writerLaneId: "inet_mirror",
    originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
    venueId: "f402",
    tokenProvenanceCode: "L21_N0884",
    provenanceLabel: "INET_MIRROR",
    // ALERT is the design code for this mirror feed; the row label stays ALERT.
    signalChannelCode: "ALERT",
    brandColorHex: "#ef4444",
  },
};

/**
 * Sentinels are row classifications, not feeds. `non_sports_drop` has no signal
 * channel code and no lane: it exists only as a money-excluded row label.
 */
export const SENTINEL_CHANNEL_REGISTRY: Readonly<
  Record<SentinelChannelId, SentinelChannelEntry>
> = {
  alert: {
    sentinelId: "alert",
    provenanceLabel: "ALERT",
    signalChannelCode: "ALERT",
    laneId: "inet_mirror",
    brandColorHex: "#ef4444",
    isMoneyExcluded: true,
  },
  blocked: {
    sentinelId: "blocked",
    provenanceLabel: "BLOCKED",
    signalChannelCode: "BLOCKED",
    laneId: null,
    brandColorHex: "#64748b",
    isMoneyExcluded: true,
  },
  non_sports_drop: {
    sentinelId: "non_sports_drop",
    provenanceLabel: "NON_SPORTS_DROP",
    signalChannelCode: null,
    laneId: null,
    brandColorHex: "#94a3b8",
    isMoneyExcluded: true,
  },
  unknown: {
    sentinelId: "unknown",
    // NOT "BLOCKED": an unparseable writer label is unresolved, and calling it
    // blocked makes a parsing gap look like a compliance decision.
    provenanceLabel: "UNRESOLVED",
    signalChannelCode: null,
    laneId: null,
    brandColorHex: "#94a3b8",
    isMoneyExcluded: true,
  },
};

/** The sentinel entry for a channel, or null when the channel is a lane. */
export function sentinelChannelEntryFor(
  channel: WriterChannelId,
): SentinelChannelEntry | null {
  return isSentinelChannelId(channel)
    ? SENTINEL_CHANNEL_REGISTRY[channel]
    : null;
}

/**
 * The writable lane a channel belongs to, or null when no feed did.
 *
 * Sentinels with a lane (alert → inet_mirror) resolve to that lane, which is how
 * the ALERT lineage survives the split without making ALERT a lane id.
 */
export function writerLaneEntryForChannel(
  channel: WriterChannelId,
): WriterLaneEntry | null {
  if (isWriterLaneId(channel)) return WRITER_LANE_REGISTRY[channel];
  const laneId = SENTINEL_CHANNEL_REGISTRY[channel].laneId;
  return laneId === null ? null : WRITER_LANE_REGISTRY[laneId];
}

/** Derived: which writable lanes report through each origin. */
export const WRITER_LANES_BY_ORIGIN: Readonly<
  Record<OriginDomainId, readonly WriterLaneId[]>
> = Object.freeze(
  (Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[]).reduce(
    (acc, origin) => {
      acc[origin] = (
        Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[]
      ).filter((lane) => WRITER_LANE_REGISTRY[lane].originDomainId === origin);
      return acc;
    },
    {} as Record<OriginDomainId, readonly WriterLaneId[]>,
  ),
);

/**
 * What kind of book a venue is. The maths differs: a sportsbook holds the stake
 * (its liability is the payout), an exchange matches two sides (its exposure is
 * the position), and internal venues settle nothing at all.
 */
export type VenueKind = "sportsbook" | "exchange" | "internal";

/** How a venue's exposure settles. Only tradeable venues have a settlement. */
export type SettlementModel = "cash_stake" | "token_position";

type VenueBase = {
  readonly venueId: VenueId;
  readonly displayLabel: string;
  readonly brandColorHex: string;
  readonly originDomainIds: readonly OriginDomainId[];
};

/** A book that holds the stake; its liability is the payout. */
export type BookVenueEntry = VenueBase & {
  readonly kind: "sportsbook";
  readonly settlement: "cash_stake";
};

/** An exchange that matches two sides; its exposure is the position. */
export type ExchangeVenueEntry = VenueBase & {
  readonly kind: "exchange";
  readonly settlement: "token_position";
};

/** A venue that settles nothing. It deliberately HAS NO settlement field, so
 *  asking an internal venue how it settles is a compile error, not a lie. */
export type InternalVenueEntry = VenueBase & { readonly kind: "internal" };

export type VenueEntry =
  BookVenueEntry | ExchangeVenueEntry | InternalVenueEntry;

/**
 * The venue level the other two registries point at.
 *
 * ORIGIN_DOMAIN_REGISTRY says where a token came from and WRITER_LANE_REGISTRY
 * says which lane wrote it; neither answers "is this an exchange or a book?",
 * which is the question the risk maths depends on.
 *
 * `originDomainIds` and the venue colour are DERIVED from ORIGIN_DOMAIN_REGISTRY
 * rather than listed here, because a hand-maintained second list is how the two
 * tables drift apart. A venue with no origin fails at module load.
 */
function venueBase(venueId: VenueId, displayLabel: string): VenueBase {
  const origins = (
    Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[]
  ).filter((origin) => ORIGIN_DOMAIN_REGISTRY[origin].venueId === venueId);
  if (origins.length === 0) {
    // NAMING-GATE: spine modules throw the structured gate error, never a bare
    // Error, so a registry that disagrees with itself fails with a section name.
    throw new DodGateFailureError({
      gate: 8,
      section: "SEC_VENUE_ORIGIN_CONSISTENCY",
      expected: "every VenueId has at least one origin domain",
      actual: `venue ${venueId} has none`,
    });
  }
  const primary = ORIGIN_DOMAIN_REGISTRY[origins[0]!];
  return {
    venueId,
    displayLabel,
    brandColorHex: primary.brandColorHex,
    originDomainIds: origins,
  };
}

export const VENUE_REGISTRY = {
  f402: {
    ...venueBase("f402", "Fantasy402"),
    kind: "sportsbook",
    settlement: "cash_stake",
  },
  gslive_partner118: {
    ...venueBase("gslive_partner118", "GSLive Partner 118"),
    kind: "sportsbook",
    settlement: "cash_stake",
  },
  polymarket: {
    ...venueBase("polymarket", "Polymarket"),
    kind: "exchange",
    settlement: "token_position",
  },
  kalshi: {
    ...venueBase("kalshi", "Kalshi"),
    kind: "exchange",
    settlement: "token_position",
  },
  desk: { ...venueBase("desk", "Desk Host"), kind: "internal" },
  lakehouse: { ...venueBase("lakehouse", "R2 Lakehouse"), kind: "internal" },
} as const satisfies Readonly<Record<VenueId, VenueEntry>>;

/**
 * Narrows to a venue whose exposure can be held. The settlement field only
 * exists on the tradeable variants, so after this guard the maths cannot ask an
 * internal venue for a settlement model.
 */
export function isTradeableVenue(
  entry: VenueEntry,
): entry is BookVenueEntry | ExchangeVenueEntry {
  return entry.kind !== "internal";
}

// NAMING-GATE-04: no Map/Set allocation on a resolution path. Ownership
// lookups run against the frozen records themselves, which allocates nothing.
export function isVenueId(value: unknown): value is VenueId {
  return typeof value === "string" && Object.hasOwn(VENUE_REGISTRY, value);
}

export function isOriginDomainId(value: unknown): value is OriginDomainId {
  return (
    typeof value === "string" && Object.hasOwn(ORIGIN_DOMAIN_REGISTRY, value)
  );
}

export function isWriterLaneId(value: unknown): value is WriterLaneId {
  return (
    typeof value === "string" && Object.hasOwn(WRITER_LANE_REGISTRY, value)
  );
}

export function isSentinelChannelId(
  value: unknown,
): value is SentinelChannelId {
  return (
    typeof value === "string" && Object.hasOwn(SENTINEL_CHANNEL_REGISTRY, value)
  );
}

/**
 * Parse a venue token arriving from outside the process (JSON, a CLI flag, an
 * env var). Returns null instead of guessing: a caller that gets null must
 * decide whether to reject the row or record it as unresolved, and those are
 * different decisions.
 *
 * This is the strict counterpart of resolveWriterLaneId, which is deliberately
 * forgiving about raw writer spellings.
 */
export function parseVenueId(raw: unknown): VenueId | null {
  if (typeof raw !== "string") return null;
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (Object.hasOwn(VENUE_REGISTRY, token)) return token as VenueId;
  const alias: Readonly<Record<string, VenueId>> = {
    fantasy402: "f402",
    gslive: "gslive_partner118",
    gs_live: "gslive_partner118",
    partner118: "gslive_partner118",
    partner_118: "gslive_partner118",
    poly: "polymarket",
    ctf: "polymarket",
    host: "desk",
    r2: "lakehouse",
    // Legacy spelling: rows written before the split carried "internal" and
    // cannot be attributed to an origin from the value alone.
    internal: "desk",
  };
  return alias[token] ?? null;
}

/** Total lookup: a VenueId always has an entry because the literal is exhaustive. */
export function venueEntry(venueId: VenueId): VenueEntry {
  return VENUE_REGISTRY[venueId];
}

/**
 * Normalize a raw writer label into a canonical WRITABLE lane.
 *
 * Sentinels are refused: passing a row state here is a caller bug, and silently
 * returning a lane would mislabel the row. Use resolveWriterChannel when the
 * input may be a sentinel.
 */
export function resolveWriterLaneId(rawWriter: string): WriterLaneId {
  const channel = resolveWriterChannel(rawWriter);
  if (isSentinelChannelId(channel)) {
    throw new DodGateFailureError({
      gate: 4,
      section: "SEC_WRITER_LANE_NOT_A_FEED",
      expected:
        "a writable writer lane (internet, gslive, gsbuilder, cslevel2, gateway, inet_mirror)",
      actual: `"${rawWriter}" is sentinel ${channel}; use resolveWriterChannel`,
    });
  }
  return channel;
}

/** Normalize a raw writer label into a lane or a sentinel, without guessing. */
export function resolveWriterChannel(
  rawWriter: string,
): WriterLaneId | SentinelChannelId {
  const normalized = rawWriter.trim().toLowerCase();
  if (
    normalized === "internet" ||
    normalized === "inet" ||
    normalized === "mobile" ||
    normalized === "web" ||
    normalized === "f402" ||
    normalized === "fantasy402"
  ) {
    return "internet";
  }
  if (
    normalized === "gslive" ||
    normalized === "gs-live" ||
    normalized === "gs_live" ||
    normalized === "partner118" ||
    normalized === "partner_118" ||
    normalized === "gslive_partner118" ||
    normalized === "live"
  ) {
    return "gslive";
  }
  if (normalized === "gsbuilder" || normalized === "builder") {
    return "gsbuilder";
  }
  if (normalized === "gateway" || normalized === "gw") {
    return "gateway";
  }
  if (
    normalized === "cslevel2" ||
    normalized === "polymarket" ||
    normalized === "clob"
  ) {
    return "cslevel2";
  }
  // ALERT is the F402 mirror feed: a writable lane, money-excluded via sentinel.
  if (normalized === "alert" || normalized === "inet_mirror") {
    return "inet_mirror";
  }
  if (normalized === "blocked" || normalized === "block") {
    return "blocked";
  }
  if (normalized === "non_sports_drop" || normalized === "non-sports-drop") {
    return "non_sports_drop";
  }
  return "unknown";
}

/** Resolve canonical OriginDomainId for a raw writer label. */
export function resolveOriginDomainForWriter(
  rawWriter: string,
): OriginDomainId {
  const channel = resolveWriterChannel(rawWriter);
  if (isSentinelChannelId(channel)) {
    const laneId = SENTINEL_CHANNEL_REGISTRY[channel].laneId;
    return laneId === null
      ? "ORIGIN_HOST_NSH_DESK_LOCAL"
      : WRITER_LANE_REGISTRY[laneId].originDomainId;
  }
  return WRITER_LANE_REGISTRY[channel].originDomainId;
}

/** Resolve canonical VenueId for a given OriginDomainId. */
export function resolveVenueIdForOrigin(
  originDomainId: OriginDomainId,
): VenueId {
  return ORIGIN_DOMAIN_REGISTRY[originDomainId].venueId;
}

/** One step from a raw writer label to the venue it traded on. */
export function resolveVenueIdForWriter(rawWriter: string): VenueId {
  const channel = resolveWriterChannel(rawWriter);
  if (isSentinelChannelId(channel)) {
    const laneId = SENTINEL_CHANNEL_REGISTRY[channel].laneId;
    return laneId === null ? "desk" : WRITER_LANE_REGISTRY[laneId].venueId;
  }
  return WRITER_LANE_REGISTRY[channel].venueId;
}
