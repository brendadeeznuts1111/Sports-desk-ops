/**
 * The single list of every secret the repo reads: what it is called in the environment, where it
 * lives in the keychain, which `dx exec --with` group carries it, and whether that command may
 * inject it. `lib/secret_env.ts`, `scripts/secrets_env.ts` and `scripts/audit_secrets.ts` all derive
 * from this file, so a name added here shows up in status, injection and the audit at once.
 *
 * Naming (see AGENTS.md): environment variables are `UPPER_SNAKE_CASE` following
 * `<SYSTEM>_<NOUN>_<KIND>`; names a tool fixes (wrangler, the S3 SDK, Telegram) stay as they are.
 * Keychain entries use the same name as the variable, except F402, whose scripts store
 * `f402-agent-id` / `f402-password` (kebab-case) and read them themselves. Service is always
 * `com.bookdeskops.sportsdesk`; `sportsdesk-ops` is read only as a legacy fallback in
 * `lib/secrets.ts`.
 *
 * Optional vs required lives in `types/env.d.ts` (`readonly NAME?: string`): a secret that is
 * required only when its feature runs cannot be expressed there, so this file does not claim it.
 */

export type SecretGroup =
  | "r2"
  | "pages"
  | "blob"
  | "gslive"
  | "daemon"
  | "telegram"
  | "f402"
  | "db"
  | "deploy";

export interface SecretDefinition {
  /** The variable; a typo here fails `tsc` because it must be a key of `types/env.d.ts`. */
  readonly envName: keyof Bun.Env;
  /** Keychain entry name, or `null` when the value is environment-only (never stored). */
  readonly keychainName: string | null;
  /** `dx exec --with <group>` groups; a name may belong to more than one. */
  readonly groups: readonly SecretGroup[];
  /**
   * May `dx exec --with` put it in a child's environment? `false` for credentials whose scripts
   * read the keychain themselves, so injecting them would undo their policy gate.
   */
  readonly inject: boolean;
  /** Pre-rename names, still read and never written. */
  readonly aliases?: readonly string[];
  readonly description: string;
}

export const SECRET_MANIFEST: readonly SecretDefinition[] = [
  {
    envName: "R2_ACCESS_KEY_ID",
    keychainName: "R2_ACCESS_KEY_ID",
    groups: ["r2"],
    inject: true,
    description: "R2 S3-compatible access key id (the S3 SDK fixes the name)",
  },
  {
    envName: "R2_SECRET_ACCESS_KEY",
    keychainName: "R2_SECRET_ACCESS_KEY",
    groups: ["r2"],
    inject: true,
    description: "R2 S3-compatible secret key",
  },
  {
    envName: "R2_BUCKET_NAME",
    keychainName: "R2_BUCKET_NAME",
    groups: ["r2"],
    inject: true,
    description: "Target R2 bucket",
  },
  {
    envName: "CLOUDFLARE_ACCOUNT_ID",
    keychainName: "CLOUDFLARE_ACCOUNT_ID",
    groups: ["r2", "pages"],
    inject: true,
    description: "Cloudflare account id: R2 endpoint host and the Pages target",
  },
  {
    envName: "CLOUDFLARE_API_TOKEN",
    keychainName: "CLOUDFLARE_API_TOKEN",
    groups: ["pages"],
    inject: true,
    description:
      "Pages-scoped token for `wrangler pages deploy` (wrangler fixes the name)",
  },
  {
    envName: "BLOB_API_TOKEN",
    keychainName: "BLOB_API_TOKEN",
    groups: ["blob"],
    inject: true,
    description: "Blob gateway bearer token",
  },
  {
    envName: "BLOB_TICKET_SECRET",
    keychainName: "BLOB_TICKET_SECRET",
    groups: ["blob"],
    inject: true,
    description: "HMAC key for signed blob and websocket tickets",
  },
  {
    envName: "GSLIVE_SESSION_ID",
    keychainName: "GSLIVE_SESSION_ID",
    groups: ["gslive"],
    inject: true,
    aliases: ["GSID"],
    description: "Manager Tools session id; sent as the `GSID` cookie",
  },
  {
    envName: "SPORTSDESK_ADMIN_TOKEN",
    keychainName: "SPORTSDESK_ADMIN_TOKEN",
    groups: ["daemon"],
    inject: true,
    description: "Bearer token for the daemon's admin-guarded routes",
  },
  {
    envName: "TELEGRAM_BOT_TOKEN",
    keychainName: "TELEGRAM_BOT_TOKEN",
    groups: ["telegram"],
    inject: true,
    description: "Telegram Bot API token (Telegram fixes the name)",
  },
  {
    envName: "TELEGRAM_WEBHOOK_SECRET",
    keychainName: "TELEGRAM_WEBHOOK_SECRET",
    groups: ["telegram"],
    inject: true,
    description: "Secret the Telegram webhook must present",
  },
  {
    envName: "TELEGRAM_CHAT_ID",
    keychainName: "TELEGRAM_CHAT_ID",
    groups: ["telegram"],
    inject: true,
    description:
      "Numeric destination chat the bot defaults to (also the first entry of TELEGRAM_ADMIN_CHAT_IDS)",
  },
  {
    envName: "TELEGRAM_WEBHOOK_URL",
    keychainName: "TELEGRAM_WEBHOOK_URL",
    groups: ["telegram"],
    inject: true,
    description:
      "Public https URL Telegram POSTs updates to; setWebhook refuses without a secret",
  },
  {
    envName: "TELEGRAM_MINIAPP_URL",
    keychainName: "TELEGRAM_MINIAPP_URL",
    groups: ["telegram"],
    inject: true,
    description:
      "Public https URL of the Mini App served at /miniapp (also used as a deep-link base)",
  },
  {
    envName: "F402_AGENT_ID",
    keychainName: "f402-agent-id",
    groups: ["f402"],
    inject: false,
    description:
      "Fantasy402 agent login; the F402 scripts read the keychain themselves",
  },
  {
    envName: "F402_PASSWORD",
    keychainName: "f402-password",
    groups: ["f402"],
    inject: false,
    description:
      "Fantasy402 portal password; env use needs F402_ALLOW_ENV_CREDENTIALS=1",
  },
  {
    envName: "F402_BEARER_TOKEN",
    keychainName: null,
    groups: ["f402"],
    inject: false,
    description: "Minted Fantasy402 JWT; environment only, never stored",
  },
  {
    envName: "F402_COOKIE",
    keychainName: null,
    groups: ["f402"],
    inject: false,
    description:
      "Deprecated Fantasy402 cookie; use the WebView profile or a session file",
  },
  {
    envName: "GS_SESSION",
    keychainName: "GSLIVE_GANCHROW_SESSION",
    groups: ["gslive"],
    inject: false,
    description:
      "Optional second gate for GSLive ajax.php, sent as `x-gs-session`",
  },
  {
    envName: "GSID_COOKIE",
    keychainName: null,
    groups: ["gslive"],
    inject: false,
    description:
      "A full `GSID=...` cookie header, or a bare id; wins over the keychain",
  },
  {
    envName: "CLOUDFLARE_R2_API_TOKEN",
    keychainName: null,
    groups: ["r2"],
    inject: false,
    description: "Cloudflare API token whose SHA-256 derives the R2 S3 secret",
  },
  {
    envName: "PGPASSWORD",
    keychainName: "SPORTSDESK_PGPASSWORD",
    groups: ["db"],
    inject: true,
    description:
      "PostgreSQL operator database password for migrations and user store",
  },
  {
    envName: "TRUST_PROXY",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "When 1, trust x-forwarded-for and x-real-ip headers for client rate limiting",
  },
  {
    envName: "SPORTSDESK_AUTH_REQUIRED",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "When 1 in development, enforce operator session authentication across data APIs",
  },
  {
    envName: "SPORTSDESK_AUTH_DISABLED",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "When 1 in production, explicitly disable operator session authentication",
  },
  {
    envName: "SPORTSDESK_CSRF_SECRET",
    keychainName: null,
    groups: ["db", "deploy"],
    inject: false,
    description:
      "Shared secret for native Bun.CSRF token issuance across processes",
  },
  {
    envName: "SPORTSDESK_AUDIT_DIR",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "Directory path for append-only JSONL audit logs (default: audit)",
  },
  {
    envName: "SPORTSDESK_AUDIT_MAX_BYTES",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "Maximum file size in bytes before rotating audit logs (default: 52428800)",
  },
  {
    envName: "SPORTSDESK_AUDIT_RETENTION_DAYS",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "Retention window in days for retaining daily audit logs (default: 90)",
  },
  {
    envName: "SPORTSDESK_ALERT_MAX_ATTEMPTS",
    keychainName: null,
    groups: ["deploy"],
    inject: false,
    description:
      "Maximum retry attempts before dead-lettering a surveillance alert (default: 5)",
  },
];

/** Allowed `--with` groups, in manifest order. */
export const SECRET_GROUPS: readonly SecretGroup[] = [
  ...new Set(SECRET_MANIFEST.flatMap((secret) => secret.groups)),
];

export function getSecretsForGroup(
  group: SecretGroup,
): readonly SecretDefinition[] {
  return SECRET_MANIFEST.filter((secret) => secret.groups.includes(group));
}

/** Every name the manifest can account for: variable, alias or keychain entry. */
export function manifestNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const secret of SECRET_MANIFEST) {
    names.add(secret.envName);
    for (const alias of secret.aliases ?? []) names.add(alias);
  }
  return names;
}

/**
 * Secret-shaped names that are not credentials, each with the reason. A name ending in a "soft"
 * suffix (`_KEY`, `_KEY_ID`, `_ID`) that is not in the manifest must be listed here, with why it is
 * safe to print. "Hard" suffixes (`_TOKEN`, `_SECRET`, ...) can never be allowlisted: register them.
 */
export const NON_SECRET_ALLOWLIST: Readonly<Record<string, string>> = {
  ANTIGRAVITY_CONVERSATION_ID:
    "agent session conversation identifier for brain artifact sync",
  F402_CUSTOMER_ID: "customer identifier sent in request URLs, not a login",
  F402_GRAPH_ROOT_AGENT_ID: "root node id of the agent tree, a query parameter",
  F402_MASTER_ID:
    "master node id of the agent tree (defaults to MASTER1), a query parameter",
  SPORTSDESK_INGESTION_R2_KEY:
    "R2 object key (a path, default ingestion-audit.jsonl)",
};
