import rows from "./demo-customers.json";

/**
 * Demo customer rows — synthetic fixtures, not observations.
 *
 * The surface was a mixed fixture until #283: four `SYNTH_*` rows beside two desk accounts, rendered
 * identically. The real accounts are gone, and this file is the single source for both the rows and
 * the count the copy states — a number in prose and a number in data drift apart, so the copy
 * interpolates `DEMO_CUSTOMER_COUNT` instead of restating it.
 *
 * `scripts/check_demo_fixture.ts` gates the invariant: every id is `SYNTH_*`, only permitted keys
 * appear, and the row count equals the constant below.
 */
export interface DemoCustomerRow {
  readonly customer_id: string;
  readonly agent_id?: string;
  readonly status?: string;
  readonly wager_limit_usd?: number;
  readonly delay_seconds?: number;
  readonly clv_bps?: number;
  readonly sharp_score?: number;
  readonly hold_pct?: number;
  readonly lifetime_volume_usd?: number;
  readonly lifetime_net_usd?: number;
}

export const DEMO_CUSTOMERS: readonly DemoCustomerRow[] =
  rows as readonly DemoCustomerRow[];

/**
 * The one number the copy may state, as a LITERAL on purpose.
 *
 * Deriving it (`DEMO_CUSTOMERS.length`) made the gate vacuous: the fixture and the count came from
 * the same file, so removing a row changed both sides and the count check could never fail. A
 * literal means the fixture and the claim must be changed together, deliberately — which is what a
 * claim is.
 */
export const DEMO_CUSTOMER_COUNT = 4 as const;
