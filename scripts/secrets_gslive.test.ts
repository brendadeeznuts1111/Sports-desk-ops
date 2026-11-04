import { describe, expect, test } from "bun:test";

import { GSID_SECRET, GSID_SECRET_LEGACY } from "./fetch-bet-tally.ts";
import { LEGACY_SECRETS_SERVICE } from "../lib/secrets.ts";
import {
  deleteGsliveSecret,
  gsliveSecretStatus,
  setGsliveSecret,
  type SecretStore,
} from "./secrets_gslive.ts";

interface MemoryStore extends SecretStore {
  value: string | null;
  readonly calls: string[];
}

function memoryStore(initial: string | null = null): MemoryStore {
  const store: MemoryStore = {
    value: initial,
    calls: [],
    async get() {
      store.calls.push("get");
      return store.value;
    },
    async set(options) {
      store.calls.push(`set:${options.persist ?? "none"}`);
      store.value = options.value;
    },
    async delete() {
      store.calls.push("delete");
      const had = store.value !== null;
      store.value = null;
      return had;
    },
  };
  return store;
}

describe("secrets:gslive keychain helper", () => {
  test("status reports absent then stored without exposing the value", async () => {
    const store = memoryStore();
    expect(await gsliveSecretStatus(store)).toEqual({
      service: GSID_SECRET.service,
      name: GSID_SECRET.name,
      present: false,
    });

    expect(await setGsliveSecret("  fixture-session  ", store)).toBe("stored");
    expect(store.value).toBe("fixture-session");
    expect(store.calls).toContain("set:local");

    const status = await gsliveSecretStatus(store);
    expect(status.present).toBe(true);
    expect(JSON.stringify(status)).not.toContain("fixture-session");
  });

  test("an oversized value is refused before the keychain write", async () => {
    const store = memoryStore("existing");
    await expect(setGsliveSecret("x".repeat(2049), store)).rejects.toThrow(
      /2048/,
    );
    expect(store.calls).not.toContain("set:local");
  });

  test("empty input is refused and never written", async () => {
    const store = memoryStore("existing");
    expect(await setGsliveSecret("   \n", store)).toBe("empty");
    expect(store.value).toBe("existing");
    expect(store.calls).not.toContain("set");
  });

  test("delete clears the entry and status returns to absent", async () => {
    const store = memoryStore("fixture-session");
    expect(await deleteGsliveSecret(store)).toBe(1);
    expect((await gsliveSecretStatus(store)).present).toBe(false);
  });

  test("an unreadable keychain reports absent, not stored", async () => {
    const store: SecretStore = {
      async get() {
        throw new Error("keychain locked");
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    expect((await gsliveSecretStatus(store)).present).toBe(false);
  });
});

/** Multi-service store keyed by `<service>/<name>`, with call recording. */
function serviceStore(
  entries: Readonly<Record<string, string>>,
): SecretStore & { readonly calls: string[] } {
  const map = new Map(Object.entries(entries));
  const calls: string[] = [];
  return {
    calls,
    async get({ service, name }) {
      const key = `${service}/${name}`;
      calls.push(`get:${key}`);
      return map.get(key) ?? null;
    },
    async set(options) {
      map.set(`${options.service}/${options.name}`, options.value);
    },
    async delete({ service, name }) {
      const key = `${service}/${name}`;
      calls.push(`delete:${key}`);
      return map.delete(key);
    },
  };
}

describe("secrets:gslive service reporting", () => {
  test("status names the legacy service that actually holds the session", async () => {
    const store = serviceStore({
      [`${GSID_SECRET_LEGACY.service}/${GSID_SECRET_LEGACY.name}`]:
        "legacy-session",
    });
    expect(await gsliveSecretStatus(store)).toEqual({
      service: GSID_SECRET_LEGACY.service,
      name: GSID_SECRET_LEGACY.name,
      present: true,
    });
  });

  test("status also finds the bridge legacy service", async () => {
    const store = serviceStore({
      [`${LEGACY_SECRETS_SERVICE}/${GSID_SECRET.name}`]: "bridge-legacy",
    });
    expect(await gsliveSecretStatus(store)).toEqual({
      service: LEGACY_SECRETS_SERVICE,
      name: GSID_SECRET.name,
      present: true,
    });
  });

  test("canonical wins when all three services hold a value", async () => {
    const store = serviceStore({
      [`${GSID_SECRET.service}/${GSID_SECRET.name}`]: "canonical",
      [`${GSID_SECRET_LEGACY.service}/${GSID_SECRET_LEGACY.name}`]: "legacy",
      [`${LEGACY_SECRETS_SERVICE}/${GSID_SECRET.name}`]: "bridge",
    });
    expect((await gsliveSecretStatus(store)).service).toBe(GSID_SECRET.service);
  });

  test("delete removes every service so a stale copy cannot resurface", async () => {
    const store = serviceStore({
      [`${GSID_SECRET.service}/${GSID_SECRET.name}`]: "canonical",
      [`${GSID_SECRET_LEGACY.service}/${GSID_SECRET_LEGACY.name}`]: "legacy",
      [`${LEGACY_SECRETS_SERVICE}/${GSID_SECRET.name}`]: "bridge",
    });
    expect(await deleteGsliveSecret(store)).toBe(3);
    expect((await gsliveSecretStatus(store)).present).toBe(false);
  });
});
