/**
 * Find and replace IP addresses inside free text. Shared by the Fantasy402
 * puller (masking) and analyzer (hashing) so both treat every occurrence in a
 * string, not just the first.
 */

const IPV4_SOURCE = String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`;
const IPV6_CANDIDATE_SOURCE = String.raw`\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b`;

const IPV4_ONE = new RegExp(IPV4_SOURCE);

export type IpFamily = "ipv4" | "ipv6";

/**
 * A colon-hex run counts as IPv6 when it is compressed (`::`) or has at least
 * five groups, and carries at least two non-empty groups. Clock times such as
 * `10:00:00` (three groups) and scope operators such as `Manager::get` (no
 * hex groups around `::`) stay text.
 */
export function isIpv6Candidate(match: string): boolean {
  const groups = match.split(":");
  const filled = groups.filter((group) => group !== "").length;
  if (filled < 2) return false;
  return match.includes("::") || groups.length >= 5;
}

export function replaceIpsInText(
  text: string,
  replacer: (ip: string, family: IpFamily) => string,
): string {
  return text
    .replace(new RegExp(IPV4_SOURCE, "g"), (match) => replacer(match, "ipv4"))
    .replace(new RegExp(IPV6_CANDIDATE_SOURCE, "g"), (match) =>
      isIpv6Candidate(match) ? replacer(match, "ipv6") : match,
    );
}

export function textContainsIp(text: string): boolean {
  if (IPV4_ONE.test(text)) return true;
  for (const match of text.matchAll(new RegExp(IPV6_CANDIDATE_SOURCE, "g"))) {
    if (isIpv6Candidate(match[0])) return true;
  }
  return false;
}
