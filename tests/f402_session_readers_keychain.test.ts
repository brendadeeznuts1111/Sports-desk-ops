/**
 * Q001 follow-up: every F402 session reader works with `F402_SESSION_STORE=keychain`, and the
 * keychain catch-alls in lib/secrets.ts and lib/f402_credentials_policy.ts go through the named
 * error map. All keychain access here is an in-memory adapter (`setSecretsAdapterForTests` /
 * `setSecretsProviderForTests`); the host keychain, Fantasy402 and the real session file are
 * never touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIDGE_ROLLUP_JOBS,
  keychainCredentialProbe,
  type BridgeRollupJobId,
} from "../lib/bridge_rollup_cron.ts";
import { buildDeskEnhancedHealth } from "../lib/desk_enhanced_health.ts";
import { loadF402CredentialsSecure } from "../lib/f402_credentials_policy.ts";
import { fetchIncomingBets } from "../lib/f402_incoming_bets.ts";
import { fetchLivePending } from "../lib/f402_live_pending.ts";
import { fetchLiveBetTicker } from "../lib/f402_live_ticker.ts";
import {
  F402PendingFetchError,
  f402BearerResolvableAsync,
  resolveF402BearerTokenDetailed,
  resolveF402BearerTokenDetailedAsync,
} from "../lib/f402_pending_fetch.ts";
import { cookieHeaderFromEnv } from "../lib/f402_replay_transport.ts";
import type { F402ReplayTransport } from "../lib/f402_replay_transport.ts";
import { fetchReportPlayerAnalysis } from "../lib/f402_report_player_analysis.ts";
import {
  F402KeychainUnavailable,
  F402SecretAccessDenied,
  F402SecretBackendError,
  F402SecretInteractionRequired,
  setSecretsAdapterForTests,
  type SecretsAdapter,
} from "../lib/f402_secret_store.ts";
import {
  F402_SESSION_SECRET_NAME,
  F402SessionStoreConfigError,
  readF402Session,
  readF402SessionForReader,
  resetF402SessionCacheForTests,
  sessionFromAuth,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";
import type { GsliveSessionHealth } from "../lib/gslive_session_health.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  KeychainTimeoutError,
  LEGACY_SECRETS_SERVICE,
  readSecretOrNull,
  readSecretWithSource,
  setSecretsProviderForTests,
} from "../lib/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "f402-readers-keychain-"));
const MISSING_SESSION_FILE = join(dir, "no-such-session.json");

const BEARER = "Bearer q001-opaque-bearer-token-unit-only-0001";
const session: F402Session = sessionFromAuth(
  {
    cookieHeader: "ASP.NET_SessionId=q001-reader-cookie",
    cookieNames: ["ASP.NET_SessionId"],
    authorizationHeader: BEARER,
  },
  { ttlMinutes: 60 },
);
const cookieOnly: F402Session = sessionFromAuth(
  {
    cookieHeader: "ASP.NET_SessionId=q001-reader-cookie",
    cookieNames: ["ASP.NET_SessionId"],
  },
  { ttlMinutes: 60 },
);
const SESSION_KEY = `${CANONICAL_SECRETS_SERVICE}/${F402_SESSION_SECRET_NAME}`;

const unavailableError = () =>
  Object.assign(new Error("Cannot autolaunch D-Bus without X11 $DISPLAY"), {
    code: "ERR_SECRETS_PLATFORM_ERROR",
  });
const deniedError = () =>
  Object.assign(new Error("User interaction is not allowed. (code: -25308)"), {
    code: "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
  });

function memoryStore(
  entries: Record<string, string> = {},
  throwOnGet?: () => unknown,
): SecretsAdapter & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(options) {
      calls.push(`get ${options.service}/${options.name}`);
      if (throwOnGet !== undefined) throw throwOnGet();
      return entries[`${options.service}/${options.name}`] ?? null;
    },
    async set(options) {
      calls.push(`set ${options.service}/${options.name}`);
      entries[`${options.service}/${options.name}`] = options.value;
    },
    async delete(options) {
      calls.push(`delete ${options.service}/${options.name}`);
      const key = `${options.service}/${options.name}`;
      const had = key in entries;
      delete entries[key];
      return had;
    },
  };
}

const ENV_KEYS = [
  "F402_SESSION_STORE",
  "F402_SESSION_FILE",
  "F402_REPLAY_PROXY_URL",
  "F402_AGENT_ID",
  "F402_BEARER_TOKEN",
  "F402_TOKEN_FILE",
  "F402_COOKIE",
  "XDG_CONFIG_HOME",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function useStore(mode: "keychain" | "file", store: SecretsAdapter): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.F402_SESSION_FILE = MISSING_SESSION_FILE;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  if (mode === "keychain") process.env.F402_SESSION_STORE = "keychain";
  setSecretsAdapterForTests(store);
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setSecretsAdapterForTests(null);
  setSecretsProviderForTests(null);
  resetF402SessionCacheForTests();
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function recordingFetch(body: unknown = { LIST: [] }) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: new Headers(init?.headers) });
    return Response.json(body);
  };
  return { requests, fetchImpl };
}

describe("readF402SessionForReader", () => {
  test("file store: same answer as readF402Session and the keychain is never asked", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    const path = join(dir, "session-file.json");
    writeF402Session(session, { path });
    const read = await readF402SessionForReader({ path });
    expect(read).toEqual({ ok: true, session: readF402Session({ path }) });
    expect(read.ok && read.session?.cookieHeader).toBe(session.cookieHeader);
    expect(await readF402SessionForReader()).toEqual({
      ok: true,
      session: null,
    });
    expect(store.calls).toEqual([]);
  });

  test("keychain store: loads the entry; a store error is returned by name, not thrown", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const read = await readF402SessionForReader();
    expect(read.ok && read.session?.cookieHeader).toBe(session.cookieHeader);

    useStore("keychain", memoryStore({}, unavailableError));
    const failed = await readF402SessionForReader();
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBeInstanceOf(F402KeychainUnavailable);
      expect(failed.error.bunCode).toBe("ERR_SECRETS_PLATFORM_ERROR");
    }

    useStore("keychain", memoryStore({}, deniedError));
    const denied = await readF402SessionForReader();
    expect(!denied.ok && denied.error).toBeInstanceOf(
      F402SecretInteractionRequired,
    );
  });

  test("an invalid F402_SESSION_STORE still throws", async () => {
    useStore("file", memoryStore());
    process.env.F402_SESSION_STORE = "keyring";
    await expect(readF402SessionForReader()).rejects.toBeInstanceOf(
      F402SessionStoreConfigError,
    );
  });
});

describe("fetchLiveBetTicker (lib/f402_live_ticker.ts)", () => {
  test("keychain store: the loaded session's cookie and bearer go on the request", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const { requests, fetchImpl } = recordingFetch();
    const result = await fetchLiveBetTicker({
      agentId: "AG1",
      fetchImpl,
      env: {},
    });
    expect(result.diagnostic).toMatchObject({ code: "ok" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("cookie")).toBe(session.cookieHeader);
    expect(requests[0]?.headers.get("authorization")).toBe(BEARER);
  });

  test("keychain store failure is the session_store_unavailable diagnostic and nothing is fetched", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    const { requests, fetchImpl } = recordingFetch();
    const result = await fetchLiveBetTicker({
      agentId: "AG1",
      fetchImpl,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostic.code).toBe("session_store_unavailable");
    const message =
      "message" in result.diagnostic ? result.diagnostic.message : "";
    expect(message).toContain("F402KeychainUnavailable");
    expect(message).toContain("ERR_SECRETS_PLATFORM_ERROR");
    expect(requests).toEqual([]);
  });

  test("keychain store with no entry is the usual transport_unavailable", async () => {
    useStore("keychain", memoryStore());
    const result = await fetchLiveBetTicker({ agentId: "AG1", env: {} });
    expect(result.diagnostic.code).toBe("transport_unavailable");
  });

  test("file store: the keychain is never asked", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    const result = await fetchLiveBetTicker({ agentId: "AG1", env: {} });
    expect(result.diagnostic.code).toBe("transport_unavailable");
    expect(store.calls).toEqual([]);
  });
});

describe("fetchLivePending (lib/f402_live_pending.ts)", () => {
  test("keychain store: the loaded session's cookie goes on the request", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const { requests, fetchImpl } = recordingFetch([]);
    await fetchLivePending({ customers: ["C1"], fetchImpl, env: {} });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.headers.get("cookie")).toBe(session.cookieHeader);
  });

  test("keychain store failure is session_store_unavailable; an empty scope never reads it", async () => {
    const store = memoryStore({}, deniedError);
    useStore("keychain", store);
    const { requests, fetchImpl } = recordingFetch([]);
    const failed = await fetchLivePending({
      customers: ["C1"],
      fetchImpl,
      env: {},
    });
    expect(failed.diagnostic.code).toBe("session_store_unavailable");
    expect(requests).toEqual([]);

    store.calls.length = 0;
    const empty = await fetchLivePending({ customers: [], env: {} });
    expect(empty.diagnostic.code).toBe("no_customer_scope");
    expect(store.calls).toEqual([]);
  });
});

describe("fetchIncomingBets (lib/f402_incoming_bets.ts)", () => {
  test("keychain store: the loaded session's cookie goes on the live request", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const { requests, fetchImpl } = recordingFetch();
    await fetchIncomingBets({
      source: "live",
      agentId: "AG1",
      fetchImpl,
      rootDir: dir,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("cookie")).toBe(session.cookieHeader);
  });

  test("a store failure is reported for live and auto (no silent capture fallback)", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    for (const source of ["live", "auto"] as const) {
      const result = await fetchIncomingBets({
        source,
        agentId: "AG1",
        rootDir: dir,
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostic.code).toBe("session_store_unavailable");
    }
  });

  test("source=file does not need the session, so a store failure does not block it", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    const result = await fetchIncomingBets({ source: "file", rootDir: dir });
    expect(result.diagnostic.code).toBe("file_required");
  });
});

describe("buildDeskEnhancedHealth (lib/desk_enhanced_health.ts)", () => {
  const gsliveOk = (): GsliveSessionHealth =>
    ({
      schemaVersion: 1,
      generatedAt: "2026-11-17T00:00:00.000Z",
      authModel: {
        durable: "GSID cookie (browser-managed, HttpOnly)",
        modern: "cookie-only GET /manager-tools/*",
        legacy: "ajax.php POST needs x-gs-session from signin",
      },
      session: {
        configured: true,
        source: "keychain",
        cookieName: "GSID",
        cookieNames: ["GSID"],
      },
      probe: {
        status: "ok",
        httpStatus: 200,
        latencyMs: 1,
        checkedAt: "2026-11-17T00:00:00.000Z",
        cfMitigated: null,
        detail: "ok",
        cached: false,
      },
      surfaceMap: [],
      advisory: "ok",
    }) as GsliveSessionHealth;
  const build = () =>
    buildDeskEnhancedHealth({
      port: 1,
      hostname: "127.0.0.1",
      url: "http://127.0.0.1:1",
      runtime: "Bun",
      ingress: {},
      nodeEnv: "test",
      uptimeSeconds: 1,
      resolveGitSha: () => null,
      readGsliveHealth: async () => gsliveOk(),
      probeR2: async () => ({}),
      hasF402MintCredentials: async () => false,
      gsliveMintFailureStreak: () => 0,
    });

  test("keychain store: a loaded session is ok with source keychain", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const health = await build();
    expect(health.checks.auth.f402).toMatchObject({
      status: "ok",
      source: "keychain",
    });
  });

  test("keychain store: an expired entry is expired, no entry is missing", async () => {
    const expired = { ...session, expiresAtIso: "2020-01-01T00:00:00.000Z" };
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(expired) }),
    );
    expect((await build()).checks.auth.f402).toMatchObject({
      status: "expired",
      source: "keychain",
    });
    resetF402SessionCacheForTests();
    useStore("keychain", memoryStore());
    expect((await build()).checks.auth.f402).toMatchObject({
      status: "missing",
      source: "none",
    });
  });

  test("keychain store failure is status unavailable with a named degraded reason", async () => {
    useStore("keychain", memoryStore({}, deniedError));
    const health = await build();
    expect(health.checks.auth.f402).toMatchObject({
      status: "unavailable",
      source: "keychain",
      expiresInSeconds: null,
    });
    expect(health.checks.auth.f402.storeError).toContain(
      "F402SecretInteractionRequired",
    );
    expect(health.checks.auth.f402.remediation).toContain("secrets:f402 probe");
    const reason = health.degradedReasons.find((entry) =>
      entry.message.includes("F402SecretInteractionRequired"),
    );
    expect(reason).toMatchObject({ kind: "auth", severity: "error" });
  });

  test("file store: the keychain is never asked", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    const health = await build();
    expect(health.checks.auth.f402).toMatchObject({
      status: "missing",
      source: "none",
    });
    expect(store.calls).toEqual([]);
  });
});

describe("keychainCredentialProbe (lib/bridge_rollup_cron.ts)", () => {
  const job = (id: BridgeRollupJobId) => {
    const found = BRIDGE_ROLLUP_JOBS.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`missing job ${id}`);
    return found;
  };
  const probe = () =>
    keychainCredentialProbe({
      env: { HOME: join(dir, "home") },
      readSecret: async (name) =>
        name === F402_KEYCHAIN_NAMES.agentId ? "AG1" : null,
    });

  test("keychain store: bridge3a sees the session and bridge3b its bearer", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    expect(await probe().check(job("bridge3a"))).toMatchObject({ ok: true });
    expect(await probe().check(job("bridge3b"))).toEqual({
      ok: true,
      source: "session:bearer",
    });
  });

  test("keychain store failure fails 3a and 3b by name, not as missing credentials", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    for (const id of ["bridge3a", "bridge3b"] as const) {
      const decision = await probe().check(job(id));
      expect(decision.ok).toBe(false);
      const error = "error" in decision ? decision.error : "";
      expect(error).toContain("session store unavailable");
      expect(error).toContain("F402KeychainUnavailable");
    }
  });

  test("keychain store with no entry keeps the old missing-session refusal", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(cookieOnly) }),
    );
    expect(await probe().check(job("bridge3a"))).toMatchObject({ ok: true });
    resetF402SessionCacheForTests();
    useStore("keychain", memoryStore());
    expect(await probe().check(job("bridge3a"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("no F402 session"),
    });
  });

  test("file store: the keychain session entry is never asked", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    expect((await probe().check(job("bridge3a"))).ok).toBe(false);
    expect(store.calls).toEqual([]);
  });
});

describe("resolveF402BearerTokenDetailedAsync (lib/f402_pending_fetch.ts)", () => {
  test("keychain store: falls back to the loaded session's bearer", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const resolved = await resolveF402BearerTokenDetailedAsync({
      environment: { HOME: join(dir, "home") },
    });
    expect(resolved.source).toBe("session");
    expect(`Bearer ${resolved.token}`).toBe(BEARER);
  });

  test("an env token wins and the keychain is never asked", async () => {
    const store = memoryStore({}, unavailableError);
    useStore("keychain", store);
    const token = "q001-env-bearer-token-unit-only-00002";
    const resolved = await resolveF402BearerTokenDetailedAsync({
      environment: { F402_BEARER_TOKEN: token, HOME: join(dir, "home") },
    });
    expect(resolved).toEqual({ token, source: "env" });
    expect(store.calls).toEqual([]);
  });

  test("a store failure is thrown by name; no source at all is F402PendingFetchError", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    const environment = { HOME: join(dir, "home") };
    await expect(
      resolveF402BearerTokenDetailedAsync({ environment }),
    ).rejects.toBeInstanceOf(F402KeychainUnavailable);
    await expect(
      f402BearerResolvableAsync({ environment }),
    ).rejects.toBeInstanceOf(F402KeychainUnavailable);

    resetF402SessionCacheForTests();
    useStore("keychain", memoryStore());
    await expect(
      resolveF402BearerTokenDetailedAsync({ environment }),
    ).rejects.toBeInstanceOf(F402PendingFetchError);
    expect(await f402BearerResolvableAsync({ environment })).toBe(false);
  });

  test("file store: same outcome as the sync resolver", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    const environment = { HOME: join(dir, "home") };
    expect(() => resolveF402BearerTokenDetailed({ environment })).toThrow(
      F402PendingFetchError,
    );
    await expect(
      resolveF402BearerTokenDetailedAsync({ environment }),
    ).rejects.toBeInstanceOf(F402PendingFetchError);
    expect(store.calls).toEqual([]);
  });
});

describe("fetchReportPlayerAnalysis headers (lib/f402_report_player_analysis.ts)", () => {
  function transport(): F402ReplayTransport & {
    readonly auth: (string | null)[];
  } {
    const auth: (string | null)[] = [];
    return {
      auth,
      label: "proxy",
      async fetch(_url: string, init: RequestInit) {
        auth.push(new Headers(init.headers).get("authorization"));
        return new Response("upstream refused", { status: 500 });
      },
      async close() {},
    };
  }
  const request = {
    agentID: "AG1",
    startDate: "2026-11-01",
    endDate: "2026-11-14",
  };

  test("keychain store: the loaded session's bearer is sent", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    const wire = transport();
    await expect(
      fetchReportPlayerAnalysis(wire, request, {
        host: "https://example.invalid",
      }),
    ).rejects.toThrow("HTTP 500");
    expect(wire.auth).toEqual([BEARER]);
  });

  test("keychain store failure throws the named error before any request", async () => {
    useStore("keychain", memoryStore({}, deniedError));
    const wire = transport();
    await expect(
      fetchReportPlayerAnalysis(wire, request, {
        host: "https://example.invalid",
      }),
    ).rejects.toBeInstanceOf(F402SecretInteractionRequired);
    expect(wire.auth).toEqual([]);
  });
});

describe("cookieHeaderFromEnv (lib/f402_replay_transport.ts, deprecated)", () => {
  test("keychain store: the loaded session's cookie", async () => {
    useStore(
      "keychain",
      memoryStore({ [SESSION_KEY]: JSON.stringify(session) }),
    );
    expect(await cookieHeaderFromEnv({})).toBe(session.cookieHeader);
  });

  test("keychain store failure throws by name", async () => {
    useStore("keychain", memoryStore({}, unavailableError));
    await expect(cookieHeaderFromEnv({})).rejects.toBeInstanceOf(
      F402KeychainUnavailable,
    );
  });

  test("file store: no session falls back to F402_COOKIE as before", async () => {
    const store = memoryStore({ [SESSION_KEY]: JSON.stringify(session) });
    useStore("file", store);
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await cookieHeaderFromEnv({ F402_COOKIE: "legacy=1" })).toBe(
        "legacy=1",
      );
      expect(await cookieHeaderFromEnv({})).toBe("");
    } finally {
      console.warn = warn;
    }
    expect(store.calls).toEqual([]);
  });
});

describe("readSecretOrNull (lib/secrets.ts): explicit error mapping", () => {
  const throwing = (error: () => unknown) => {
    const reads: string[] = [];
    setSecretsProviderForTests({
      async get({ service, name }) {
        reads.push(`${service}/${name}`);
        throw error();
      },
    });
    return reads;
  };

  test("a timeout is still null (unchanged)", async () => {
    throwing(() => new KeychainTimeoutError({ service: "s", name: "n" }, 500));
    expect(await readSecretOrNull(CANONICAL_SECRETS_SERVICE, "x")).toBeNull();
  });

  test("no usable keychain (F402KeychainUnavailable) is null", async () => {
    throwing(unavailableError);
    expect(await readSecretOrNull(CANONICAL_SECRETS_SERVICE, "x")).toBeNull();
    throwing(() =>
      Object.assign(new Error("No keychain is available. (code: -25291)"), {
        code: "ERR_SECRETS_ACCESS_DENIED",
      }),
    );
    expect(await readSecretOrNull(CANONICAL_SECRETS_SERVICE, "x")).toBeNull();
  });

  test.each([
    ["ERR_SECRETS_ACCESS_DENIED", "F402SecretAccessDenied", "access-denied"],
    ["ERR_SECRETS_AUTH_FAILED", "F402SecretAccessDenied", "access-denied"],
    [
      "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
      "F402SecretInteractionRequired",
      "interaction-required",
    ],
    [
      "ERR_SECRETS_INTERACTION_REQUIRED",
      "F402SecretInteractionRequired",
      "interaction-required",
    ],
    ["ERR_SECRETS_USER_CANCELED", "F402SecretUserCanceled", "user-canceled"],
    ["ERR_SECRETS_PLATFORM_ERROR", "F402SecretBackendError", "platform"],
    ["ERR_SECRETS_NOT_FOUND", "F402SecretNotFound", "not-found"],
    ["ERR_INVALID_ARG_TYPE", "F402SecretInvalidArgument", "invalid-argument"],
    ["ERR_INVALID_ARG_VALUE", "F402SecretInvalidArgument", "invalid-argument"],
    ["ERR_SOMETHING_NEW", "F402SecretBackendError", "unknown-code"],
  ])("%s throws %s", async (code, name, kind) => {
    throwing(() =>
      Object.assign(new Error("keychain refused (code: 51)"), { code }),
    );
    const error = await readSecretOrNull(CANONICAL_SECRETS_SERVICE, "x").then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      name,
      kind,
      bunCode: code,
      service: CANONICAL_SECRETS_SERVICE,
      secretName: "x",
      op: "get",
    });
  });

  test("an error with no code throws F402SecretBackendError (uncoded); legacy is not asked", async () => {
    const reads = throwing(() => new Error("keychain locked"));
    await expect(readSecretWithSource("x")).rejects.toBeInstanceOf(
      F402SecretBackendError,
    );
    expect(reads).toEqual([`${CANONICAL_SECRETS_SERVICE}/x`]);
  });

  test("absent and blank entries are still null, canonical then legacy", async () => {
    const reads: string[] = [];
    setSecretsProviderForTests({
      async get({ service, name }) {
        reads.push(`${service}/${name}`);
        return service === CANONICAL_SECRETS_SERVICE ? "   " : null;
      },
    });
    expect(await readSecretWithSource("x")).toBeNull();
    expect(reads).toEqual([
      `${CANONICAL_SECRETS_SERVICE}/x`,
      `${LEGACY_SECRETS_SERVICE}/x`,
    ]);
  });
});

describe("loadF402CredentialsSecure (lib/f402_credentials_policy.ts): explicit error mapping", () => {
  const ENV_CREDS = {
    F402_ALLOW_ENV_CREDENTIALS: "1",
    F402_AGENT_ID: "env-agent",
    F402_PASSWORD: "env-pw-unit-only",
  };
  const reader = (error: () => unknown) => {
    const reads: string[] = [];
    return {
      reads,
      async get({ service, name }: { service: string; name: string }) {
        reads.push(`${service}/${name}`);
        throw error();
      },
    };
  };
  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      return await run();
    } finally {
      console.warn = warn;
    }
  };

  test("a timeout returns at once without asking legacy, then env applies (unchanged)", async () => {
    const timeout = reader(
      () => new KeychainTimeoutError({ service: "s", name: "n" }, 500),
    );
    const creds = await quiet(() =>
      loadF402CredentialsSecure(ENV_CREDS, timeout),
    );
    expect(creds.credentialSource).toBe("deprecated-env");
    expect(timeout.reads).toEqual([
      `${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`,
      `${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`,
    ]);
  });

  test("no usable keychain behaves like a timeout", async () => {
    const unavailable = reader(unavailableError);
    const creds = await quiet(() =>
      loadF402CredentialsSecure(ENV_CREDS, unavailable),
    );
    expect(creds.credentialSource).toBe("deprecated-env");
    await expect(
      loadF402CredentialsSecure({}, reader(unavailableError)),
    ).rejects.toThrow("F402");
  });

  test("a refusing keychain throws its named error when there is no env opt-in", async () => {
    await expect(
      loadF402CredentialsSecure({}, reader(deniedError)),
    ).rejects.toBeInstanceOf(F402SecretInteractionRequired);
    await expect(
      loadF402CredentialsSecure(
        {},
        reader(() =>
          Object.assign(new Error("denied (code: -25293)"), {
            code: "ERR_SECRETS_ACCESS_DENIED",
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(F402SecretAccessDenied);
    await expect(
      loadF402CredentialsSecure(
        {},
        reader(() => new Error("no code")),
      ),
    ).rejects.toMatchObject({
      name: "F402SecretBackendError",
      kind: "uncoded",
    });
  });

  test("the explicit env opt-in still wins over a refusing keychain, and the refusal is logged by name", async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const creds = await loadF402CredentialsSecure(
        ENV_CREDS,
        reader(deniedError),
      );
      expect(creds.credentialSource).toBe("deprecated-env");
    } finally {
      console.warn = warn;
    }
    expect(lines.join("\n")).toContain("F402SecretInteractionRequired");
    expect(lines.join("\n")).not.toContain(ENV_CREDS.F402_PASSWORD);
  });
});
