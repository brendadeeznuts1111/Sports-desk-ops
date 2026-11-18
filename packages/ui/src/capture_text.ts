/**
 * @file capture_text.ts
 * @description Display sanitizer for capture text fields.
 *
 * Some portal captures carry HTML in plain text: `TicketWriter` arrives as
 * `<strong style="color:#D90000">ALERT </strong>`, and `ShortDesc`-derived
 * selections carry numeric references such as `Thunder/Kings U 112&#189; -110`.
 * React escapes those strings, so the tape prints the markup instead of the
 * pick. This only cleans the rendered text — the stored capture is never
 * rewritten, so provenance and audit remain unchanged.
 */

const MARKUP_TAG =
  /<\/?(?:a|b|i|u|s|em|strong|span|font|small|big|br|div|p|code|pre|sup|sub|strike)\b[^>]*>/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  times: "×",
  divide: "÷",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  deg: "°",
  plusmn: "±",
  middot: "·",
  bull: "•",
  cent: "¢",
  pound: "£",
  euro: "€",
};

// eslint-disable-next-line no-control-regex -- control references are the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

function decodeCodePoint(raw: string, fallback: string): string {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff)
    return fallback;
  // Control references (e.g. `&#x0D;` from CRLF captures) become a space.
  if (value < 0x20) return " ";
  return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);?/g, (match, hex: string) =>
      Number.isFinite(Number.parseInt(hex, 16))
        ? decodeCodePoint(String(Number.parseInt(hex, 16)), match)
        : match,
    )
    .replace(/&#(\d+);?/g, (match, decimal: string) =>
      decodeCodePoint(decimal, match),
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name: string) => {
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    });
}

/**
 * Strip portal markup and decode entities for display. Handles one level of
 * double encoding (`&amp;#189;`) because captures can be re-escaped. Unknown
 * entities and lone `<` characters are preserved rather than guessed at.
 */
export function sanitizeCaptureText(raw: string): string {
  let text = raw.replace(MARKUP_TAG, " ");
  text = decodeEntities(decodeEntities(text));
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}
