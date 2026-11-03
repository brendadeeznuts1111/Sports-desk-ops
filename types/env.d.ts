/**
 * @file env.d.ts
 * @description Bun Environment Variable Type Declarations via Interface Merging.
 *
 * Extends `Bun.Env` and `process.env` with typed SportsDesk & Fantasy402 variables
 * following official Bun environment documentation.
 */

declare module "bun" {
  interface Env {
    // Runtime & Network Configuration
    readonly PORT?: string;
    readonly HOST?: string;
    readonly HOSTNAME?: string;
    readonly NODE_ENV?: "production" | "development" | "test";
    readonly NO_PROXY?: string;
    readonly HTTP_PROXY?: string;
    readonly HTTPS_PROXY?: string;
    readonly ALL_PROXY?: string;
    readonly BUN_CONFIG_MAX_HTTP_REQUESTS?: string;
    readonly BUN_SOCKET?: string;

    // Fantasy402 Portal Gateway
    readonly F402_BASE_URL?: string;
    readonly F402_AGENT_ID?: string;
    /** @deprecated Use secrets:f402 or TTY; only if F402_ALLOW_ENV_CREDENTIALS=1 */
    readonly F402_PASSWORD?: string;
    readonly F402_ALLOW_ENV_CREDENTIALS?: string;
    readonly F402_OFFLINE_ONLY?: string;
    readonly F402_INITIAL_WATERMARK?: string;
    /** `off` | `projected` | `full` — default `off` for getListAgenstByAgent PLAYERS */
    readonly F402_PLAYERS_MODE?: string;
    readonly F402_PROBE_HOST?: string;
    readonly F402_RRO?: string;
    readonly RRO?: string;
    readonly F402_CAPTURE_LOG?: string;
    readonly F402_AUDIT_DB?: string;
    readonly F402_PINNED_MANAGER_BUST?: string;
    /** @deprecated Use F402_WEBVIEW_PROFILE + WebView login or F402_SESSION_FILE. */
    readonly F402_COOKIE?: string;
    readonly F402_WEBVIEW_PROFILE?: string;
    readonly F402_REPLAY_PROXY_URL?: string;
    readonly F402_PORTAL_DRIFT_CRON?: string;
    readonly PRETEST_SKIP?: string;
    readonly DEBUG_TRACE?: string;

    // Cloudflare API & R2 Storage
    readonly CLOUDFLARE_ACCOUNT_ID?: string;
    readonly CLOUDFLARE_API_TOKEN?: string;
    readonly R2_ACCESS_KEY_ID?: string;
    readonly R2_SECRET_ACCESS_KEY?: string;
    readonly R2_ENDPOINT?: string;
    readonly R2_BUCKET_NAME?: string;
    readonly R2_PUBLIC_URL?: string;
    /** Bearer token for the hardened blob/live-bets gateway. */
    readonly BLOB_API_TOKEN?: string;
    /** HMAC secret for short-lived WebSocket tickets. */
    readonly BLOB_TICKET_SECRET?: string;
    readonly BLOB_MAX_UPLOAD_BYTES?: string;
    readonly BLOB_MAX_PIXELS?: string;
    readonly BLOB_PORT?: string;
    readonly BLOB_HEALTH_URL?: string;
    readonly WEBVIEW_HEALTH_URL?: string;

    // Telegram Bot & Mini App Integration
    readonly TELEGRAM_BOT_TOKEN?: string;
    readonly TELEGRAM_BOT_USERNAME?: string;
    readonly TELEGRAM_CHAT_ID?: string;
    readonly TELEGRAM_ADMIN_CHAT_IDS?: string;
    readonly SPORTSDESK_ADMIN_TOKEN?: string;
    readonly TELEGRAM_MINIAPP_URL?: string;
    readonly TELEGRAM_WEBHOOK_URL?: string;
    readonly TELEGRAM_WEBHOOK_SECRET?: string;
    readonly TELEGRAM_ACTIVITY_LOG?: string;
    readonly TELEGRAM_ALERT_THRESHOLD_CENTS?: string;
    readonly TELEGRAM_REPORT_SCHEDULE?: string;
  }
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends Bun.Env {}
  }
}
