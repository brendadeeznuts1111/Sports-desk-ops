/**
 * @file packages/ui/src/shadow_pricing/shared.tsx
 * @description Pure formatters, badge helpers, and client preset definitions for
 * the Hierarchical Taxonomy Cube & Shadow-Pricing Simulator.
 */

import React from "react";
import type {
  MarketFilter,
  PeriodFilter,
  PointBuyPolicy,
  SportCode,
  SportFilter,
  SubSportFilter,
  TaxonomyRiskStatus,
} from "@sportsdesk-ops/contracts/shadow-pricing";

export type CubeTab = "sport" | "subSport" | "period" | "market";

export interface ClientLadderPreset {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly ladderKey3: number;
  readonly ladderKey7: number;
  readonly ladderKey14_21: number;
}

export interface QuickSlicePreset {
  readonly label: string;
  readonly sport: SportFilter;
  readonly subSport: SubSportFilter;
  readonly period: PeriodFilter;
  readonly market: MarketFilter;
  readonly cubeTab: CubeTab;
}

export function formatSignedUsd(val: number): string {
  const abs = Math.abs(Math.round(val)).toLocaleString();
  if (val > 0) return `+$${abs}`;
  if (val < 0) return `-$${abs}`;
  return "$0";
}

export function formatUsd(val: number): string {
  const abs = Math.abs(Math.round(val)).toLocaleString();
  return val < 0 ? `-$${abs}` : `$${abs}`;
}

export function formatCompactLegs(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const SPORT_ICONS: Readonly<Record<SportCode, string>> = {
  Football: "🏈",
  Basketball: "🏀",
  Hockey: "🏒",
  Baseball: "⚾",
  Soccer: "⚽",
  LIVE: "⚡",
  Other: "🎾",
};

export const CLIENT_PRESETS: readonly ClientLadderPreset[] = [
  {
    id: "retail_flat",
    label: "Flat Retail Catalog",
    subtitle: "-120 / -120 / -120 baseline",
    ladderKey3: -120,
    ladderKey7: -120,
    ladderKey14_21: -120,
  },
  {
    id: "indifference",
    label: "Indifference Breakeven",
    subtitle: "0.0% EV (-138 / -132 / -123)",
    ladderKey3: -138,
    ladderKey7: -132,
    ladderKey14_21: -123,
  },
  {
    id: "shadow_default",
    label: "Calibrated Shadow",
    subtitle: "dx shadow-price (-140 / -135 / -128)",
    ladderKey3: -140,
    ladderKey7: -135,
    ladderKey14_21: -128,
  },
  {
    id: "house_hold",
    label: "Standard House Hold",
    subtitle: "~4.5% hold (-150 / -142 / -130)",
    ladderKey3: -150,
    ladderKey7: -142,
    ladderKey14_21: -130,
  },
];

export const QUICK_SLICE_PRESETS: readonly QuickSlicePreset[] = [
  {
    label: "🌐 Full Book",
    sport: "ALL",
    subSport: "ALL",
    period: "ALL",
    market: "ALL",
    cubeTab: "sport",
  },
  {
    label: "🏈 NFL P0 Spread (Key Leak)",
    sport: "Football",
    subSport: "NFL",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🏟️ CFB P0 Spread (Key Leak)",
    sport: "Football",
    subSport: "NCAAF",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🏀 NBA P0 Spread (Desk Edge)",
    sport: "Basketball",
    subSport: "NBA",
    period: "game",
    market: "spread",
    cubeTab: "period",
  },
  {
    label: "🎓 NCAAB (20m Halves Only)",
    sport: "Basketball",
    subSport: "NCAAB",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "🏒 NHL (60m / OT / P1–P3)",
    sport: "Hockey",
    subSport: "NHL",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "⚾ MLB (9 Inn / F5 / Inning)",
    sport: "Baseball",
    subSport: "MLB",
    period: "ALL",
    market: "ALL",
    cubeTab: "period",
  },
  {
    label: "⚡ LIVE #9000 (In-Play Lockout)",
    sport: "LIVE",
    subSport: "ALL",
    period: "game",
    market: "ALL",
    cubeTab: "subSport",
  },
];

export function renderPolicyBadge(policy: PointBuyPolicy): React.ReactElement {
  if (policy === "KEY_LEAK_EXPOSED") {
    return (
      <span className="sd-pill sd-pill-alert">🔴 KEY-NUMBER LEAK EXPOSED</span>
    );
  }
  if (policy === "HOUSE_HOLD_ADVANTAGE") {
    return (
      <span className="sd-pill sd-pill-live">🟢 HOUSE HOLD ADVANTAGE</span>
    );
  }
  return <span className="sd-pill sd-pill-blocked">🔒 POINT BUYS BLOCKED</span>;
}

export function renderRiskBadge(
  status: TaxonomyRiskStatus,
): React.ReactElement {
  if (status === "CRITICAL_LEAK") {
    return <span className="sd-pill sd-pill-alert">CRITICAL LEAK</span>;
  }
  if (status === "SEVERE_LEAK") {
    return <span className="sd-pill sd-pill-fixture">KEY EXPOSED</span>;
  }
  if (status === "DESK_ADVANTAGE") {
    return <span className="sd-pill sd-pill-live">DESK EDGE (+6.5¢)</span>;
  }
  if (status === "POSITIVE_HOLD") {
    return <span className="sd-pill sd-pill-live">POSITIVE HOLD</span>;
  }
  return <span className="sd-pill sd-pill-blocked">IMMUNE / LOCKED</span>;
}
