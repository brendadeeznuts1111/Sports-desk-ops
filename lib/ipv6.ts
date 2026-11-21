/**
 * Expand and normalize IPv6 literals for prefix masking.
 * Handles compressed `::`, IPv4-mapped tails, zone ids, case, and leading zeros.
 */

const IPV4_OCTET_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/i;
const IPV4_LIT = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const HEXTET = String.raw`[0-9a-fA-F]{1,4}`;

/**
 * Candidate run that might be IPv6, including compressed and IPv4-mapped forms
 * and an optional zone id. Callers must validate with `parseIpv6Hextets`.
 */
export const IPV6_CANDIDATE_RE = new RegExp(
  String.raw`(?:` +
    String.raw`(?:${HEXTET}:){6}${IPV4_LIT}` +
    String.raw`|` +
    String.raw`(?:(?:${HEXTET}:)*${HEXTET})?::(?:${HEXTET}:)*${IPV4_LIT}` +
    String.raw`|` +
    String.raw`(?:${HEXTET}:){7}${HEXTET}` +
    String.raw`|` +
    String.raw`(?:(?:${HEXTET}:)+${HEXTET})?::(?:${HEXTET}:)*${HEXTET}?` +
    String.raw`)(?:%[0-9A-Za-z._~-]+)?`,
  "gi",
);

function parseIpv4Octets(
  value: string,
): readonly [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) return null;
    octets.push(Number(part));
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const tokens = side.split(":");
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined || tok === "") return null;
    if (tok.includes(".")) {
      if (i !== tokens.length - 1) return null;
      const octets = parseIpv4Octets(tok);
      if (octets === null) return null;
      out.push(((octets[0] & 0xff) << 8) | (octets[1] & 0xff));
      out.push(((octets[2] & 0xff) << 8) | (octets[3] & 0xff));
      continue;
    }
    if (!HEXTET_RE.test(tok)) return null;
    out.push(Number.parseInt(tok, 16));
  }
  return out;
}

function stripIpv6Wrapper(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  return zone >= 0 ? ip.slice(0, zone) : ip;
}

/** Eight hextets, or `null` when the literal is not valid IPv6. */
export function parseIpv6Hextets(raw: string): Uint16Array | null {
  const ip = stripIpv6Wrapper(raw);
  if (ip === "" || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const whole = parseIpv6Side(halves[0] ?? "");
    if (whole === null || whole.length !== 8) return null;
    return Uint16Array.from(whole);
  }
  const left = parseIpv6Side(halves[0] ?? "");
  const right = parseIpv6Side(halves[1] ?? "");
  if (left === null || right === null) return null;
  const zeroCount = 8 - (left.length + right.length);
  if (zeroCount <= 0) return null;
  const out = new Uint16Array(8);
  let idx = 0;
  for (const value of left) {
    out[idx] = value;
    idx += 1;
  }
  idx += zeroCount;
  for (const value of right) {
    out[idx] = value;
    idx += 1;
  }
  return out;
}

/** Eight lowercase, leading-zero-stripped groups, or `null`. */
export function ipv6GroupStrings(raw: string): readonly string[] | null {
  const hextets = parseIpv6Hextets(raw);
  if (hextets === null) return null;
  return Array.from(hextets, (value) => value.toString(16));
}

/** First four normalized groups (`/64`), or `null`. */
export function ipv6Prefix64(raw: string): string | null {
  const groups = ipv6GroupStrings(raw);
  if (groups === null) return null;
  return `${groups[0]}:${groups[1]}:${groups[2]}:${groups[3]}`;
}

export function replaceIpv6InText(
  text: string,
  replacer: (match: string) => string,
): string {
  return text.replace(IPV6_CANDIDATE_RE, (match) =>
    parseIpv6Hextets(match) === null ? match : replacer(match),
  );
}
