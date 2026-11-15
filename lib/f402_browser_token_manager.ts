/**
 * In-page F402 Manager JWT lifecycle (sessionStorage + authenticateCustomer).
 * Injectable deps so Bun tests can mock fetch/storage/timers without a DOM.
 *
 * Vendor 1.0.287 changed the session shape this module was written against: the portal no
 * longer writes `sessionStorage.credentials`, and `security.js` `verifySession` now refreshes
 * on its own from `sessionStorage.token` (`setInterval(refresh, timeRefresh)` with
 * `timeRefresh: 3e5`). `_remint` cannot work against that shape — see its JSDoc before wiring
 * this module anywhere.
 *
 * @see fantasy402-skills/fantasy402-manager.md (Auth / session)
 */

export const F402_REMINT_MARGIN_MS = 180_000;
export const F402_MIN_SCHEDULE_DELAY_MS = 30_000;
export const F402_AUTH_CHANNEL = "f402-auth";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface F402AuthMetrics {
  mints: number;
  failures: number;
  /** Remaining ms at last successful mint (exp − now), not a measured TTL. */
  lastRemainingMs: number;
}

export interface F402TokenManagerDeps {
  readonly storage: StorageLike;
  readonly fetch: typeof fetch;
  readonly remintUrl?: string;
  readonly now?: () => number;
  readonly schedule?: (
    fn: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly onTokenMinted?: (token: string) => void;
  readonly onRemintError?: (error: unknown) => void;
}

export interface BootstrapPasswordAnswer {
  readonly password: string;
  readonly remember: boolean;
}

/** Decode JWT `exp` (seconds) from unpadded base64url payload. */
export function decodeJwtExp(jwt: string): number | null {
  try {
    let payload = jwt.split(".")[1];
    if (payload === undefined || payload === "") return null;
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const exp = (JSON.parse(atob(payload)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function buildAuthenticateCustomerBody(
  customerID: string,
  password: string,
): Record<string, unknown> {
  return {
    customerID,
    state: true,
    password,
    multiaccount: "1",
    response_type: "code",
    client_id: customerID,
    domain: "fantasy402.com",
    redirect_uri: "fantasy402.com",
    operation: "authenticateCustomer",
    RRO: 1,
  };
}

export class F402TokenManager {
  private inflight: Promise<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly metrics: F402AuthMetrics = {
    mints: 0,
    failures: 0,
    lastRemainingMs: 0,
  };

  constructor(private readonly deps: F402TokenManagerDeps) {}

  async get(force = false): Promise<string> {
    const tok = this.deps.storage.getItem("token");
    const exp =
      tok !== null && tok !== "" && tok !== "0" ? decodeJwtExp(tok) : null;
    const now = this.now();
    const fresh = !force && exp !== null && exp - now > F402_REMINT_MARGIN_MS;
    return fresh && tok !== null ? tok : this.remint();
  }

  remint(): Promise<string> {
    this.inflight ??= this._remint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  schedule(token: string | null): void {
    if (this.timer !== undefined) {
      (this.deps.clearSchedule ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
    if (token === null || token === "" || token === "0") return;
    const exp = decodeJwtExp(token);
    if (exp === null) return;
    const delay = Math.max(
      F402_MIN_SCHEDULE_DELAY_MS,
      exp - this.now() - F402_REMINT_MARGIN_MS,
    );
    const schedule = this.deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = schedule(() => {
      void this.remint().catch((error) => this.deps.onRemintError?.(error));
    }, delay);
  }

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  /**
   * @deprecated The input source this reads from was deleted in vendor 1.0.287.
   *
   * Reads `sessionStorage.credentials.password`, which the vendor stopped writing in 1.0.287.
   * The same release moved `verifySession` onto `sessionStorage.token` and added a 5-minute
   * self-refresh interval (`timeRefresh: 3e5`), so the portal now renews tokens without our help.
   *
   * Two viable futures:
   *   1. Delete `_remint` and rely on the vendor's 5-minute refresh.
   *   2. Feed remint from `persistDurably` (durable store) and stop reading
   *      `sessionStorage.credentials` entirely.
   *
   * NOT viable: adding a reader for the new key. A JWT cannot be re-exchanged for a password,
   * which is what `_remint` was written to do.
   *
   * The existing tests pass against a session shape 1.0.287 no longer produces (they seed
   * `credentials` in memory), so a green suite is not evidence this works against a live
   * 1.0.287 session.
   */
  private async _remint(): Promise<string> {
    const rawCreds = this.deps.storage.getItem("credentials");
    const creds =
      rawCreds === null
        ? null
        : (JSON.parse(rawCreds) as {
            password?: string;
          });
    if (creds?.password === undefined || creds.password === "") {
      throw new Error("NO_CREDENTIALS");
    }
    const customerID = (this.deps.storage.getItem("customerID") ?? "").trim();
    if (customerID === "") throw new Error("NO_CUSTOMER_ID");

    const url = this.deps.remintUrl ?? "/cloud/api/System/authenticateCustomer";
    const res = await this.deps.fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(
        buildAuthenticateCustomerBody(customerID, creds.password),
      ),
    });
    if (!res.ok) {
      this.metrics.failures += 1;
      throw new Error(`REMINT_HTTP_${res.status}`);
    }

    const data = (await res.json()) as { code?: unknown };
    if (typeof data.code !== "string" || data.code.length < 24) {
      this.metrics.failures += 1;
      throw new Error("REMINT_BAD_RESPONSE");
    }

    this.deps.storage.setItem("token", data.code);
    this.metrics.mints += 1;
    const exp = decodeJwtExp(data.code);
    if (exp !== null) this.metrics.lastRemainingMs = exp - this.now();
    this.deps.onTokenMinted?.(data.code);
    this.schedule(data.code);
    return data.code;
  }
}

export class F402CloudflareChallengeError extends Error {
  constructor() {
    super("CF_CHALLENGE");
    this.name = "F402CloudflareChallengeError";
  }
}

export async function f402AuthorizedFetch(
  tokens: F402TokenManager,
  path: string,
  opts: RequestInit = {},
  retried = false,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const token = await tokens.get(retried);
  const res = await fetchImpl(path, {
    ...opts,
    credentials: "include",
    headers: {
      ...(opts.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (res.status === 401 && !retried) {
    return f402AuthorizedFetch(tokens, path, opts, true, fetchImpl);
  }
  if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge") {
    throw new F402CloudflareChallengeError();
  }
  return res;
}

/**
 * Persist a password into `sessionStorage.credentials` so `_remint` has an input.
 *
 * Note (2026-11-13): this re-introduces the persistence class vendor 1.0.287 removed from the
 * portal's own login path — sessionStorage is readable by any same-origin script, which is the
 * property that made the old `credentials` blob worth deleting. It is currently **uncalled**
 * (verified by repo-wide grep); it becomes a finding the moment it is wired.
 *
 * Not covered by tests: `tests/f402_browser_token_manager.test.ts` exercises `F402TokenManager`
 * only, so this path is uncalled, untested, and dormant rather than validated.
 */
export async function bootstrapF402Credentials(
  storage: StorageLike,
  promptPassword: () => Promise<BootstrapPasswordAnswer | null>,
  persistDurably?: (password: string) => Promise<void>,
): Promise<boolean> {
  const raw = storage.getItem("credentials");
  const existing =
    raw === null ? null : (JSON.parse(raw) as { password?: string });
  if (existing?.password !== undefined && existing.password !== "") {
    return true;
  }
  const answer = await promptPassword();
  if (answer === null) return false;
  storage.setItem("credentials", JSON.stringify({ password: answer.password }));
  if (answer.remember && persistDurably !== undefined) {
    await persistDurably(answer.password);
  }
  return true;
}

export function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** Build a minimal JWT-shaped string with `exp` in milliseconds via seconds in payload. */
export function fakeJwtExpiringAt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `hdr.${payload}.sig`;
}
