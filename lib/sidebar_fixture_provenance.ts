/**
 * Fixture detection for desk-panel KPI provenance (sidebar client + tests).
 * Belt-and-suspenders: trust `basis` when present, fall back to source path prefix
 * so the UI stays honest during API rollout.
 */

export interface SidebarKpiProvenance {
  readonly basis?: string | null;
  readonly source?: string | null;
}

/** True when a bare `source` string points at repo-local / demo inputs, not portal capture. */
export function isFixtureSource(source: string): boolean {
  const value = source.trim();
  if (value.startsWith("live:")) return false;
  if (value.startsWith("capture:")) return false;
  return (
    value.startsWith("scratch/") ||
    value.startsWith("tests/fixtures/") ||
    value.startsWith("./")
  );
}

export function isFixtureProvenance(
  prov: SidebarKpiProvenance | null | undefined,
): boolean {
  if (prov === null || prov === undefined) return false;
  const basis = (prov.basis ?? "").trim().toLowerCase();
  if (basis === "fixture") return true;
  if (basis === "live") return false;
  const srcRaw = (prov.source ?? "").trim();
  if (basis === "capture" && srcRaw.startsWith("data/")) return false;
  if (srcRaw === "") return false;
  if (isFixtureSource(srcRaw)) return true;
  const src = srcRaw.toLowerCase();
  return src.startsWith("tests/") || src.includes("fixture");
}

/** When true, the sidebar should show the amber "not live" chip on a provenance line. */
export function shouldShowFixtureNotLiveChip(
  prov: SidebarKpiProvenance | null | undefined,
): boolean {
  return isFixtureProvenance(prov);
}
