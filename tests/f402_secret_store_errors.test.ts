/**
 * Bun.secrets error-code mapping, write policy, idempotent migrate, the secrets:f402 exit-code and
 * `--json` contract, and F402_SESSION_STORE validation. Unit tests use an in-memory adapter; the
 * real-binary tests use a throwaway service only and never the real F402 entries.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  classifySecretsError,
  deleteF402Secret,
  F402_SECRET_ERROR_MAP,
  F402_SECRET_SET_POLICY,
  F402KeychainUnavailable,
  F402LegacyWriteRefused,
  F402SecretAccessDenied,
  F402SecretBackendError,
  F402SecretError,
  F402SecretInteractionRequired,
  F402SecretInvalidArgument,
  F402SecretNotFound,
  F402SecretUserCanceled,
  KEYCHAIN_TIMEOUT_CODE,
  legacyReadOnly,
  migrateLegacyF402Secrets,
  probeSecretsBackend,
  readF402SecretStrict,
  setSecretsAdapterForTests,
  writeF402Secret,
  type F402SecretErrorKind,
  type SecretsAdapter,
} from "../lib/f402_secret_store.ts";
import {
  F402_SESSION_SECRET_NAME,
  F402SessionStoreConfigError,
  primeF402Session,
  readF402Session,
  resetF402SessionCacheForTests,
  resolveF402SessionStore,
  sessionFromAuth,
} from "../lib/f402_session.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  KeychainTimeoutError,
  LEGACY_SECRETS_SERVICE,
} from "../lib/secrets.ts";
import {
  runSecretsF402Cli,
  SECRETS_F402_EXIT,
  SECRETS_F402_JSON_SCHEMA,
} from "../scripts/secrets_f402.ts";

type Recorded = { op: string; options: Record<string, unknown> };

function fakeStore(
  entries: Record<string, string> = {},
  behaviour: {
    readonly throwOn?: (op: string, service: string) => unknown;
    readonly dropWrites?: boolean;
  } = {},
): SecretsAdapter & {
  readonly calls: string[];
  readonly recorded: Recorded[];
  readonly entries: Record<string, string>;
} {
  const calls: string[] = [];
  const recorded: Recorded[] = [];
  const fail = (op: string, service: string) => {
    const thrown = behaviour.throwOn?.(op, service);
    if (thrown !== undefined) throw thrown;
  };
  return {
    calls,
    recorded,
    entries,
    async get(options) {
      calls.push(`get ${options.service}/${options.name}`);
      fail("get", options.service);
      return entries[`${options.service}/${options.name}`] ?? null;
    },
    async set(options) {
      calls.push(`set ${options.service}/${options.name}`);
      recorded.push({ op: "set", options: { ...options, value: "<value>" } });
      fail("set", options.service);
      if (!behaviour.dropWrites) {
        entries[`${options.service}/${options.name}`] = options.value;
      }
    },
    async delete(options) {
      calls.push(`delete ${options.service}/${options.name}`);
      fail("delete", options.service);
      const key = `${options.service}/${options.name}`;
      const had = key in entries;
      delete entries[key];
      return had;
    },
  };
}

function bunError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const ctx = { service: "svc.test", name: "entry", op: "get" as const };
const PASSWORD = "pw-Q001!unit-only-not-real";
const canonical = (name: string) => `${CANONICAL_SECRETS_SERVICE}/${name}`;
const legacy = (name: string) => `${LEGACY_SECRETS_SERVICE}/${name}`;

afterEach(() => {
  setSecretsAdapterForTests(null);
  resetF402SessionCacheForTests();
});

describe("F402_SECRET_ERROR_MAP: one named error per code", () => {
  /** Bun ErrorCode.ts:312-318 at ed436333, plus JSSecrets.cpp argument codes and our timeout. */
  const expected: readonly [string, string, string][] = [
    ["ERR_SECRETS_NOT_FOUND", "F402SecretNotFound", "not-found"],
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
    ["ERR_INVALID_ARG_TYPE", "F402SecretInvalidArgument", "invalid-argument"],
    ["ERR_INVALID_ARG_VALUE", "F402SecretInvalidArgument", "invalid-argument"],
    [KEYCHAIN_TIMEOUT_CODE, "F402KeychainUnavailable", "timeout"],
  ];

  test("the map covers exactly these codes (a new code needs a row here)", () => {
    expect(Object.keys(F402_SECRET_ERROR_MAP).toSorted()).toEqual(
      expected.map(([code]) => code).toSorted(),
    );
  });

  test.each(expected)("%s → %s (%s)", (code, name, kind) => {
    const named = classifySecretsError(
      bunError(code, "store said no (code: 7)"),
      ctx,
    );
    expect(named).toBeInstanceOf(F402SecretError);
    expect(named.name).toBe(name);
    expect(named.kind).toBe(kind as F402SecretErrorKind);
    expect(named.bunCode).toBe(code);
    expect(named.platformCode).toBe(7);
    expect(named.op).toBe("get");
    expect(named.message).toContain("svc.test/entry");
  });

  test("subclasses stay F402SecretBackendError so callers' instanceof checks still hold", () => {
    for (const ctor of [
      F402SecretAccessDenied,
      F402SecretInteractionRequired,
      F402SecretUserCanceled,
      F402SecretInvalidArgument,
      F402LegacyWriteRefused,
    ]) {
      expect(ctor.prototype).toBeInstanceOf(F402SecretBackendError);
    }
  });

  test.each([
    "Could not connect: No such file or directory (code: 1)",
    "Cannot autolaunch D-Bus without X11 $DISPLAY",
    "The name org.freedesktop.secrets was not provided by any .service files (code: 2)",
    "libsecret not available",
    "Security framework not available",
    "Credential Manager not available",
  ])("ERR_SECRETS_PLATFORM_ERROR %p → F402KeychainUnavailable", (message) => {
    const named = classifySecretsError(
      bunError("ERR_SECRETS_PLATFORM_ERROR", message),
      ctx,
    );
    expect(named).toBeInstanceOf(F402KeychainUnavailable);
    expect(named.kind).toBe("unavailable");
  });

  test("macOS errSecNotAvailable (-25291) under ACCESS_DENIED → F402KeychainUnavailable", () => {
    const named = classifySecretsError(
      bunError(
        "ERR_SECRETS_ACCESS_DENIED",
        "No keychain is available. (code: -25291)",
      ),
      ctx,
    );
    expect(named).toBeInstanceOf(F402KeychainUnavailable);
    expect(named.platformCode).toBe(-25291);
  });

  test("ERR_SECRETS_NOT_FOUND on set keeps op and code (Bun only rejects with it on set)", () => {
    const named = classifySecretsError(
      bunError(
        "ERR_SECRETS_NOT_FOUND",
        "The specified item could not be found in the keychain. (code: -25300)",
      ),
      { ...ctx, op: "set" },
    );
    expect(named).toBeInstanceOf(F402SecretNotFound);
    expect(named.op).toBe("set");
    expect(named.platformCode).toBe(-25300);
  });

  test("an unknown code is kept verbatim on F402SecretBackendError, never folded into another", () => {
    const named = classifySecretsError(
      bunError("ERR_SECRETS_SOMETHING_NEW", "new failure"),
      ctx,
    );
    expect(named.constructor).toBe(F402SecretBackendError);
    expect(named.bunCode).toBe("ERR_SECRETS_SOMETHING_NEW");
    expect(named.kind).toBe("unknown-code");
  });

  test("a prototype key is not treated as a mapped code", () => {
    const named = classifySecretsError(bunError("toString", "odd"), ctx);
    expect(named.kind).toBe("unknown-code");
    expect(named.bunCode).toBe("toString");
  });

  test("an error with no code → F402SecretBackendError kind uncoded", () => {
    const named = classifySecretsError(new TypeError("adapter broke"), ctx);
    expect(named.constructor).toBe(F402SecretBackendError);
    expect(named.bunCode).toBeUndefined();
    expect(named.kind).toBe("uncoded");
  });

  test("KeychainTimeoutError → F402KeychainUnavailable kind timeout", () => {
    const named = classifySecretsError(new KeychainTimeoutError(ctx, 500), ctx);
    expect(named).toBeInstanceOf(F402KeychainUnavailable);
    expect(named.kind).toBe("timeout");
  });

  test("a named error passes through unchanged", () => {
    const original = new F402SecretUserCanceled(
      ctx,
      "ERR_SECRETS_USER_CANCELED",
      "x",
    );
    expect(classifySecretsError(original, ctx)).toBe(original);
  });

  test("the secret value is scrubbed from every mapped error", () => {
    for (const code of Object.keys(F402_SECRET_ERROR_MAP)) {
      const named = classifySecretsError(
        bunError(code, `echoed ${PASSWORD}`),
        { ...ctx, op: "set" },
        [PASSWORD],
      );
      expect(Bun.inspect(named)).not.toContain(PASSWORD);
      expect(JSON.stringify(named)).not.toContain(PASSWORD);
    }
  });
});

describe("real Bun.secrets argument errors map to F402SecretInvalidArgument (throwaway service)", () => {
  const THROWAWAY = `${CANONICAL_SECRETS_SERVICE}.test-args-${crypto.randomUUID().slice(0, 8)}`;

  test("empty name → ERR_INVALID_ARG_TYPE (Bun throws synchronously, before any backend call)", async () => {
    const error = await readF402SecretStrict("", {
      adapter: Bun.secrets,
      services: [THROWAWAY],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretInvalidArgument);
    expect(error.bunCode).toBe("ERR_INVALID_ARG_TYPE");
  });

  test("NUL byte in name → ERR_INVALID_ARG_VALUE", async () => {
    const error = await deleteF402Secret(THROWAWAY, "a\0b", {
      adapter: Bun.secrets,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretInvalidArgument);
    expect(error.bunCode).toBe("ERR_INVALID_ARG_VALUE");
  });
});

describe("write policy", () => {
  test("persist local, allowUnrestrictedAccess never sent", async () => {
    const store = fakeStore();
    await writeF402Secret("f402-password", PASSWORD, { adapter: store });
    expect(store.recorded).toEqual([
      {
        op: "set",
        options: {
          service: CANONICAL_SECRETS_SERVICE,
          name: "f402-password",
          value: "<value>",
          persist: "local",
        },
      },
    ]);
    expect(F402_SECRET_SET_POLICY.allowUnrestrictedAccess).toBe(false);
  });

  test.each(["", "   ", "\n"])(
    "blank value %p is refused before the store",
    async (value) => {
      const store = fakeStore();
      const error = await writeF402Secret("f402-password", value, {
        adapter: store,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(F402SecretBackendError);
      expect(error.kind).toBe("empty-value");
      expect(store.calls).toEqual([]);
    },
  );
});

describe("migrate", () => {
  const names = [F402_KEYCHAIN_NAMES.agentId, F402_KEYCHAIN_NAMES.password];

  test("idempotent: the second run writes nothing and reports already-migrated", async () => {
    const store = fakeStore({
      [legacy(F402_KEYCHAIN_NAMES.agentId)]: "118",
      [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
    });
    const first = await migrateLegacyF402Secrets(names, { adapter: store });
    expect(first.map((r) => r.outcome)).toEqual(["copied", "copied"]);
    const callsAfterFirst = store.calls.length;
    const second = await migrateLegacyF402Secrets(names, { adapter: store });
    expect(second.map((r) => r.outcome)).toEqual([
      "already-migrated",
      "already-migrated",
    ]);
    const secondCalls = store.calls.slice(callsAfterFirst);
    expect(secondCalls.filter((c) => !c.startsWith("get "))).toEqual([]);
    expect(
      store.calls.filter(
        (c) => !c.startsWith("get ") && c.includes(LEGACY_SECRETS_SERVICE),
      ),
    ).toEqual([]);
  });

  test("canonical-only when legacy is empty; absent when both are", async () => {
    const store = fakeStore({
      [canonical(F402_KEYCHAIN_NAMES.agentId)]: "118",
    });
    const results = await migrateLegacyF402Secrets(names, { adapter: store });
    expect(results.map((r) => r.outcome)).toEqual(["canonical-only", "absent"]);
    expect(store.calls.filter((c) => !c.startsWith("get "))).toEqual([]);
  });

  test("a copy that does not read back equal → F402SecretBackendError verify-failed", async () => {
    const store = fakeStore(
      { [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD },
      { dropWrites: true },
    );
    const error = await migrateLegacyF402Secrets(
      [F402_KEYCHAIN_NAMES.password],
      { adapter: store },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretBackendError);
    expect(error.kind).toBe("verify-failed");
    expect(error.message).not.toContain(PASSWORD);
  });

  test("legacyReadOnly refuses set and delete on legacy before the store sees them", async () => {
    const store = fakeStore({ [legacy("x")]: "keep" });
    const guarded = legacyReadOnly(store);
    const setError = await guarded
      .set({ service: LEGACY_SECRETS_SERVICE, name: "x", value: "v" })
      .catch((e) => e);
    const deleteError = await guarded
      .delete({ service: LEGACY_SECRETS_SERVICE, name: "x" })
      .catch((e) => e);
    expect(setError).toBeInstanceOf(F402LegacyWriteRefused);
    expect(deleteError).toBeInstanceOf(F402LegacyWriteRefused);
    expect(store.calls).toEqual([]);
    expect(store.entries[legacy("x")]).toBe("keep");
    await guarded.set({
      service: CANONICAL_SECRETS_SERVICE,
      name: "x",
      value: "v",
    });
    expect(store.calls).toEqual([`set ${canonical("x")}`]);
  });

  test("a keychain failure mid-migrate surfaces as the named error", async () => {
    const store = fakeStore(
      { [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD },
      {
        throwOn: (op) =>
          op === "set"
            ? bunError(
                "ERR_SECRETS_USER_CANCELED",
                "User canceled the operation. (code: -128)",
              )
            : undefined,
      },
    );
    const error = await migrateLegacyF402Secrets(
      [F402_KEYCHAIN_NAMES.password],
      { adapter: store },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretUserCanceled);
  });
});

describe("probe", () => {
  test("a failed cleanup is reported with its named error, not swallowed", async () => {
    const store = fakeStore(
      {},
      {
        throwOn: (op) =>
          op === "delete"
            ? bunError("ERR_SECRETS_ACCESS_DENIED", "denied (code: 5)")
            : undefined,
      },
    );
    const result = await probeSecretsBackend({ adapter: store });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.cleanup.status).toBe("failed");
    if (result.cleanup.status !== "failed") throw new Error("unreachable");
    expect(result.cleanup.error).toBeInstanceOf(F402SecretAccessDenied);
  });

  test("refuses the real services", async () => {
    for (const service of [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE]) {
      const store = fakeStore();
      const error = await probeSecretsBackend({
        adapter: store,
        service,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(F402SecretInvalidArgument);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("F402_SESSION_STORE validation", () => {
  test.each([
    [undefined, "file"],
    ["", "file"],
    ["  ", "file"],
    ["file", "file"],
    [" File ", "file"],
    ["keychain", "keychain"],
    ["KEYCHAIN", "keychain"],
  ])("%p → %p", (value, expected) => {
    expect(resolveF402SessionStore({ F402_SESSION_STORE: value })).toBe(
      expected as "file" | "keychain",
    );
  });

  test.each(["keyring", "files", "1", "true", "keychain,file", "memory"])(
    "%p throws F402SessionStoreConfigError",
    (value) => {
      expect(() =>
        resolveF402SessionStore({ F402_SESSION_STORE: value }),
      ).toThrow(F402SessionStoreConfigError);
    },
  );

  test("a sync reader fails loudly on an invalid value instead of reading the file", () => {
    const prev = process.env.F402_SESSION_STORE;
    process.env.F402_SESSION_STORE = "keyring";
    try {
      expect(() => readF402Session()).toThrow(F402SessionStoreConfigError);
    } finally {
      if (prev === undefined) delete process.env.F402_SESSION_STORE;
      else process.env.F402_SESSION_STORE = prev;
    }
  });
});

describe("primeF402Session and the replay transport in keychain mode", () => {
  const session = sessionFromAuth(
    {
      cookieHeader: "ASP.NET_SessionId=q001-cookie-value",
      cookieNames: ["ASP.NET_SessionId"],
    },
    { ttlMinutes: 60 },
  );

  test("file mode: prime never touches the store", async () => {
    const store = fakeStore();
    setSecretsAdapterForTests(store);
    await primeF402Session({ store: "file", path: "/nonexistent/q001.json" });
    expect(store.calls).toEqual([]);
  });

  test("keychain mode: prime loads, then the sync reader answers", async () => {
    setSecretsAdapterForTests(
      fakeStore({
        [canonical(F402_SESSION_SECRET_NAME)]: JSON.stringify(session),
      }),
    );
    expect(readF402Session({ store: "keychain" })).toBeNull();
    await primeF402Session({ store: "keychain" });
    expect(readF402Session({ store: "keychain" })?.cookieNames).toEqual([
      "ASP.NET_SessionId",
    ]);
  });

  test("createF402ReplayTransport primes the keychain session before its first request", async () => {
    setSecretsAdapterForTests(
      fakeStore({
        [canonical(F402_SESSION_SECRET_NAME)]: JSON.stringify(session),
      }),
    );
    const prev = process.env.F402_SESSION_STORE;
    process.env.F402_SESSION_STORE = "keychain";
    const seen: (string | null)[] = [];
    try {
      const transport = await createF402ReplayTransport({
        env: {},
        fetchImpl: async (_url, init) => {
          seen.push(new Headers(init.headers).get("cookie"));
          return new Response("ok");
        },
      });
      expect(transport.label).toBe("session-file");
      await transport.fetch("https://example.invalid/x", {});
      await transport.close();
    } finally {
      if (prev === undefined) delete process.env.F402_SESSION_STORE;
      else process.env.F402_SESSION_STORE = prev;
    }
    expect(seen).toEqual([session.cookieHeader]);
  });
});

/** In-process CLI with an in-memory adapter: real service names never reach a real keychain. */
async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const original = { log: console.log, error: console.error };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    stdout += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.join(" ")}\n`;
  };
  try {
    const code = await runSecretsF402Cli(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalWrite;
    Object.assign(console, original);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("secrets:f402 --json and exit codes (in-memory adapter)", () => {
  const BASE_KEYS = ["command", "error", "exitCode", "ok", "schema"];
  const parse = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  };

  test("status: all present → 0 with the documented keys", async () => {
    setSecretsAdapterForTests(
      fakeStore({
        [canonical(F402_KEYCHAIN_NAMES.agentId)]: "118",
        [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
      }),
    );
    const { code, stdout, stderr } = await runCli(["status", "--json"], {
      F402_SESSION_STORE: undefined,
    });
    expect(code).toBe(SECRETS_F402_EXIT.ok);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(PASSWORD);
    const doc = parse(stdout);
    expect(Object.keys(doc).toSorted()).toEqual(
      [...BASE_KEYS, "entries", "services", "sessionStore"].toSorted(),
    );
    expect(doc.schema).toBe(SECRETS_F402_JSON_SCHEMA);
    expect(doc.ok).toBe(true);
    expect(doc.sessionStore).toBe("file");
    expect(doc.entries).toEqual([
      {
        label: "agentId",
        entry: F402_KEYCHAIN_NAMES.agentId,
        present: true,
        service: CANONICAL_SECRETS_SERVICE,
      },
      {
        label: "password",
        entry: F402_KEYCHAIN_NAMES.password,
        present: true,
        service: LEGACY_SECRETS_SERVICE,
      },
    ]);
  });

  test("status: an absent entry → 5, ok false, error null", async () => {
    setSecretsAdapterForTests(fakeStore());
    const { code, stdout } = await runCli(["status", "--json"], {
      F402_SESSION_STORE: "keychain",
    });
    expect(code).toBe(SECRETS_F402_EXIT.absent);
    const doc = parse(stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error).toBeNull();
    expect((doc.entries as unknown[]).length).toBe(3);
  });

  test("status: invalid F402_SESSION_STORE → 2 with the named error", async () => {
    setSecretsAdapterForTests(fakeStore());
    const { code, stdout } = await runCli(["status", "--json"], {
      F402_SESSION_STORE: "keyring",
    });
    expect(code).toBe(SECRETS_F402_EXIT.usage);
    const doc = parse(stdout);
    expect((doc.error as { name: string }).name).toBe(
      "F402SessionStoreConfigError",
    );
  });

  test.each([
    [
      "ERR_SECRETS_PLATFORM_ERROR",
      "Could not connect: x (code: 1)",
      3,
      "F402KeychainUnavailable",
    ],
    [
      "ERR_SECRETS_ACCESS_DENIED",
      "denied (code: 5)",
      4,
      "F402SecretAccessDenied",
    ],
    [
      "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
      "no UI (code: -25308)",
      4,
      "F402SecretInteractionRequired",
    ],
    [
      "ERR_SECRETS_USER_CANCELED",
      "canceled (code: -128)",
      4,
      "F402SecretUserCanceled",
    ],
    ["ERR_SECRETS_SOMETHING_NEW", "new", 4, "F402SecretBackendError"],
  ])("status: %s → exit %d (%s)", async (bunCode, message, exit, name) => {
    setSecretsAdapterForTests(
      fakeStore({}, { throwOn: () => bunError(bunCode, message) }),
    );
    const { code, stdout } = await runCli(["status", "--json"], {
      F402_SESSION_STORE: undefined,
    });
    expect(code).toBe(exit);
    const doc = parse(stdout);
    expect(Object.keys(doc).toSorted()).toEqual(BASE_KEYS.toSorted());
    const error = doc.error as Record<string, unknown>;
    expect(Object.keys(error).toSorted()).toEqual(
      [
        "code",
        "entry",
        "kind",
        "message",
        "name",
        "op",
        "platformCode",
        "service",
      ].toSorted(),
    );
    expect(error.name).toBe(name);
    expect(error.code).toBe(bunCode);
  });

  test("migrate --json twice: copied then already-migrated, legacyWritten false", async () => {
    const store = fakeStore({
      [legacy(F402_KEYCHAIN_NAMES.agentId)]: "118",
      [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
    });
    setSecretsAdapterForTests(store);
    const first = await runCli(["migrate", "--json"]);
    const second = await runCli(["migrate", "--json"]);
    expect([first.code, second.code]).toEqual([0, 0]);
    const a = parse(first.stdout);
    const b = parse(second.stdout);
    expect(Object.keys(a).toSorted()).toEqual(
      [
        ...BASE_KEYS,
        "canonicalService",
        "legacyService",
        "legacyWritten",
        "results",
      ].toSorted(),
    );
    expect(a.legacyWritten).toBe(false);
    expect((a.results as { outcome: string }[]).map((r) => r.outcome)).toEqual([
      "copied",
      "copied",
    ]);
    expect((b.results as { outcome: string }[]).map((r) => r.outcome)).toEqual([
      "already-migrated",
      "already-migrated",
    ]);
    expect(`${first.stdout}${second.stdout}`).not.toContain(PASSWORD);
  });

  test("probe --json: available with cleanup status", async () => {
    setSecretsAdapterForTests(fakeStore());
    const { code, stdout } = await runCli(["probe", "--json"]);
    expect(code).toBe(0);
    const doc = parse(stdout);
    expect(Object.keys(doc).toSorted()).toEqual(
      [...BASE_KEYS, "available", "cleanup", "platform", "service"].toSorted(),
    );
    expect(doc.cleanup).toEqual({ status: "deleted", error: null });
    expect(
      String(doc.service).startsWith(`${CANONICAL_SECRETS_SERVICE}.probe-`),
    ).toBe(true);
  });

  test("probe --json: unavailable → 3", async () => {
    setSecretsAdapterForTests(
      fakeStore(
        {},
        {
          throwOn: () =>
            bunError(
              "ERR_SECRETS_PLATFORM_ERROR",
              "Cannot autolaunch D-Bus without X11 $DISPLAY",
            ),
        },
      ),
    );
    const { code, stdout } = await runCli(["probe", "--json"]);
    expect(code).toBe(SECRETS_F402_EXIT.keychainUnavailable);
    expect((parse(stdout).error as { name: string }).name).toBe(
      "F402KeychainUnavailable",
    );
  });

  test("delete: a refused delete → 4 and the others still run", async () => {
    const store = fakeStore(
      { [canonical(F402_KEYCHAIN_NAMES.password)]: PASSWORD },
      {
        throwOn: (op, service) =>
          op === "delete" && service === LEGACY_SECRETS_SERVICE
            ? bunError("ERR_SECRETS_ACCESS_DENIED", "denied (code: 5)")
            : undefined,
      },
    );
    setSecretsAdapterForTests(store);
    const { code, stdout } = await runCli(["delete", "--json"]);
    expect(code).toBe(SECRETS_F402_EXIT.secretBackend);
    const doc = parse(stdout);
    expect(doc.removed).toBe(1);
    expect((doc.failures as unknown[]).length).toBe(2);
  });

  test("unknown command → 2", async () => {
    const { code, stdout } = await runCli(["rotate", "--json"]);
    expect(code).toBe(SECRETS_F402_EXIT.usage);
    expect((parse(stdout).error as { name: string }).name).toBe(
      "F402SecretsUsageError",
    );
  });
});

describe("secrets:f402 --json in a child process against an unreachable keychain (Linux)", () => {
  const cli = join(import.meta.dir, "../scripts/secrets_f402.ts");
  test
    .skipIf(process.platform !== "linux")
    .each(["status", "probe", "migrate"])(
    "%s --json → exit 3, one JSON line on stdout, nothing on stderr",
    async (command) => {
      const proc = Bun.spawn([process.execPath, cli, command, "--json"], {
        env: {
          ...process.env,
          F402_SESSION_STORE: "file",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/f402-q001-bus",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(3);
      expect(stderr).toBe("");
      const doc = JSON.parse(stdout.trim());
      expect(doc.schema).toBe(SECRETS_F402_JSON_SCHEMA);
      expect(doc.command).toBe(command);
      expect(doc.error.name).toBe("F402KeychainUnavailable");
      expect(doc.error.code).toBe("ERR_SECRETS_PLATFORM_ERROR");
    },
  );
});

/**
 * The Bun.secrets semantics this module depends on, checked on the running binary with a
 * throwaway service. Skips with a named reason when there is no backend; on macOS it needs
 * F402_SECRETS_INTEGRATION=1 so `bun test` never raises a Keychain dialog.
 */
const THROWAWAY = `${CANONICAL_SECRETS_SERVICE}.test-q001-${crypto.randomUUID().slice(0, 8)}`;
const darwinOptIn =
  process.platform !== "darwin" || Bun.env.F402_SECRETS_INTEGRATION === "1";
const backend = darwinOptIn
  ? await probeSecretsBackend({ adapter: Bun.secrets, service: THROWAWAY })
  : null;
const skipReason =
  backend === null
    ? "skipped: macOS needs F402_SECRETS_INTEGRATION=1"
    : backend.available
      ? ""
      : `skipped: ${backend.error.name} (${backend.error.bunCode ?? "no code"})`;

describe(`Bun.secrets contract on this binary ${skipReason}`.trim(), () => {
  const o = { service: THROWAWAY, name: "contract" };
  test.skipIf(skipReason !== "")(
    "get missing → null; delete missing → false",
    async () => {
      expect(await Bun.secrets.get(o)).toBeNull();
      expect(await Bun.secrets.delete(o)).toBe(false);
    },
  );
  test.skipIf(skipReason !== "")(
    "set '' deletes an existing entry and is a no-op on a missing one",
    async () => {
      const value = crypto.randomUUID();
      try {
        await Bun.secrets.set({ ...o, value });
        expect((await Bun.secrets.get(o)) === value).toBe(true);
        expect(await Bun.secrets.set({ ...o, value: "" })).toBeUndefined();
        expect(await Bun.secrets.get(o)).toBeNull();
        expect(await Bun.secrets.set({ ...o, value: "" })).toBeUndefined();
      } finally {
        await Bun.secrets.delete(o);
      }
    },
  );
  test.skipIf(skipReason !== "")(
    "delete present → true, then get → null",
    async () => {
      await Bun.secrets.set({
        ...o,
        value: crypto.randomUUID(),
        persist: "local",
      });
      expect(await Bun.secrets.delete(o)).toBe(true);
      expect(await Bun.secrets.get(o)).toBeNull();
      expect(await Bun.secrets.delete(o)).toBe(false);
    },
  );
});

describe("player credentials (scripts/capture/f402_login.ts)", () => {
  test("absent in both services → MissingF402CredentialsError", async () => {
    const { loadF402PlayerCredentials, MissingF402CredentialsError } =
      await import("../scripts/capture/f402_login.ts");
    const error = await loadF402PlayerCredentials({}, fakeStore()).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MissingF402CredentialsError);
  });

  test("canonical first, legacy fallback", async () => {
    const { loadF402PlayerCredentials } =
      await import("../scripts/capture/f402_login.ts");
    const store = fakeStore({
      [canonical("f402-player-id")]: "p-1",
      [legacy("f402-player-password")]: PASSWORD,
    });
    const identity = await loadF402PlayerCredentials({}, store);
    expect(identity.loginId).toBe("p-1");
    expect(identity.password === PASSWORD).toBe(true);
  });

  test("a failing store surfaces its named error instead of looking like 'missing'", async () => {
    const { loadF402PlayerCredentials } =
      await import("../scripts/capture/f402_login.ts");
    const store = fakeStore(
      {},
      {
        throwOn: () =>
          bunError(
            "ERR_SECRETS_PLATFORM_ERROR",
            "Cannot autolaunch D-Bus without X11 $DISPLAY",
          ),
      },
    );
    const error = await loadF402PlayerCredentials({}, store).catch((e) => e);
    expect(error).toBeInstanceOf(F402KeychainUnavailable);
  });
});

describe("f402SessionStoreExitCode", () => {
  test("maps config, unavailable, other store errors and anything else", async () => {
    const { f402SessionStoreExitCode } = await import("../lib/f402_session.ts");
    expect(f402SessionStoreExitCode(new F402SessionStoreConfigError("x"))).toBe(
      2,
    );
    expect(
      f402SessionStoreExitCode(
        new F402KeychainUnavailable(ctx, "ERR_SECRETS_PLATFORM_ERROR", "x"),
      ),
    ).toBe(3);
    expect(
      f402SessionStoreExitCode(
        new F402SecretAccessDenied(ctx, "ERR_SECRETS_ACCESS_DENIED", "x"),
      ),
    ).toBe(4);
    expect(f402SessionStoreExitCode(new Error("x"))).toBe(1);
  });
});
