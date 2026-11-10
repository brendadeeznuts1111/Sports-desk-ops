import type { ProvenanceTag } from "../desk_model";
import type { BadgeTone } from "../ui";

export const PANEL_TITLES: Readonly<Record<string, string>> = {
  signals: "Kalshi signals",
  exposure: "Exposure plot",
  scoreboard: "Scoreboard",
  kpis: "KPIs",
  diagnostics: "Pipeline",
};

export function provenanceTone(prov: ProvenanceTag): BadgeTone {
  if (prov.stale || prov.partial) return "warning";
  if (prov.basis === "live") return "positive";
  return "neutral";
}
