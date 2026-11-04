/**
 * The documented `Bun.secrets.get` contract is `Promise<string | null>` with required `service` and
 * `name` fields. `lib/secrets.ts` wraps it so every caller sees one shape; these tests pin that
 * shape — including the cases the docs do not describe (a keychain read that throws, a whitespace-only value).
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
  readSecretCanonicalThenLegacy,
  readSecretOrNull,
  readSecretWithSource,
  setSecretsProviderForTests,
  type SecretsProvider,
} from "../lib/secrets.ts";

interface GetCall {
  readonly service: string;
  readonly name: string;
}

function fakeProvider(impl: (options: GetCall) => Promise<string | null>): {
  provider: SecretsProvider;
  calls: GetCall[];
} {
  const calls: GetCall[] = [];
  return {
    calls,
    provider: {
      get: async (options) => {
        calls.push({ service: options.service, name: options.name });
        return impl(options);
      },
    },
  };
}

afterEach(() => {
  // Never leave a fake wired into a later test file; the real keychain is never read in this file.
  setSecretsProviderForTests(null);
});

describe("readSecretOrNull: Promise<string | null>", () => {
  test("returns a trimmed stored value and passes the required fields verbatim", async () => {
    const { provider, calls } = fakeProvider(async () => "  stored-value  ");
    setSecretsProviderForTests(provider);
    expect(await readSecretOrNull("svc", "name")).toBe("stored-value");
    expect(calls).toEqual([{ service: "svc", name: "name" }]);
  });

  test("null when the keychain has no entry (documented return)", async () => {
    const { provider } = fakeProvider(async () => null);
    setSecretsProviderForTests(provider);
    expect(await readSecretOrNull("svc", "missing")).toBeNull();
  });

  test("an empty or whitespace-only stored value is treated as missing", async () => {
    for (const value of ["", "   ", "\n\t"]) {
      const { provider } = fakeProvider(async () => value);
      setSecretsProviderForTests(provider);
      expect(await readSecretOrNull("svc", "name")).toBeNull();
    }
  });

  test("a keychain read that throws is null, never propagated", async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error("ERR_SECRETS_PLATFORM_ERROR: keychain locked");
    });
    setSecretsProviderForTests(provider);
    expect(await readSecretOrNull("svc", "name")).toBeNull();
  });
});

describe("canonical-first, legacy-second", () => {
  test("readSecretWithSource prefers the canonical service and reports it", async () => {
    const { provider, calls } = fakeProvider(async (options) =>
      options.service === CANONICAL_SECRETS_SERVICE
        ? "canonical-value"
        : "legacy-value",
    );
    setSecretsProviderForTests(provider);
    expect(await readSecretWithSource("f402-agent-id")).toEqual({
      value: "canonical-value",
      service: CANONICAL_SECRETS_SERVICE,
    });
    expect(calls).toEqual([
      { service: CANONICAL_SECRETS_SERVICE, name: "f402-agent-id" },
    ]);
    expect(CANONICAL_SECRETS_SERVICE).toBe("com.bookdeskops.sportsdesk");
  });

  test("falls back to the legacy service when the canonical entry is absent", async () => {
    const { provider, calls } = fakeProvider(async (options) =>
      options.service === LEGACY_SECRETS_SERVICE ? "legacy-value" : null,
    );
    setSecretsProviderForTests(provider);
    expect(await readSecretWithSource("f402-password")).toEqual({
      value: "legacy-value",
      service: LEGACY_SECRETS_SERVICE,
    });
    expect(calls.map((call) => call.service)).toEqual([
      CANONICAL_SECRETS_SERVICE,
      LEGACY_SECRETS_SERVICE,
    ]);
    expect(LEGACY_SECRETS_SERVICE).toBe("sportsdesk-ops");
  });

  test("both services missing is null", async () => {
    const { provider } = fakeProvider(async () => null);
    setSecretsProviderForTests(provider);
    expect(await readSecretWithSource("absent")).toBeNull();
    expect(await readSecretCanonicalThenLegacy("absent")).toBeNull();
  });

  test("the value-only helper returns the same value without the service", async () => {
    const { provider } = fakeProvider(async () => "v");
    setSecretsProviderForTests(provider);
    expect(await readSecretCanonicalThenLegacy("name")).toBe("v");
  });
});
