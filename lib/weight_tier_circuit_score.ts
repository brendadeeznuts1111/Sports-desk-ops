/**
 * Section 11 / Exp3 circuit score proxy from cross-layer mechanism hits (replay-safe).
 */
import type { WeightMechanismHit } from "./weight_tier_signal_enrichment.ts";

export interface CircuitScoreBreakdown {
  readonly scoreHundredths: number;
  readonly inductionHundredths: number;
  readonly steamHundredths: number;
  readonly clvHundredths: number;
  readonly slaHundredths: number;
}

const MECH_WEIGHT: Readonly<
  Record<WeightMechanismHit["id"], keyof Omit<CircuitScoreBreakdown, "scoreHundredths">>
> = {
  qk_ov_induction_virtual: "inductionHundredths",
  bitwise_score_proximity_steam: "steamHundredths",
  sentinel_clv_market_split: "clvHundredths",
  rank1_reasoning_loop_sla: "slaHundredths",
};

export function circuitScoreFromMechanisms(
  mechanisms: readonly WeightMechanismHit[],
): CircuitScoreBreakdown {
  const parts: CircuitScoreBreakdown = {
    scoreHundredths: 0,
    inductionHundredths: 0,
    steamHundredths: 0,
    clvHundredths: 0,
    slaHundredths: 0,
  };

  for (const hit of mechanisms) {
    const slot = MECH_WEIGHT[hit.id];
    const prev = parts[slot];
    if (hit.confidenceHundredths > prev) {
      parts[slot] = hit.confidenceHundredths;
    }
  }

  const weighted =
    parts.inductionHundredths * 0.35 +
    parts.steamHundredths * 0.3 +
    parts.clvHundredths * 0.25 +
    parts.slaHundredths * 0.1;

  return {
    ...parts,
    scoreHundredths: Math.min(100, Math.round(weighted)),
  };
}
