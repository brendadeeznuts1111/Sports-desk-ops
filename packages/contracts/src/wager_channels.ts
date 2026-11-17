/**
 * @file packages/contracts/src/wager_channels.ts
 * @description Ticket-writer channel vocabulary, shared by the ingest projection
 * (`lib/live_wagers.ts`) and the dashboard, so a writer is classified once and the same
 * GSLIVE / GS Builder split holds on both sides.
 */

export const WAGER_CHANNEL_FAMILIES = [
  "gslive",
  "gsbuilder",
  "internet",
  "alert",
  "blocked",
  "other",
] as const;

export type WagerChannel = (typeof WAGER_CHANNEL_FAMILIES)[number];

/** Partner 118 skins: GSLIVE (in-play) and GSBUILDER (SGP / parlay builder). */
export const PARTNER_118_CHANNELS = ["gslive", "gsbuilder"] as const;

export type Partner118Channel = (typeof PARTNER_118_CHANNELS)[number];

const CHANNEL_BY_WRITER: Readonly<Record<string, WagerChannel>> = {
  gslive: "gslive",
  gsbuilder: "gsbuilder",
  internet: "internet",
  alert: "alert",
  blocked: "blocked",
};

/** `"GSBUILDER   "` → `"gsbuilder"`; unknown or missing writers → `"other"`. */
export function wagerChannelOf(ticketWriter: unknown): WagerChannel {
  if (ticketWriter === null || ticketWriter === undefined) return "other";
  const key = String(ticketWriter).trim().toLowerCase();
  return CHANNEL_BY_WRITER[key] ?? "other";
}

export function isPartner118Channel(
  channel: WagerChannel,
): channel is Partner118Channel {
  return channel === "gslive" || channel === "gsbuilder";
}

/** Display labels; the desk writes GSLIVE in caps and "GS Builder" for the SGP skin. */
export const WAGER_CHANNEL_LABELS: Readonly<Record<WagerChannel, string>> = {
  gslive: "GSLIVE",
  gsbuilder: "GS Builder",
  internet: "Internet",
  alert: "ALERT",
  blocked: "BLOCKED",
  other: "Other",
};
