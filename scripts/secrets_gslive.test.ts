import { describe, expect, test } from "bun:test";

import { GSID_SECRET } from "./fetch-bet-tally.ts";
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
      store.value = null;
      return true;
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
    expect(await deleteGsliveSecret(store)).toBe(true);
    expect((await gsliveSecretStatus(store)).present).toBe(false);
  });

  test("delete removes the pre-rename GSID entry too, so it cannot resurrect the session", async () => {
    const stored = new Set(["GSLIVE_SESSION_ID", "GSID"]);
    const store: SecretStore = {
      async get(options) {
        return stored.has(options.name) ? "fixture-session" : null;
      },
      async set() {},
      async delete(options) {
        return stored.delete(options.name);
      },
    };
    expect(await deleteGsliveSecret(store)).toBe(true);
    expect(stored.size).toBe(0);
    expect((await gsliveSecretStatus(store)).present).toBe(false);
  });

  test("a session stored under the pre-rename name reads as stored", async () => {
    const store: SecretStore = {
      async get(options) {
        return options.name === "GSID" ? "fixture-session" : null;
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    expect((await gsliveSecretStatus(store)).present).toBe(true);
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
