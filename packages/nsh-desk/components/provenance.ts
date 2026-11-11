import type { ProvenanceTag } from "../desk_model";
import type { BadgeTone } from "../ui";

export const PANEL_TITLES: Readonly<Record<string, string>> = {
  markets: "Markets Terminal",
  signals: "Kalshi Signals",
  exposure: "Risk Exposure",
  scoreboard: "Scoreboard",
  kpis: "KPIs & Provenance",
  diagnostics: "Pipeline & Honesty",
};

export function provenanceTone(p: ProvenanceTag): BadgeTone {
  if (p.stale || p.partial) return "warning";
  if (p.basis === "live") return "positive";
  return "neutral";
}
