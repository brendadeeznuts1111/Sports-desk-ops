/**
 * @file leg_taxonomy.ts
 * @description The dimensions a leg is expressed in, independent of any combo:
 *   - sport      the game identifier's family prefix (`CFB:`, `NBA:`) and its subject tokens
 *   - period     `CanonicalPeriod` (game, halves, quarters, live)
 *   - market     `MarketKind` (spread/total/moneyline/...) and `MarketSide` (OVER/UNDER/...)
 *
 * `combo_identity.ts` composes these into legs and combo hashes; it does not define them.
 * No behaviour lives here beyond normalization: the same raw inputs map to the same values.
 */

export type CanonicalPeriod =
  "game" | "1h" | "2h" | "1q" | "2q" | "3q" | "4q" | "live";

export function normalizeCanonicalPeriod(
  raw: string | number | null | undefined,
): CanonicalPeriod {
  if (raw === null || raw === undefined || raw === "") return "game";
  if (typeof raw === "number") {
    switch (raw) {
      case 0:
        return "game";
      case 1:
        return "1h";
      case 2:
        return "2h";
      case 3:
        return "1q";
      case 4:
        return "2q";
      case 5:
        return "3q";
      case 6:
        return "4q";
      default:
        return "game";
    }
  }
  const s = String(raw).trim().toLowerCase();
  if (
    s === "0" ||
    s === "game" ||
    s === "full" ||
    s === "fg" ||
    s === "full_game"
  )
    return "game";
  if (
    s === "1" ||
    s === "1h" ||
    s.includes("1st half") ||
    s.includes("first half")
  )
    return "1h";
  if (
    s === "2" ||
    s === "2h" ||
    s.includes("2nd half") ||
    s.includes("second half")
  )
    return "2h";
  if (s === "3" || s === "1q" || s.includes("1st quarter") || s.includes("q1"))
    return "1q";
  if (s === "4" || s === "2q" || s.includes("2nd quarter") || s.includes("q2"))
    return "2q";
  if (s === "5" || s === "3q" || s.includes("3rd quarter") || s.includes("q3"))
    return "3q";
  if (s === "6" || s === "4q" || s.includes("4th quarter") || s.includes("q4"))
    return "4q";
  if (s === "0g" || s.includes("live") || s.includes("in-play")) return "live";
  return "game";
}

export type MarketKind =
  | "spread"
  | "total"
  | "moneyline"
  | "team_total"
  | "player_prop"
  | "prop"
  | "teaser"
  | "unknown";

export type MarketSide =
  | "OVER"
  | "UNDER"
  | "HOME"
  | "AWAY"
  | "FAVORITE"
  | "UNDERDOG"
  | "YES"
  | "NO"
  | "UNKNOWN";

/** Standardizes team/subject tokens across CFB, NFL, and NBA */
export function normalizeCanonicalSubject(raw: string | undefined): string {
  if (!raw || raw.trim() === "") return "UNKNOWN";
  const s = raw.trim().toUpperCase();
  if (s.includes("BAYLOR")) return "BAYLOR";
  if (s.includes("PATRIOTS") || s.includes("NEW ENGLAND") || s === "NE")
    return "NE";
  if (s.includes("TROY")) return "TROY";
  if (s.includes("SAC ST") || s.includes("SACRAMENTO")) return "SAC_ST";
  if (s.includes("ALABAMA") || s === "ALA") return "ALA";
  if (s.includes("OHIO ST") || s === "OSU") return "OSU";
  if (s.includes("TEXAS TECH") || s.includes("TTU")) return "TTU";
  if (s.includes("C FLORIDA") || s.includes("UCF")) return "UCF";
  if (s.includes("JETS") || s.includes("NY JETS") || s === "NYJ") return "NYJ";
  if (s.includes("LAKERS") || s === "LAL") return "LAL";
  if (s.includes("CELTICS") || s.includes("BOSTON") || s === "BOS")
    return "BOS";
  if (s.includes("WARRIORS") || s.includes("GOLDEN STATE") || s === "GSW")
    return "GSW";
  if (s.includes("NUGGETS") || s.includes("DENVER") || s === "DEN")
    return "DEN";
  if (s.includes("SUNS") || s.includes("PHOENIX") || s === "PHX") return "PHX";
  if (s.includes("BUCKS") || s.includes("MILWAUKEE") || s === "MIL")
    return "MIL";
  if (s.includes("KNICKS") || s === "NYK") return "NYK";
  if (s.includes("MAVERICKS") || s.includes("DALLAS MAVS") || s === "DAL_NBA")
    return "DAL_NBA";
  if (s.includes("COWBOYS") || s === "DAL") return "DAL";
  if (s.includes("CHIEFS") || s === "KC") return "KC";
  return s.replace(/\s+/g, "_");
}

/** Resolves canonical game ID from team/subject tokens */
export function deriveGameIdentifier(
  family: string,
  subject: string,
  opponentOrDesc?: string,
): string {
  const normFam = family.trim().toUpperCase();
  const s1 = normalizeCanonicalSubject(subject);
  const s2 = opponentOrDesc ? normalizeCanonicalSubject(opponentOrDesc) : "OPP";
  const pair = [s1, s2].sort().join("_VS_");
  return `${normFam}:${pair}`;
}
