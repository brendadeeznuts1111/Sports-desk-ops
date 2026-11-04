/**
 * F402 login credentials — never from shell env by default (no ps/history inheritance).
 *
 * **Bun 1.4.4 exposes `Bun.secrets`.** `Bun.password` is bcrypt/argon2 *hashing*, not secret
 * storage — do not use it for capture credentials. This module reads through `Bun.secrets`
 * (canonical-first) and keeps a macOS `security` fallback when no reader is injected.
 *
 * **Child-process rules (the only places a plaintext password crosses a process boundary):**
 * 1. **Keychain read** — canonical service (`com.bookdeskops.sportsdesk`) then the legacy
 *    `sportsdesk-ops` fallback. The macOS path shells to `Bun.spawn(["security",
 *    "find-generic-password",…])` with an **argv array** (no shell) and an explicit minimal
 *    environment allowlist (`buildMinimalSpawnEnv()`), and fails closed on a 1s timeout so a
 *    locked Keychain cannot hang a daemon. Never `Bun.$` — interpolation routes bytes through a
 *    shell parser. When a reader is injected (`Bun.secrets` by default, a fake in tests) only that
 *    reader is used.
 * 2. **TTY hidden read** — no native no-echo on `Bun.stdin`; uses `Bun.spawn(["bash","-c",
 *    "read -rs …"])` with stdin inherited from the TTY and `env: buildMinimalSpawnEnv()`.
 * 3. **Keychain store** (`secrets:f402 set`) — password only via **stdin**; the macOS write path
 *    may use `security add-generic-password -w` and remains the sole argv-leak surface on store.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  MissingF402CredentialsError,
  type F402Credentials,
  type SecretsReader,
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
  const home = Bun.env.HOME ?? "/Users/nolarose";
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
 * A locked Keychain (or an item whose ACL wants an interactive consent dialog) makes
 * `security -w` block forever — a daemon or a test has no one to click Allow. Fail closed fast.
 */
const PLATFORM_KEYCHAIN_TIMEOUT_MS = 1_000;

async function readMacOsKeychainValue(
  service: string,
  account: string,
): Promise<string> {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
    { stdout: "pipe", stderr: "pipe", env: buildMinimalSpawnEnv() },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PLATFORM_KEYCHAIN_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([proc.exited, timedOut]);
    if (result === "timeout") {
      proc.kill();
      await proc.exited.catch(() => undefined);
      return "";
    }
    if (result !== 0) return "";
    return (await new Response(proc.stdout).text()).trim();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** macOS fallback: try the canonical service, then the legacy one. */
async function readKeychainViaPlatform(account: string): Promise<string> {
  if (process.platform !== "darwin") return "";
  for (const service of KEYCHAIN_SERVICES) {
    const value = await readMacOsKeychainValue(service, account);
    if (value !== "") return value;
  }
  return "";
}

/**
 * Keychain read with one injected reader (production: `Bun.secrets`, tests: a fake). The reader
 * is asked canonical-first then legacy, matching `lib/secrets.ts`. The macOS `security` CLI is
 * the fallback only when the caller supplied no reader at all (`null`), so a fake store stays
 * deterministic and never depends on the machine's real keychain.
 */
async function readKeychain(
  secrets: SecretsReader | null,
  name: string,
): Promise<string> {
  if (secrets === null) return readKeychainViaPlatform(name);
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
  const bytes = await new Response(proc.stdout).arrayBuffer();
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
 * Keychain → TTY → (deprecated) env when F402_ALLOW_ENV_CREDENTIALS=1.
 * Never reads F402_PASSWORD from env otherwise.
 */
export async function loadF402CredentialsSecure(
  env: Env = Bun.env,
  secrets: SecretsReader | null = Bun.secrets,
): Promise<SecureF402Credentials> {
  const agentId = await readKeychain(secrets, F402_KEYCHAIN_NAMES.agentId);
  const password = await readKeychain(secrets, F402_KEYCHAIN_NAMES.password);
  if (agentId !== "" && password !== "") {
    return wrapF402Credentials({ agentId, password }, "keychain");
  }

  if (input.isTTY) {
    return promptF402CredentialsTTY();
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

  throw new MissingF402CredentialsError();
}

export const F402_PROFILE_BOOTSTRAP_HINT =
  "Bootstrap: sign in once in Chrome WebView with --profile (MFA/CAPTCHA may require manual login), then re-run without --login. Store refresh credentials with `bun run secrets:f402 set`.";
