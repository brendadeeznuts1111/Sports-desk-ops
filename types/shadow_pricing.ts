/**
 * @file types/shadow_pricing.ts
 * @description Shared browser-safe & server-safe contracts for Hierarchical Taxonomy Cube
 * (Sport -> SubSport -> Period per SubSport -> Market) & Shadow-Pricing Elasticity (#135).
 */

export type ShadowProvenance = "live_db" | "fixture";

/**
 * - `exact`: Applies the shadow ladder odds directly onto matching key numbers (verbatim parity with `./bin/dx shadow-price`).
 * - `floor`: Clamps key-number buys so bettors never get a cheaper price than `priceTaken` (protects existing -145/-150 1.0–1.5pt buys).
 */
export type ShadowRepriceMode = "exact" | "floor";

/** Level 1: Canonical top-level Sport / Operational Mode */
export type SportCode =
  | "Football"
  | "Basketball"
  | "Hockey"
  | "Baseball"
  | "Soccer"
  | "LIVE"
  | "Other";

export type SportFilter = "ALL" | SportCode;

/** Level 2: Canonical SubSport / League */
export type SubSportCode =
  | "NFL"
  | "NCAAF"
  | "NBA"
  | "NCAAB"
  | "WNBA"
  | "NHL"
  | "Hockey_Alter"
  | "MLB"
  | "Baseball_Series"
  | "Soccer_Top"
  | "NFL_Live"
  | "NCAAF_Live"
  | "NBA_Live"
  | "NHL_Live"
  | "MLB_Live"
  | "Tennis_Tour"
  | "Combat_Golf"
  | "Other_General";

export type SubSportFilter = "ALL" | SubSportCode;

/** Level 3: Canonical Period codes (scoped dynamically per SubSport) */
export type PeriodCode =
  | "game"
  | "1h"
  | "2h"
  | "1q"
  | "2q"
  | "3q"
  | "4q"
  | "p1"
  | "p2"
  | "p3"
  | "reg"
  | "f5"
  | "inning"
  | "set"
  | "round";

export type PeriodFilter = "ALL" | PeriodCode;

/** Level 4: Canonical Market type */
export type MarketCode =
  "spread" | "total" | "moneyline" | "team_total" | "player_prop" | "other";

export type MarketFilter = "ALL" | MarketCode;

export type PointBuyPolicy =
  "KEY_LEAK_EXPOSED" | "HOUSE_HOLD_ADVANTAGE" | "STRICTLY_BLOCKED";

export type TaxonomyRiskStatus =
  | "CRITICAL_LEAK"
  | "SEVERE_LEAK"
  | "POSITIVE_HOLD"
  | "DESK_ADVANTAGE"
  | "IMMUNE_BLOCKED";

export interface SubSportPeriodSpec {
  readonly code: PeriodCode;
  readonly portalPeriodNumber: number;
  readonly label: string;
  readonly shortLabel: string;
  readonly allowsPointBuys: boolean;
}

export interface SubSportTaxonomySpec {
  readonly code: SubSportCode;
  readonly label: string;
  readonly shortLabel: string;
  readonly sport: SportCode;
  readonly isLive: boolean;
  readonly pointBuyPolicy: PointBuyPolicy;
  readonly primaryRiskVector: string;
  readonly validPeriods: readonly SubSportPeriodSpec[];
  readonly primaryMarkets: readonly MarketCode[];
}

export interface TaxonomyRollupRow {
  readonly dimension: "sport" | "subSport" | "period" | "market";
  readonly code: string;
  readonly label: string;
  readonly parentCode?: string;
  readonly portalPeriodNumber?: number;
  readonly totalLegs: number;
  readonly settledLegs: number;
  readonly decidedLegs: number;
  readonly winRatePct: number;
  readonly handleUsd: number;
  readonly buyLegs: number;
  readonly buyRatePct: number;
  readonly buyHandleUsd: number;
  readonly actualDeskPnlUsd: number;
  readonly holdPct: number;
  readonly shadowDeskPnlUsd: number;
  readonly netDeltaUsd: number;
  readonly pointBuyPolicy: PointBuyPolicy;
  readonly riskStatus: TaxonomyRiskStatus;
  readonly primaryRiskVector: string;
}

export interface TaxonomyCubeSummary {
  readonly activeFilters: {
    readonly sport: SportFilter;
    readonly subSport: SubSportFilter;
    readonly period: PeriodFilter;
    readonly market: MarketFilter;
    readonly periodNormalizedFromInvalid: boolean;
  };
  readonly activeSlice: {
    readonly breadcrumb: string;
    readonly totalLegs: number;
    readonly settledLegs: number;
    readonly winRatePct: number;
    readonly handleUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly holdPct: number;
    readonly buyLegs: number;
    readonly buyRatePct: number;
    readonly buyHandleUsd: number;
    readonly pointBuyPolicy: PointBuyPolicy;
    readonly riskStatus: TaxonomyRiskStatus;
    readonly primaryRiskVector: string;
    readonly validPeriodsForSelection: readonly SubSportPeriodSpec[];
  };
  readonly catalog: readonly SubSportTaxonomySpec[];
  readonly bySport: readonly TaxonomyRollupRow[];
  readonly bySubSport: readonly TaxonomyRollupRow[];
  readonly byPeriod: readonly TaxonomyRollupRow[];
  readonly byMarket: readonly TaxonomyRollupRow[];
}

export interface ShadowSimulationSummary {
  readonly summary: {
    readonly totalAnalyzedLegs: number;
    readonly totalSettledLegs: number;
    readonly totalStakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly netDeskSavingsUsd: number;
  };
  readonly sharpCohort: {
    readonly bettorCount: number;
    readonly legCount: number;
    readonly stakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly sharpSavingsUsd: number;
  };
  readonly retailCohort: {
    readonly bettorCount: number;
    readonly legCount: number;
    readonly stakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly retailNetImpactUsd: number;
    readonly elasticityAssumed: number;
  };
  readonly topSharpBuyers: readonly {
    readonly account: string;
    readonly legs: number;
    readonly stakedUsd: number;
    readonly keyRatePct: string;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly netDeskImprovementUsd: number;
  }[];
}

export interface KeyNumberBucketRow {
  readonly keyNumber: number | null;
  readonly keyLabel: string;
  readonly fairBreakevenOdds: number;
  readonly configuredShadowOdds: number | null;
  readonly legs: number;
  readonly settledLegs: number;
  readonly winRatePct: number;
  readonly stakedUsd: number;
  readonly actualDeskPnlUsd: number;
  readonly shadowDeskPnlUsd: number;
  readonly netDeltaUsd: number;
}

export interface ElasticityFrontierPoint {
  readonly elasticity: number;
  readonly elasticityPct: number;
  readonly sharpSavingsUsd: number;
  readonly retailNetImpactUsd: number;
  readonly netDeskSavingsUsd: number;
  readonly shadowDeskPnlUsd: number;
}

export interface LadderPresetSummary {
  readonly id: "retail_flat" | "indifference" | "shadow_default" | "house_hold";
  readonly label: string;
  readonly subtitle: string;
  readonly ladderKey3: number;
  readonly ladderKey7: number;
  readonly ladderKey14_21: number;
  readonly sharpSavingsUsd: number;
  readonly retailNetImpactUsd: number;
  readonly netDeskSavingsUsd: number;
}

export interface PolicyRecommendation {
  readonly directive:
    | "TARGETED_LIMITS_AND_ALERTS"
    | "SELECTIVE_KEY_PRICE_FLOOR"
    | "GLOBAL_CATALOG_REPRICE"
    | "PRESERVE_BELL_CURVE_VIG"
    | "DERIVATIVE_AND_LIVE_LOCKOUT";
  readonly headline: string;
  readonly rationale: string;
  readonly recommendedMaxKeyRiskUsd: number;
}

export interface ShadowPricingDashboardPayload {
  readonly provenance: ShadowProvenance;
  readonly sourceLabel: string;
  readonly loadedInMs: number;
  readonly evaluatedInMs: number;
  readonly parameters: {
    readonly ladderKey3: number;
    readonly ladderKey7: number;
    readonly ladderKey14_21: number;
    readonly minVolume: number;
    readonly retailElasticity: number;
    readonly repriceMode: ShadowRepriceMode;
    readonly sport: SportFilter;
    readonly subSport: SubSportFilter;
    readonly period: PeriodFilter;
    readonly market: MarketFilter;
  };
  readonly taxonomy: TaxonomyCubeSummary;
  readonly simulation: ShadowSimulationSummary;
  readonly keyBreakdown: readonly KeyNumberBucketRow[];
  readonly elasticityFrontier: readonly ElasticityFrontierPoint[];
  readonly breakevenElasticityPct: number | null;
  readonly presetComparison: readonly LadderPresetSummary[];
  readonly policyRecommendation: PolicyRecommendation;
}
