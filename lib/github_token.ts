/**
 * @file github_token.ts
 * @description Keychain-backed GitHub token: read it from `Bun.secrets`, ask for it only when it is
 * missing, verify it against `GET /user`, and store it only after GitHub accepts it.
 *
 * This is the "secrets" example from Bun's docs (get -> prompt -> set -> whoami) with three
 * differences the docs example does not have:
 *  - the token is verified before it is stored, so a typo never lands in the keychain;
 *  - a keychain that cannot be read is an error, not "missing" (otherwise the prompt would
 *    overwrite a good entry the OS merely refused to hand over);
 *  - the token is never echoed, logged or put in an error message.
 *
 * Everything takes an injectable store and `fetch`, so tests never touch the real keychain or the
 * network.
 */

import { z } from "zod";

import type { BunSecretSetOptions } from "../types/bun-api.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  getSecretBounded,
  setSecretBounded,
} from "./secrets.ts";
import { secretSetOptions } from "./r2_s3_client.ts";

/** Where the token lives: the repo's canonical keychain service, not the docs' placeholder. */
export const GITHUB_TOKEN_SECRET = {
  service: CANONICAL_SECRETS_SERVICE,
  name: "github-token",
} as const;

export const GITHUB_USER_URL = "https://api.github.com/user";

const REQUEST_TIMEOUT_MS = 10_000;

/** The keychain surface this module needs; `Bun.secrets` satisfies it. */
export interface GithubTokenStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: BunSecretSetOptions): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export type GithubFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export function bunGithubTokenStore(): GithubTokenStore {
  return {
    get: (options) => getSecretBounded(Bun.secrets, options),
    set: async (options) => {
      await setSecretBounded(Bun.secrets, options);
    },
    delete: (options) => Bun.secrets.delete(options),
  };
}

const userSchema = z.object({ login: z.string().min(1) });

export type WhoAmI =
  | { readonly status: "ok"; readonly login: string }
  | { readonly status: "unauthorized" }
  | { readonly status: "error"; readonly message: string };

/** Ask GitHub who owns `token`. Error messages carry a status or error name, never the token. */
export async function whoami(
  token: string,
  fetchImpl: GithubFetch = fetch,
): Promise<WhoAmI> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "sportsdesk-ops",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return { status: "error", message: `GitHub request failed (${name})` };
  }
  if (response.status === 401) return { status: "unauthorized" };
  if (!response.ok) {
    return {
      status: "error",
      message:
        `GitHub answered ${response.status} ${response.statusText}`.trim(),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", message: "GitHub returned a non-JSON body" };
  }
  const parsed = userSchema.safeParse(body);
  return parsed.success
    ? { status: "ok", login: parsed.data.login }
    : { status: "error", message: "GitHub response had no login" };
}

export type LoginResult =
  | {
      readonly status: "ok";
      readonly login: string;
      /** `keychain` = already stored; `new` = just verified and stored. */
      readonly source: "keychain" | "new";
    }
  /** Nothing stored and nothing supplied. */
  | { readonly status: "no-token" }
  /** GitHub rejected the token; `source` says which one (a rejected new token is not stored). */
  | { readonly status: "unauthorized"; readonly source: "keychain" | "new" }
  | { readonly status: "error"; readonly message: string };

export interface LoginDeps {
  readonly store: GithubTokenStore;
  /** Called only when a token has to be asked for; returns `null`/empty when none is available. */
  readonly readNewToken: () => Promise<string | null>;
  readonly fetchImpl?: GithubFetch;
}

async function verifyAndStore(
  token: string,
  deps: LoginDeps,
): Promise<LoginResult> {
  const who = await whoami(token, deps.fetchImpl);
  if (who.status === "unauthorized") {
    return { status: "unauthorized", source: "new" };
  }
  if (who.status === "error") return who;
  try {
    await deps.store.set(
      secretSetOptions(
        GITHUB_TOKEN_SECRET.service,
        GITHUB_TOKEN_SECRET.name,
        token,
      ),
    );
  } catch {
    return { status: "error", message: "keychain refused to store the token" };
  }
  return { status: "ok", login: who.login, source: "new" };
}

async function askForToken(deps: LoginDeps): Promise<string | null> {
  const supplied = (await deps.readNewToken())?.trim() ?? "";
  return supplied === "" ? null : supplied;
}

/**
 * The docs flow. A stored token is verified and used as is; a missing one is asked for, verified,
 * then stored. A stored token GitHub rejects is reported, not silently replaced: use
 * {@link replaceToken} for that.
 */
export async function login(deps: LoginDeps): Promise<LoginResult> {
  let stored: string | null;
  try {
    stored = await deps.store.get(GITHUB_TOKEN_SECRET);
  } catch {
    return { status: "error", message: "keychain is unavailable or locked" };
  }
  const existing = stored?.trim() ?? "";
  if (existing !== "") {
    const who = await whoami(existing, deps.fetchImpl);
    if (who.status === "ok") {
      return { status: "ok", login: who.login, source: "keychain" };
    }
    if (who.status === "unauthorized") {
      return { status: "unauthorized", source: "keychain" };
    }
    return who;
  }
  const fresh = await askForToken(deps);
  if (fresh === null) return { status: "no-token" };
  return verifyAndStore(fresh, deps);
}

/** Ask for a token, verify it and overwrite the stored one; the old entry survives a bad token. */
export async function replaceToken(deps: LoginDeps): Promise<LoginResult> {
  const fresh = await askForToken(deps);
  if (fresh === null) return { status: "no-token" };
  return verifyAndStore(fresh, deps);
}

/** The stored token, or `null` when absent. A locked keychain is an error, not "absent". */
export async function readStoredToken(
  store: GithubTokenStore,
): Promise<
  | { readonly status: "ok"; readonly token: string }
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly message: string }
> {
  try {
    const value = (await store.get(GITHUB_TOKEN_SECRET))?.trim() ?? "";
    return value === "" ? { status: "absent" } : { status: "ok", token: value };
  } catch {
    return { status: "error", message: "keychain is unavailable or locked" };
  }
}
