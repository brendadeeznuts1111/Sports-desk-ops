export declare const meta: {
  readonly schema: string;
  readonly version: string;
  readonly generated_at: string;
  readonly auto_execute: false;
};

export declare const thresholds: {
  readonly sharp: number;
  readonly elite_sharp_score: number;
  readonly sharp_score: number;
  readonly steam: number;
  readonly clv_alert_bps: number;
  readonly conduit_concentration_pct: number;
  readonly high_risk_wager_usd: number;
};

export declare const leagues: {
  readonly names: readonly string[];
  readonly primary: readonly string[];
  readonly inplay_priority: readonly string[];
};

export declare const api: {
  readonly base: string;
  readonly dashboard: string;
  readonly tiers: string;
  readonly customers: string;
  readonly wagers: string;
  readonly bet_ticker: string;
  readonly r2_pipeline: string;
  readonly dns: string;
  readonly health: string;
  readonly build_matrix: string;
};

export declare const freshness: {
  readonly stale_after_minutes: number;
  readonly critical_after_minutes: number;
  readonly poll_dashboard_seconds: number;
  readonly poll_wagers_seconds: number;
  readonly poll_ticker_seconds: number;
  readonly poll_dns_seconds: number;
};

export declare const panels: {
  readonly default_tab: string;
  readonly customers_page_size: number;
  readonly live_wagers_limit: number;
  readonly ticker_max_rows: number;
  readonly dns_cache_capacity: number;
  readonly dns_warm_hit_rate_pct: number;
  readonly dns_active_hit_rate_pct: number;
};
