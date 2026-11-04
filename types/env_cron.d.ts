/**
 * @file env_cron.d.ts
 * @description Environment overrides for the cron entry points.
 *
 * Kept apart from `env.d.ts` so the cron wiring can land without touching the
 * shared environment declarations: the same `Bun.Env` interface merges, and each
 * name here is read by `scripts/live_positions_cron.ts`.
 */

declare module "bun" {
  interface Env {
    /** Live bet-ticker JSONL to read; defaults to the maintainer's probe artifact. */
    readonly F402_BETS_JSONL?: string;
    /** Customer lifetime CSV used for the DOD spine enrichment. */
    readonly F402_LIFETIME_CSV?: string;
    /** Cron expression override for the positions pulse. */
    readonly POSITIONS_CRON?: string;
    /** IANA timezone override for the positions pulse. */
    readonly POSITIONS_CRON_TZ?: string;
  }
}
