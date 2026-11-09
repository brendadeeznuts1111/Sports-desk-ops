/**
 * Fixture detection for desk-panel KPI provenance (sidebar client + tests).
 * Belt-and-suspenders: trust `basis` when present, fall back to source path prefix
 * so the UI stays honest during API rollout.
 */

export interface SidebarKpiProvenance {
  readonly basis?: string | null;
  readonly source?: string | null;
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
  const src = (prov.source ?? "").trim().toLowerCase();
  if (src === "") return false;
  return (
    src.startsWith("scratch/") ||
    src.startsWith("tests/") ||
    src.includes("fixture")
  );
}

/** When true, the sidebar should show the amber "not live" chip on a provenance line. */
export function shouldShowFixtureNotLiveChip(
  prov: SidebarKpiProvenance | null | undefined,
): boolean {
  return isFixtureProvenance(prov);
}
