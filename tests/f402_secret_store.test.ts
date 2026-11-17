import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifySecretsError,
  F402KeychainUnavailable,
  F402SecretBackendError,
  F402SecretNotFound,
  migrateLegacyF402Secrets,
  probeSecretsBackend,
  readF402SecretStrict,
  requireF402Secret,
  setSecretsAdapterForTests,
  writeF402Secret,
  type SecretsAdapter,
} from "../lib/f402_secret_store.ts";
import {
  F402_SESSION_SECRET_NAME,
  flushF402SessionWrites,
  loadF402Session,
  readF402Session,
  resetF402SessionCacheForTests,
  resolveF402SessionStore,
  saveF402Session,
  sessionFromAuth,
  writeF402Session,
} from "../lib/f402_session.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  KeychainTimeoutError,
  LEGACY_SECRETS_SERVICE,
} from "../lib/secrets.ts";

/** In-memory Bun.secrets stand-in that records every call by service/name (never by value). */
function fakeStore(
  entries: Record<string, string> = {},
  options: { readonly throwOn?: (op: string) => unknown } = {},
): SecretsAdapter & {
  readonly calls: string[];
  readonly entries: Record<string, string>;
} {
  const calls: string[] = [];
  return {
    calls,
    entries,
    async get({ service, name }) {
      calls.push(`get ${service}/${name}`);
      const thrown = options.throwOn?.("get");
      if (thrown !== undefined) throw thrown;
      return entries[`${service}/${name}`] ?? null;
    },
    async set({ service, name, value }) {
      calls.push(`set ${service}/${name}`);
      const thrown = options.throwOn?.("set");
      if (thrown !== undefined) throw thrown;
      entries[`${service}/${name}`] = value;
    },
    async delete({ service, name }) {
      calls.push(`delete ${service}/${name}`);
      const key = `${service}/${name}`;
      const had = key in entries;
      delete entries[key];
      return had;
    },
  };
}

function bunError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const PASSWORD = "pw-Zq8!unit-only-not-real";
const canonical = (name: string) => `${CANONICAL_SECRETS_SERVICE}/${name}`;
const legacy = (name: string) => `${LEGACY_SECRETS_SERVICE}/${name}`;

afterEach(() => {
  setSecretsAdapterForTests(null);
  resetF402SessionCacheForTests();
});

describe("readF402SecretStrict / requireF402Secret", () => {
  test("canonical wins; legacy is not consulted when canonical has it", async () => {
    const store = fakeStore({
      [canonical(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
    });
    const found = await readF402SecretStrict(F402_KEYCHAIN_NAMES.password, {
      adapter: store,
    });
    expect(found?.service).toBe(CANONICAL_SECRETS_SERVICE);
    expect(store.calls).toEqual([
      `get ${canonical(F402_KEYCHAIN_NAMES.password)}`,
    ]);
  });

  test("falls back to legacy read-only: no set or delete ever reaches legacy", async () => {
    const store = fakeStore({
      [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
    });
    const found = await readF402SecretStrict(F402_KEYCHAIN_NAMES.password, {
      adapter: store,
    });
    expect(found?.service).toBe(LEGACY_SECRETS_SERVICE);
    expect(store.calls.filter((call) => !call.startsWith("get "))).toEqual([]);
  });

  test("absent in both services → null; require → F402SecretNotFound", async () => {
    const store = fakeStore();
    expect(
      await readF402SecretStrict("f402-password", { adapter: store }),
    ).toBeNull();
    const error = await requireF402Secret("f402-password", {
      adapter: store,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretNotFound);
    expect(error.name).toBe("F402SecretNotFound");
    expect(error.message).toContain(CANONICAL_SECRETS_SERVICE);
    expect(error.message).toContain(LEGACY_SECRETS_SERVICE);
  });

  test("blank stored value counts as absent", async () => {
    const store = fakeStore({ [canonical("f402-password")]: "   " });
    expect(
      await readF402SecretStrict("f402-password", { adapter: store }),
    ).toBeNull();
  });

  test("no Secret Service on the bus → F402KeychainUnavailable (not 'absent')", async () => {
    const store = fakeStore(
      {},
      {
        throwOn: () =>
          bunError(
            "ERR_SECRETS_PLATFORM_ERROR",
            "The name org.freedesktop.secrets was not provided by any .service files (code: 2)",
          ),
      },
    );
    const error = await readF402SecretStrict("f402-password", {
      adapter: store,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402KeychainUnavailable);
    expect(error.bunCode).toBe("ERR_SECRETS_PLATFORM_ERROR");
    expect(error.op).toBe("get");
  });
});

describe("classifySecretsError", () => {
  const ctx = { service: "svc", name: "n", op: "get" as const };
  test.each([
    ["Could not connect: No such file or directory (code: 1)"],
    ["libsecret not available"],
    [
      "The name org.freedesktop.secrets was not provided by any .service files (code: 2)",
    ],
  ])("platform error %p → F402KeychainUnavailable", (message) => {
    const named = classifySecretsError(
      bunError("ERR_SECRETS_PLATFORM_ERROR", message),
      ctx,
    );
    expect(named.name).toBe("F402KeychainUnavailable");
  });

  test.each([
    "ERR_SECRETS_ACCESS_DENIED",
    "ERR_SECRETS_USER_CANCELED",
    "ERR_SECRETS_INTERACTION_NOT_ALLOWED",
    "ERR_SECRETS_AUTH_FAILED",
    "ERR_SECRETS_INTERACTION_REQUIRED",
  ])("%s → F402SecretBackendError with the Bun code", (code) => {
    const named = classifySecretsError(bunError(code, "denied"), ctx);
    expect(named).toBeInstanceOf(F402SecretBackendError);
    expect(named.bunCode).toBe(code);
  });

  test("timeout → F402KeychainUnavailable(KEYCHAIN_TIMEOUT)", () => {
    const named = classifySecretsError(new KeychainTimeoutError(ctx, 500), ctx);
    expect(named.name).toBe("F402KeychainUnavailable");
    expect(named.bunCode).toBe("KEYCHAIN_TIMEOUT");
  });
});

describe("writeF402Secret / migrateLegacyF402Secrets", () => {
  test("writes only the canonical service, persist local", async () => {
    const store = fakeStore();
    await writeF402Secret("f402-password", PASSWORD, { adapter: store });
    expect(store.calls).toEqual([`set ${canonical("f402-password")}`]);
  });

  test("refuses an empty value (Bun.secrets would treat it as delete)", async () => {
    const store = fakeStore();
    const error = await writeF402Secret("f402-password", "", {
      adapter: store,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretBackendError);
    expect(store.calls).toEqual([]);
  });

  test("migrate copies legacy → canonical, leaves legacy untouched, never overwrites canonical", async () => {
    const store = fakeStore({
      [legacy(F402_KEYCHAIN_NAMES.password)]: PASSWORD,
      [legacy(F402_KEYCHAIN_NAMES.agentId)]: "legacy-agent",
      [canonical(F402_KEYCHAIN_NAMES.agentId)]: "canonical-agent",
    });
    const results = await migrateLegacyF402Secrets(
      [
        F402_KEYCHAIN_NAMES.agentId,
        F402_KEYCHAIN_NAMES.password,
        "f402-player-id",
      ],
      { adapter: store },
    );
    expect(results).toEqual([
      { name: F402_KEYCHAIN_NAMES.agentId, outcome: "canonical-present" },
      { name: F402_KEYCHAIN_NAMES.password, outcome: "copied" },
      { name: "f402-player-id", outcome: "absent" },
    ]);
    expect(store.entries[canonical(F402_KEYCHAIN_NAMES.agentId)]).toBe(
      "canonical-agent",
    );
    expect(store.entries[canonical(F402_KEYCHAIN_NAMES.password)]).toBe(
      PASSWORD,
    );
    expect(store.entries[legacy(F402_KEYCHAIN_NAMES.password)]).toBe(PASSWORD);
    const legacyWrites = store.calls.filter(
      (call) =>
        !call.startsWith("get ") && call.includes(LEGACY_SECRETS_SERVICE),
    );
    expect(legacyWrites).toEqual([]);
  });
});

describe("session store", () => {
  const session = sessionFromAuth(
    {
      cookieHeader: "ASP.NET_SessionId=cookie-secret-value",
      cookieNames: ["ASP.NET_SessionId"],
    },
    { ttlMinutes: 60 },
  );

  test("F402_SESSION_STORE selects the store; default is file", () => {
    expect(resolveF402SessionStore({})).toBe("file");
    expect(resolveF402SessionStore({ F402_SESSION_STORE: "KEYCHAIN" })).toBe(
      "keychain",
    );
    expect(resolveF402SessionStore({ F402_SESSION_STORE: "other" })).toBe(
      "file",
    );
  });

  test("keychain: save → load round trip; sync read answers only after load; no file written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f402-session-store-"));
    const prev = process.env.F402_SESSION_FILE;
    process.env.F402_SESSION_FILE = join(dir, "f402-session.json");
    try {
      const store = fakeStore();
      setSecretsAdapterForTests(store);
      expect(readF402Session({ store: "keychain" })).toBeNull();
      const where = await saveF402Session(session, { store: "keychain" });
      expect(where).toBe(
        `keychain:${CANONICAL_SECRETS_SERVICE}/${F402_SESSION_SECRET_NAME}`,
      );
      resetF402SessionCacheForTests();
      expect(readF402Session({ store: "keychain" })).toBeNull();
      const loaded = await loadF402Session({ store: "keychain" });
      expect(loaded?.cookieNames).toEqual(["ASP.NET_SessionId"]);
      expect(readF402Session({ store: "keychain" })?.cookieHeader).toBe(
        session.cookieHeader,
      );
      expect(readdirSync(dir)).toEqual([]);
      expect(store.calls).toContain(
        `set ${canonical(F402_SESSION_SECRET_NAME)}`,
      );
    } finally {
      if (prev === undefined) delete process.env.F402_SESSION_FILE;
      else process.env.F402_SESSION_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keychain: sync write updates this process at once and flush awaits the store", async () => {
    const store = fakeStore();
    setSecretsAdapterForTests(store);
    writeF402Session(session, { store: "keychain" });
    expect(readF402Session({ store: "keychain" })?.expiresAtIso).toBe(
      session.expiresAtIso,
    );
    await flushF402SessionWrites();
    expect(store.entries[canonical(F402_SESSION_SECRET_NAME)]).toBeDefined();
  });

  test("keychain: expired or malformed stored session → null", async () => {
    const expired = sessionFromAuth(
      { cookieHeader: "a=b", cookieNames: ["a"] },
      { ttlMinutes: 1, now: Date.now() - 10 * 60_000 },
    );
    setSecretsAdapterForTests(
      fakeStore({
        [canonical(F402_SESSION_SECRET_NAME)]: JSON.stringify(expired),
      }),
    );
    expect(await loadF402Session({ store: "keychain" })).toBeNull();
    setSecretsAdapterForTests(
      fakeStore({ [canonical(F402_SESSION_SECRET_NAME)]: "{not json" }),
    );
    expect(await loadF402Session({ store: "keychain" })).toBeNull();
  });

  test("keychain unavailable surfaces as a named error from load", async () => {
    setSecretsAdapterForTests(
      fakeStore(
        {},
        {
          throwOn: () =>
            bunError(
              "ERR_SECRETS_PLATFORM_ERROR",
              "Could not connect: x (code: 1)",
            ),
        },
      ),
    );
    const error = await loadF402Session({ store: "keychain" }).catch((e) => e);
    expect(error.name).toBe("F402KeychainUnavailable");
  });
});

describe("no secret value in logs or errors", () => {
  test("values never appear in error messages, even when the backend echoes them", async () => {
    const leaky = fakeStore(
      {},
      {
        throwOn: (op) =>
          op === "set"
            ? bunError("ERR_SECRETS_ACCESS_DENIED", `refused value ${PASSWORD}`)
            : undefined,
      },
    );
    const error = await writeF402Secret("f402-password", PASSWORD, {
      adapter: leaky,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(F402SecretBackendError);
    expect(error.message).not.toContain(PASSWORD);
    expect(String(error.stack)).not.toContain(PASSWORD);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect(Bun.inspect(error)).not.toContain(PASSWORD);
  });

  test("console output across store flows never contains the password or cookie", async () => {
    const seen: string[] = [];
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
    };
    for (const key of ["log", "error", "warn"] as const) {
      console[key] = (...args: unknown[]) => {
        seen.push(args.map((arg) => Bun.inspect(arg)).join(" "));
      };
    }
    try {
      const cookie = "ASP.NET_SessionId=cookie-secret-value-xyz";
      const s = sessionFromAuth({
        cookieHeader: cookie,
        cookieNames: ["ASP.NET_SessionId"],
      });
      // Failing keychain: the queued write logs a named error.
      // Worst case: a backend that echoes whatever it was handed into its error text.
      setSecretsAdapterForTests(
        fakeStore(
          {},
          {
            throwOn: () =>
              bunError(
                "ERR_SECRETS_PLATFORM_ERROR",
                `Could not connect ${cookie}`,
              ),
          },
        ),
      );
      writeF402Session(s, { store: "keychain" });
      await flushF402SessionWrites().catch((e) => console.error(e));
      await saveF402Session(s, { store: "keychain" }).catch((e) =>
        console.error(e),
      );
      resetF402SessionCacheForTests();
      readF402Session({ store: "keychain" }); // unloaded warning
      setSecretsAdapterForTests(
        fakeStore(
          {},
          {
            throwOn: () =>
              bunError("ERR_SECRETS_ACCESS_DENIED", `refused ${PASSWORD}`),
          },
        ),
      );
      await writeF402Secret("f402-password", PASSWORD).catch((e) =>
        console.error(e),
      );
      expect(seen.length).toBeGreaterThan(0);
      const all = seen.join("\n");
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain("cookie-secret-value-xyz");
    } finally {
      Object.assign(console, original);
    }
  });
});

/**
 * Integration: real Bun.secrets, throwaway service only (never the real F402 entries), cleaned
 * up afterwards. Skips with a named reason when this machine has no usable backend; on macOS it
 * also needs F402_SECRETS_INTEGRATION=1 so `bun test` never raises a Keychain dialog.
 */
const THROWAWAY = `${CANONICAL_SECRETS_SERVICE}.test-${crypto.randomUUID().slice(0, 8)}`;
const darwinOptIn =
  process.platform !== "darwin" || Bun.env.F402_SECRETS_INTEGRATION === "1";
const probe = darwinOptIn
  ? await probeSecretsBackend({ adapter: Bun.secrets, service: THROWAWAY })
  : null;
const skipReason =
  probe === null
    ? "skipped: macOS needs F402_SECRETS_INTEGRATION=1"
    : probe.available
      ? ""
      : `skipped: ${probe.error.name} (${probe.error.bunCode ?? "no code"})`;

describe(`Bun.secrets integration ${skipReason}`.trim(), () => {
  test.skipIf(skipReason !== "")(
    "throwaway set/get/delete round trip",
    async () => {
      const value = crypto.randomUUID();
      const name = "roundtrip";
      try {
        await Bun.secrets.set({ service: THROWAWAY, name, value });
        const found = await readF402SecretStrict(name, {
          adapter: Bun.secrets,
          services: [THROWAWAY],
          timeoutMs: 5_000,
        });
        expect(found?.value === value).toBe(true);
        expect(found?.service).toBe(THROWAWAY);
      } finally {
        expect(await Bun.secrets.delete({ service: THROWAWAY, name })).toBe(
          true,
        );
      }
      expect(await Bun.secrets.get({ service: THROWAWAY, name })).toBeNull();
    },
  );
});

describe("Linux backend errors (child process, unreachable D-Bus)", () => {
  test.skipIf(process.platform !== "linux")(
    "no D-Bus session → F402KeychainUnavailable / ERR_SECRETS_PLATFORM_ERROR",
    async () => {
      const code = `
        import { readF402SecretStrict } from ${JSON.stringify(join(import.meta.dir, "../lib/f402_secret_store.ts"))};
        try { await readF402SecretStrict("x", { services: [${JSON.stringify(THROWAWAY)}], timeoutMs: 5000 }); console.log("ok"); }
        catch (e) { console.log(e.name + " " + e.bunCode); }
      `;
      const proc = Bun.spawn([process.execPath, "-e", code], {
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/f402-test-bus",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      expect(out).toBe("F402KeychainUnavailable ERR_SECRETS_PLATFORM_ERROR");
    },
  );
});

describe("secrets:f402 CLI against an unreachable keychain (Linux)", () => {
  const cli = join(import.meta.dir, "../scripts/secrets_f402.ts");
  const deadBus = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/f402-test-bus",
  };

  test.skipIf(process.platform !== "linux")(
    "probe → exit 3 with the named error",
    async () => {
      const proc = Bun.spawn([process.execPath, cli, "probe"], {
        env: deadBus,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(3);
      expect(stderr).toContain("F402KeychainUnavailable");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "set reads stdin, fails closed with exit 3, and never echoes the value",
    async () => {
      const proc = Bun.spawn(
        [process.execPath, cli, "set", "--agent-id", "118"],
        {
          env: deadBus,
          stdin: new Blob([`${PASSWORD}\n`]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(3);
      expect(stderr).toContain("F402KeychainUnavailable");
      expect(`${stdout}${stderr}`).not.toContain(PASSWORD);
    },
  );
});
