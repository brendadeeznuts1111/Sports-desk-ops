/**
 * @file lib/sport_vocabulary.ts
 * @description Normalize the manager sportType list. Rows are fixed-width padded and carry the
 * name twice (sportType and a numeric key); trim and dedupe, keeping display order.
 */

export function parseSportTypeList(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const list = (raw as Record<string, unknown>).LIST;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    if (value === null || typeof value !== "object") continue;
    const label = (value as Record<string, unknown>).sportType;
    if (typeof label !== "string") continue;
    const name = label.trim();
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Case-insensitive canonical sport from the vocabulary; null when absent. */
export function canonicalSport(
  label: string,
  vocabulary: readonly string[],
): string | null {
  const want = label.trim().toLowerCase();
  if (want === "") return null;
  return vocabulary.find((name) => name.toLowerCase() === want) ?? null;
}
