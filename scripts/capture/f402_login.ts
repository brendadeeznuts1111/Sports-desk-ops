/**
 * @file scripts/capture/f402_login.ts
 * @description Unattended F402 portal login for WebView-driven capture.
 *
 * Credentials: OS keychain (`secrets:f402`), TTY prompt, or an explicit in-memory object in tests.
 * `F402_PASSWORD` in env is not read unless `F402_ALLOW_ENV_CREDENTIALS=1` (deprecated).
 * Selectors are overridable because the portal markup is not contractual; the defaults live in
 * `resolveLoginConfig`.
 *
 * Completion is decided by the login form disappearing, not by a URL change: the portal can redirect
 * to the same path and still be showing the form.
 */

import {
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  MissingF402CredentialsError,
  SECRET_ENTRIES,
  readSecretEntry,
  type F402Credentials,
  type SecretsReader,
} from "../../lib/secrets.ts";
import { guardedSecrets } from "../../lib/keychain_access.ts";
import { resolveLoginConfig, type LoginConfig } from "./ops.ts";

export { MissingF402CredentialsError };
export type { F402Credentials, SecretsReader };

export type F402LoginKind = "agent" | "player";

export interface F402LoginIdentity {
  readonly loginId: string;
  readonly password: string;
  readonly kind: F402LoginKind;
}

type Env = Record<string, string | undefined>;

/**
 * @deprecated Legacy-only service name, kept for back-compat. New reads go through
 * `lib/secrets.ts` (canonical first, legacy fallback); nothing writes here.
 */
export const SECRETS_SERVICE = LEGACY_SECRETS_SERVICE;
export const SECRET_NAMES = F402_KEYCHAIN_NAMES;

/** @see loadF402CredentialsSecure in lib/f402_credentials_policy.ts */
export async function loadF402Credentials(
  env: Env = process.env,
  secrets: SecretsReader | null = guardedSecrets,
): Promise<F402Credentials> {
  const { loadF402CredentialsSecure } =
    await import("../../lib/f402_credentials_policy.ts");
  return loadF402CredentialsSecure(env, secrets);
}

/**
 * Player-tier credentials: canonical-first keychain (`secrets:f402 set-player` writes
 * `f402-player-*` to `com.bookdeskops.sportsdesk`), legacy fallback, then env
 * (`F402_PLAYER_ID` / `F402_PLAYER_PASSWORD`). All-or-nothing per source: a keychain id never
 * pairs with an env password.
 */
export async function loadF402PlayerCredentials(
  env: Env = process.env,
  secrets: SecretsReader | null = guardedSecrets,
): Promise<F402LoginIdentity> {
  if (secrets !== null) {
    const storedId =
      (await readSecretEntry(SECRET_ENTRIES.f402PlayerId, secrets)) ?? "";
    const storedPassword =
      (await readSecretEntry(SECRET_ENTRIES.f402PlayerPassword, secrets)) ?? "";
    if (storedId !== "" && storedPassword !== "") {
      return { loginId: storedId, password: storedPassword, kind: "player" };
    }
  }
  const envId = env["F402_PLAYER_ID"]?.trim() ?? "";
  const envPassword = env["F402_PLAYER_PASSWORD"]?.trim() ?? "";
  if (envId !== "" && envPassword !== "") {
    return { loginId: envId, password: envPassword, kind: "player" };
  }
  throw new MissingF402CredentialsError();
}

export async function loadF402LoginIdentity(
  env: Env = process.env,
  kind: F402LoginKind = "agent",
  secrets: SecretsReader | null = guardedSecrets,
): Promise<F402LoginIdentity> {
  if (kind === "player") {
    return loadF402PlayerCredentials(env, secrets);
  }
  const agent = await loadF402Credentials(env, secrets);
  return { loginId: agent.agentId, password: agent.password, kind: "agent" };
}

/** Tests and callers pass credentials explicitly — not from process env. */
export function resolveF402Credentials(
  credentials?: F402Credentials,
): F402Credentials {
  if (
    credentials !== undefined &&
    credentials.agentId.trim() !== "" &&
    credentials.password.trim() !== ""
  ) {
    return {
      agentId: credentials.agentId.trim(),
      password: credentials.password,
    };
  }
  throw new MissingF402CredentialsError();
}

/** The subset of `ManagedWebView` a submit needs; shared with `evidence_capture`. */
export interface LoginSubmitView {
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  press(key: string): Promise<void>;
}

/** The subset of `ManagedWebView` the login needs; lets tests inject a stub. */
export interface LoginView extends LoginSubmitView {
  navigate(
    url: string,
    options?: { allowOpaqueUrl?: boolean; timeoutMs?: number },
  ): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
}

export interface LoginOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly hydrationMs?: number;
  readonly pollMs?: number;
  readonly env?: Env;
  readonly credentials?: F402Credentials;
  readonly loginKind?: F402LoginKind;
  readonly loginIdentity?: F402LoginIdentity;
  readonly beforeSubmitExpression?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LoginOutcome {
  readonly loginUrl: string;
  readonly usedSubmitButton: boolean;
  readonly agentId: string;
  readonly loginKind: F402LoginKind;
}

const PASSWORD_GONE =
  '(() => document.querySelector("input[type=password]") === null)()';

/**
 * Ask the page to submit its own form. `requestSubmit` runs the bound submit
 * handler, so a hydrated SPA login sees the click path; a bare `press("Enter")`
 * does not work on a button-less form (implicit submission needs a submitter)
 * and WebKit dispatches no keydown at all for Enter.
 *
 * The form is derived from the password field (a portal page can carry an
 * unrelated `form`), and `checkValidity()` is consulted because `requestSubmit()`
 * returns `true` even when constraint validation blocked submission — that would
 * otherwise skip the click+Enter fallback.
 */
export const REQUEST_SUBMIT_EXPRESSION =
  '(() => { const p = document.querySelector("input[type=password]"); const f = p && p.form ? p.form : document.querySelector("form"); if (!f || typeof f.requestSubmit !== "function") return false; if (typeof f.checkValidity === "function" && !f.checkValidity()) return false; f.requestSubmit(); return true; })()';

/**
 * Submit the login form once both fields are filled.
 *
 * A present submit button is clicked. Without one, `requestSubmit()` is tried
 * before any key press; only when the page has no usable form do we focus the
 * password field and press Enter (which leaves the outcome to the page).
 */
export async function submitLoginForm(
  view: LoginSubmitView,
  login: Pick<LoginConfig, "submitSelector" | "passSelector">,
  hasSubmit: boolean,
): Promise<void> {
  if (hasSubmit) {
    await view.click(login.submitSelector);
    return;
  }
  const submitted = await view.evaluate(REQUEST_SUBMIT_EXPRESSION);
  if (submitted === true) return;
  await view.click(login.passSelector);
  await view.press("Enter");
}

export async function loginF402(
  view: LoginView,
  options: LoginOptions = {},
): Promise<LoginOutcome> {
  const env = options.env ?? process.env;
  const loginKind = options.loginKind ?? "agent";
  const identity =
    options.loginIdentity ??
    (options.credentials !== undefined
      ? {
          loginId: options.credentials.agentId,
          password: options.credentials.password,
          kind: loginKind,
        }
      : await loadF402LoginIdentity(env, loginKind));
  const baseUrl = (
    options.baseUrl ??
    env["F402_BASE_URL"]?.trim() ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const hydrationMs =
    options.hydrationMs ?? Number(env["F402_LOGIN_HYDRATION_MS"] ?? "1500");
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  const login = resolveLoginConfig(env as Env, baseUrl);
  await view.navigate(login.loginUrl, { allowOpaqueUrl: true, timeoutMs });
  await view.waitForSelector(login.userSelector, { timeoutMs });
  await sleep(Number.isFinite(hydrationMs) ? Math.max(0, hydrationMs) : 1500);

  if (options.beforeSubmitExpression) {
    await view.evaluate(options.beforeSubmitExpression);
  }

  const hasSubmit =
    (await view.evaluate(
      `(() => document.querySelector(${JSON.stringify(login.submitSelector)}) !== null)()`,
    )) === true;

  await view.fill(login.userSelector, identity.loginId);
  await view.fill(login.passSelector, identity.password);
  await submitLoginForm(view, login, hasSubmit);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await view.evaluate(PASSWORD_GONE)) === true) {
      return {
        loginUrl: login.loginUrl,
        usedSubmitButton: hasSubmit,
        agentId: identity.kind === "agent" ? identity.loginId : "",
        loginKind: identity.kind,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "F402 login did not complete: password field still present",
      );
    }
    await sleep(pollMs);
  }
}
