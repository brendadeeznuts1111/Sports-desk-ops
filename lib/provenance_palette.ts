/**
 * @file lib/provenance_palette.ts
 * @description Startup palette for the ingestion provenance channels.
 *
 * The colors are *not* re-declared here. `design/tokens.toml` is the SSOT and
 * `gen:tokens` emits it into `INGESTION_CHANNELS`; this module parses each hex
 * once at module load with `Bun.color(..., "number")` (or the manual fallback
 * where Bun is unavailable) and exposes the packed 24-bit `ColorHexInt`.
 *
 * Why this shape:
 *  - No async startup loader, so a frame can never be packed before the palette
 *    is ready.
 *  - No `Map`/`Set` cache: the naming gate bans heap caches on hot paths, and a
 *    seven-entry array scan is cheaper than a hash lookup at this size.
 *  - The CSS strings are precomputed from the same source, so the frontend can
 *    paint a known provenance token without building a string per row.
 */
import {
  INGESTION_CHANNELS,
  parseAsColorHexInt,
  type ColorHexInt,
  type SignalChannelCode,
} from "../design/domain-branded-types.ts";

export class ProvenancePaletteError extends Error {
  readonly code = "unparseable_token" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProvenancePaletteError";
  }
}

/** A six-digit hex is the only shape `gen:tokens` emits; reject anything else loudly. */
const SIX_DIGIT_HEX = /^#[0-9a-fA-F]{6}$/;

const colorByCode = {} as Record<SignalChannelCode, ColorHexInt>;
const cssByCode = {} as Record<SignalChannelCode, string>;

for (const channel of INGESTION_CHANNELS) {
  if (!SIX_DIGIT_HEX.test(channel.hex)) {
    throw new ProvenancePaletteError(
      `provenance token ${channel.channelCode} must be #RRGGBB (got ${channel.hex})`,
    );
  }
  if (Object.hasOwn(colorByCode, channel.channelCode)) {
    throw new ProvenancePaletteError(
      `duplicate provenance channel ${channel.channelCode} in the generated registry`,
    );
  }
  colorByCode[channel.channelCode] = parseAsColorHexInt(channel.hex);
  cssByCode[channel.channelCode] = channel.hex;
}

/** Palette order follows the generated registry; do not reorder it. */
export const PROVENANCE_CHANNEL_CODES: readonly SignalChannelCode[] =
  INGESTION_CHANNELS.map((channel) => channel.channelCode);

/** Packed 24-bit RGB per provenance channel, parsed once at startup. */
export const PROVENANCE_COLORS: Readonly<
  Record<SignalChannelCode, ColorHexInt>
> = Object.freeze(colorByCode);

/** Precomputed CSS strings per provenance channel — no per-row string building. */
export const PROVENANCE_CSS: Readonly<Record<SignalChannelCode, string>> =
  Object.freeze(cssByCode);

export function provenanceColorFor(code: SignalChannelCode): ColorHexInt {
  return PROVENANCE_COLORS[code];
}

export function provenanceCssFor(code: SignalChannelCode): string {
  return PROVENANCE_CSS[code];
}

/** Reverse lookup used by the frame reader; seven comparisons, no allocation. */
export function provenanceCodeForColor(
  color: ColorHexInt,
): SignalChannelCode | null {
  for (const channel of INGESTION_CHANNELS) {
    if (PROVENANCE_COLORS[channel.channelCode] === color) {
      return channel.channelCode;
    }
  }
  return null;
}

/**
 * CSS for a packed color. Known provenance tokens return their precomputed
 * string; an unknown color (a producer outside the registry) falls back to a
 * single hex string so the UI still paints something truthful.
 */
export function provenanceCssForColor(color: ColorHexInt): string {
  const code = provenanceCodeForColor(color);
  if (code !== null) return PROVENANCE_CSS[code];
  return `#${color.toString(16).padStart(6, "0")}`;
}
