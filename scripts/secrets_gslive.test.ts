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
      store.calls.push("set");
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

    const status = await gsliveSecretStatus(store);
    expect(status.present).toBe(true);
    expect(JSON.stringify(status)).not.toContain("fixture-session");
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
