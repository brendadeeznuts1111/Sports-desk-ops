/**
 * @file gs_feed_team_logos.ts
 * @description Derive team-logo candidate filenames from Ganchrow Diffusion feed teams.
 *
 * `@ganchrowsci/gs-sdk` publishes `Team { id, name, home?, supplementary?, nick_name? }` — no
 * asset URL. The Manager console CDN names files either `<Name>.png` (college style) or
 * `<City>-<Nickname>.png` (pro style), so this module emits both spellings per feed team; the
 * caller HEAD-checks them against `cdn.fastassets.io` before merging anything.
 */

export interface FeedTeam {
  readonly name: string;
  readonly nickName: string | null;
}

/** Extract unique team names from Diffusion event payloads (a single event or a rotation map). */
export function collectFeedTeams(payloads: readonly unknown[]): FeedTeam[] {
  const byName = new Map<string, FeedTeam>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const teams = record["teams"];
    if (Array.isArray(teams)) {
      for (const team of teams) {
        if (team === null || typeof team !== "object") continue;
        const entry = team as Record<string, unknown>;
        const name =
          typeof entry["name"] === "string" ? entry["name"].trim() : "";
        if (name === "") continue;
        const nickRaw = entry["nick_name"] ?? entry["nickName"];
        const nick =
          typeof nickRaw === "string" && nickRaw.trim() !== ""
            ? nickRaw.trim()
            : null;
        const key = name.toLowerCase();
        const existing = byName.get(key);
        if (
          existing === undefined ||
          (existing.nickName === null && nick !== null)
        ) {
          byName.set(key, { name, nickName: nick });
        }
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  for (const payload of payloads) visit(payload);
  return [...byName.values()];
}

/**
 * Candidate CDN filenames for one feed team: `<Name>.png` and `<Name dashed>.png`, plus the
 * `<City>-<Nickname>.png` spelling when the nickname is a suffix of the name.
 */
export function deriveLogoFileCandidates(teams: readonly FeedTeam[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const add = (file: string): void => {
    if (file === "" || seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };
  for (const team of teams) {
    const name = team.name.trim();
    if (name === "") continue;
    add(`${name}.png`);
    add(`${name.replace(/\s+/g, "-")}.png`);
    const nick = team.nickName?.trim() ?? "";
    if (nick !== "" && name.toLowerCase().endsWith(` ${nick.toLowerCase()}`)) {
      const city = name.slice(0, name.length - nick.length).trim();
      if (city !== "") {
        add(`${city}-${nick}.png`);
      }
    }
  }
  return files;
}
