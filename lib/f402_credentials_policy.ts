/**
 * F402 login credentials — never from shell env by default (no ps/history inheritance).
 *
 * Bun 1.4+ provides native OS credential storage via `Bun.secrets` (`com.bookdeskops.sportsdesk`
 * canonical service with legacy `sportsdesk-ops` read fallback). This module accesses credentials
 * via `Bun.secrets` or injected test readers.
 *
 * **Child-process rules (the only places a plaintext password crosses a process boundary):**
 * 1. **TTY hidden read** — no native no-echo on `Bun.stdin`; uses `Bun.spawn(["bash","-c",
 *    "read -rs …"])` with stdin inherited from the TTY and `env: buildMinimalSpawnEnv()`.
 * 2. **Keychain store** (`secrets:f402 set`) — password only via **stdin**; the macOS write path
 *    may use `security add-generic-password -w` and remains the sole argv-leak surface on store.
 */

import * as readline from "node:readline/promises";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";

import {
  MissingF402CredentialsError,
  SECRET_NAMES,
  type F402Credentials,
  type SecretsReader,
} from "../scripts/capture/f402_login.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
} from "./secrets.ts";

/**
 * @deprecated Legacy-only service name, kept for back-compat. Reads now go canonical-first
 * (`CANONICAL_SECRETS_SERVICE`) with this as the fallback; nothing new should read only here.
 */
export const SECRETS_SERVICE = LEGACY_SECRETS_SERVICE;

/** Read order for every keychain lookup: canonical service first, then the pre-migration one. */
const KEYCHAIN_SERVICES = [
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
] as const;

export const DEPRECATED_ENV_CREDENTIALS_FLAG = "F402_ALLOW_ENV_CREDENTIALS";

export type F402CredentialSource =
  "keychain" | "tty" | "deprecated-env" | "injected";

export type SecureF402Credentials = F402Credentials & {
  readonly credentialSource: F402CredentialSource;
};

type Env = Record<string, string | undefined>;

/**
 * Explicit minimal child-process environment allowlist (`GATE-SEC-01`).
 * Prevents spawned child processes from inheriting `Bun.spawn`'s launch-time `process.env` snapshot.
 */
export function buildMinimalSpawnEnv(
  extraAllowed?: Readonly<Record<string, string>>,
): Record<string, string> {
  // Never a hard-coded operator home: a VPS/CI child would get a path that does not exist.
  const home = Bun.env.HOME ?? homedir();
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    OP_CONFIG_DIR: `${home}/.config/op`,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    ...extraAllowed,
  };
}

function warnDeprecatedEnvCredentials(): void {
  console.warn(
    `[deprecated] ${DEPRECATED_ENV_CREDENTIALS_FLAG}=1 — remove F402_PASSWORD from env; use OS keychain (secrets:f402) or TTY prompt`,
  );
}

/** Inspect-safe wrapper; `#password` is omitted from `Bun.inspect`. */
export class SecureF402CredentialHandle implements SecureF402Credentials {
  readonly agentId: string;
  readonly credentialSource: F402CredentialSource;
  #password: string;

  constructor(creds: F402Credentials, source: F402CredentialSource) {
    this.agentId = creds.agentId;
    this.#password = creds.password;
    this.credentialSource = source;
  }

  get password(): string {
    return this.#password;
  }

  [Bun.inspect.custom](): { readonly source: F402CredentialSource } {
    return { source: this.credentialSource };
  }
}

export function wrapF402Credentials(
  creds: F402Credentials,
  source: F402CredentialSource,
): SecureF402Credentials {
  return new SecureF402CredentialHandle(creds, source);
}

/**
 * Keychain read with one injected reader (production: `Bun.secrets`, tests: a fake or `null`).
 * The reader is asked canonical-first then legacy, matching `lib/secrets.ts`. Explicit `null`
 * or an omitted reader disables keychain lookup completely so tests remain deterministic and
 * never touch the real keychain.
 */
async function readKeychain(
  secrets: SecretsReader | null | undefined,
  name: string,
): Promise<string> {
  if (!secrets) return "";
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const value = (await secrets.get({ service, name }))?.trim() ?? "";
      if (value !== "") return value;
    } catch {
      // Locked/unavailable keychain: fall through to the next service.
    }
  }
  return "";
}

/**
 * Hidden password via TTY — see module header (spawn bash read -rs; no Bun stdin no-echo API).
 */
async function readPasswordHidden(): Promise<string> {
  output.write("F402 password (hidden): ");
  const proc = Bun.spawn(
    ["bash", "-c", 'read -rs _P < /dev/tty && printf "%s" "$_P"'],
    {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
      env: buildMinimalSpawnEnv(),
    },
  );
  const bytes = await Bun.readableStreamToArrayBuffer(proc.stdout);
  await proc.exited;
  output.write("\n");
  return new TextDecoder().decode(bytes);
}

export async function promptF402CredentialsTTY(): Promise<SecureF402Credentials> {
  if (!input.isTTY) {
    throw new MissingF402CredentialsError();
  }
  const rl = readline.createInterface({ input, output });
  let agentId = "";
  try {
    agentId = (await rl.question("F402 agent ID: ")).trim();
  } finally {
    rl.close();
  }
  const password = await readPasswordHidden();
  if (agentId === "" || password === "") {
    throw new MissingF402CredentialsError();
  }
  return wrapF402Credentials({ agentId, password }, "tty");
}

/**
 * Keychain → (deprecated) env when F402_ALLOW_ENV_CREDENTIALS=1 → interactive TTY prompt.
 *
 * Callers:
 * - `scripts/evidence_capture.ts` (`authenticateWithWebView`): omits `secrets` (defaults to `Bun.secrets`);
 *   expects stored keychain credentials or explicit opt-in env credentials without hanging on TTY.
 * - `scripts/capture/f402_login.ts` (`loadF402Credentials`): omits `secrets` (defaults to `Bun.secrets`);
 *   interactive operators without stored keychain or env credentials fall through to `promptF402CredentialsTTY`.
 * - Test suites (`lib/f402_credentials_policy.test.ts`, `tests/f402_login.test.ts`): pass `secrets = null`
 *   to guarantee test isolation from the host keychain and prevent CLI/TTY prompt stalls.
 */
export async function loadF402CredentialsSecure(
  env: Env = Bun.env,
  secrets: SecretsReader | null = Bun.secrets,
): Promise<SecureF402Credentials> {
  const agentId = await readKeychain(secrets, SECRET_NAMES.agentId);
  const password = await readKeychain(secrets, SECRET_NAMES.password);
  if (agentId !== "" && password !== "") {
    return wrapF402Credentials({ agentId, password }, "keychain");
  }

  if (env[DEPRECATED_ENV_CREDENTIALS_FLAG]?.trim() === "1") {
    const envAgent = env["F402_AGENT_ID"]?.trim() ?? "";
    const envPassword = env["F402_PASSWORD"]?.trim() ?? "";
    if (envAgent !== "" && envPassword !== "") {
      warnDeprecatedEnvCredentials();
      return wrapF402Credentials(
        { agentId: envAgent, password: envPassword },
        "deprecated-env",
      );
    }
  }

  if (input.isTTY) {
    return promptF402CredentialsTTY();
  }

  throw new MissingF402CredentialsError();
}

export const F402_PROFILE_BOOTSTRAP_HINT =
  "Bootstrap: sign in once in Chrome WebView with --profile (MFA/CAPTCHA may require manual login), then re-run without --login. Store refresh credentials with `bun run secrets:f402 set`.";
