export declare const meta: {
  readonly schema: string;
  readonly version: string;
  readonly generated_at: string;
  readonly auto_execute: false;
};

export declare const thresholds: {
  readonly clv_hot_cents: number;
  readonly clv_warm_cents: number;
  readonly slice_leader_limit: number;
};

export declare const table: {
  readonly max_rows: number;
  readonly policy_tag: string;
  readonly default_sort_field: string;
  readonly default_sort_dir: string;
};

export declare const alert_tiers: readonly {
  readonly id: string;
  readonly label: string;
  readonly severity: number;
}[];

export declare const sport_filters: readonly {
  readonly id: string;
  readonly label: string;
}[];

export declare const bet_type_filters: readonly {
  readonly id: string;
  readonly label: string;
}[];

export declare const period_filters: readonly {
  readonly id: string;
  readonly label: string;
}[];
