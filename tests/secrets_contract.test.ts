/**
 * Pins the secret contract itself: one list of services per entry, canonical-first reads,
 * canonical-only writes with `persist: "local"`, and deletes that walk every service.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  CANONICAL_SECRETS_SERVICE,
  GSLIVE_LEGACY_SECRETS_SERVICE,
  GSID_SERVICES,
  F402_PLAYER_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  MissingF402CredentialsError,
  SECRET_ENTRIES,
  deleteSecret,
  readGsidSecret,
  readSecretFrom,
  secretSetOptions,
  setSecretsProviderForTests,
  writeSecret,
  type SecretsDeleter,
  type SecretsReader,
  type SecretsWriter,
} from "../lib/secrets.ts";

afterEach(() => setSecretsProviderForTests(null));

describe("secret entries", () => {
  test("canonical is the write target for every entry", () => {
    for (const entry of Object.values(SECRET_ENTRIES)) {
      expect(entry.services[0]).toBe(CANONICAL_SECRETS_SERVICE);
    }
  });

  test("the GSID reads all three services in order", () => {
    expect(SECRET_ENTRIES.gsid.services).toEqual([
      CANONICAL_SECRETS_SERVICE,
      GSLIVE_LEGACY_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
    expect(GSID_SERVICES).toEqual(SECRET_ENTRIES.gsid.services);
  });

  test("F402 agent and player-tier entries are canonical-first with the legacy fallback", () => {
    expect(SECRET_ENTRIES.f402AgentId.services).toEqual([
      CANONICAL_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
    // Player-tier entries are optional (written by `secrets:f402 set-player`) but follow the same
    // read/write contract.
    expect(SECRET_ENTRIES.f402PlayerId.services).toEqual([
      CANONICAL_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
    expect(SECRET_ENTRIES.f402PlayerId.name).toBe(
      F402_PLAYER_KEYCHAIN_NAMES.playerId,
    );
    expect(SECRET_ENTRIES.f402PlayerPassword.name).toBe(
      F402_PLAYER_KEYCHAIN_NAMES.password,
    );
    expect(new MissingF402CredentialsError()).toBeInstanceOf(Error);
  });
});

describe("readSecretFrom", () => {
  test("returns the first hit with the service it came from", async () => {
    const calls: string[] = [];
    const reader: SecretsReader = {
      async get({ service, name }) {
        calls.push(service);
        return service === GSLIVE_LEGACY_SECRETS_SERVICE && name === "GSID"
          ? "legacy-gsid"
          : null;
      },
    };

    expect(await readSecretFrom(reader, GSID_SERVICES, "GSID")).toEqual({
      value: "legacy-gsid",
      service: GSLIVE_LEGACY_SECRETS_SERVICE,
    });
    expect(calls).toEqual([
      CANONICAL_SECRETS_SERVICE,
      GSLIVE_LEGACY_SECRETS_SERVICE,
    ]);
  });

  test("a throwing reader is treated as absent", async () => {
    const reader: SecretsReader = {
      async get() {
        throw new Error("keychain locked");
      },
    };
    expect(await readSecretFrom(reader, GSID_SERVICES, "GSID")).toBeNull();
  });

  test("readGsidSecret uses the injected provider across all three", async () => {
    const seen: string[] = [];
    setSecretsProviderForTests({
      async get({ service }) {
        seen.push(service);
        return service === LEGACY_SECRETS_SERVICE ? "bridge-gsid" : null;
      },
    });

    expect(await readGsidSecret()).toBe("bridge-gsid");
    expect(seen).toEqual([
      CANONICAL_SECRETS_SERVICE,
      GSLIVE_LEGACY_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
  });
});

describe("writes and deletes", () => {
  test("writeSecret writes canonical with persist local and validates bounds", async () => {
    const writes: Record<string, unknown>[] = [];
    const writer: SecretsWriter = {
      async set(options) {
        writes.push({ ...options });
      },
    };

    await writeSecret(SECRET_ENTRIES.f402Password, "secret-value", writer);
    expect(writes).toEqual([
      {
        service: CANONICAL_SECRETS_SERVICE,
        name: "f402-password",
        value: "secret-value",
        persist: "local",
      },
    ]);

    await expect(
      writeSecret(SECRET_ENTRIES.f402Password, "", writer),
    ).rejects.toThrow(/2048/);
    expect(writes).toHaveLength(1);
  });

  test("deleteSecret walks every service and counts the removals", async () => {
    const calls: string[] = [];
    const deleter: SecretsDeleter = {
      async delete({ service }) {
        calls.push(service);
        return service === CANONICAL_SECRETS_SERVICE;
      },
    };

    expect(await deleteSecret(SECRET_ENTRIES.gsid, deleter)).toBe(1);
    expect(calls).toEqual([
      CANONICAL_SECRETS_SERVICE,
      GSLIVE_LEGACY_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
  });

  test("secretSetOptions rejects non-printable service names", () => {
    expect(() => secretSetOptions("bad\nservice", "name", "value")).toThrow(
      /printable ASCII/,
    );
  });
});
