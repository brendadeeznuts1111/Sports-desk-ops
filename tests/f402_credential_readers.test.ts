/**
 * Pins the credential-read contract for the F402 readers after audit Finding 2:
 * the writer stores canonical (`com.bookdeskops.sportsdesk`), so readers must try
 * canonical first and fall back to the legacy `sportsdesk-ops` copy (which is the
 * live one today). Player-tier credentials follow the same rule: `secrets:f402 set-player`
 * writes canonical `f402-player-*`, with env (`F402_PLAYER_ID`/`F402_PLAYER_PASSWORD`) as the
 * fallback when no pair is stored.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  F402_PLAYER_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  setSecretsProviderForTests,
  type SecretsProvider,
} from "../lib/secrets.ts";
import {
  loadF402Credentials,
  loadF402LoginIdentity,
  loadF402PlayerCredentials,
  MissingF402CredentialsError,
} from "../scripts/capture/f402_login.ts";
import { resolveAgentId } from "../scripts/capture/f402_probe.ts";

interface FakeSecrets {
  readonly reads: string[];
  readonly provider: SecretsProvider;
}

function fakeSecrets(entries: Readonly<Record<string, string>>): FakeSecrets {
  const reads: string[] = [];
  return {
    reads,
    provider: {
      async get({ service, name }) {
        const key = `${service}/${name}`;
        reads.push(key);
        return entries[key] ?? null;
      },
    },
  };
}

afterEach(() => {
  setSecretsProviderForTests(null);
});

describe("F402 agent id is canonical-first", () => {
  const name = F402_KEYCHAIN_NAMES.agentId;

  test("canonical wins over a legacy copy", async () => {
    const { provider, reads } = fakeSecrets({
      [`${CANONICAL_SECRETS_SERVICE}/${name}`]: "canonical-agent",
      [`${LEGACY_SECRETS_SERVICE}/${name}`]: "legacy-agent",
    });
    setSecretsProviderForTests(provider);

    expect(await resolveAgentId({})).toBe("canonical-agent");
    // The canonical hit short-circuits; the legacy entry is not read.
    expect(reads).toEqual([`${CANONICAL_SECRETS_SERVICE}/${name}`]);
  });

  test("legacy fallback still resolves the live split-brain copy", async () => {
    const { provider } = fakeSecrets({
      [`${LEGACY_SECRETS_SERVICE}/${name}`]: "legacy-agent",
    });
    setSecretsProviderForTests(provider);

    expect(await resolveAgentId({})).toBe("legacy-agent");
  });

  test("env wins without touching the keychain", async () => {
    const { provider, reads } = fakeSecrets({});
    setSecretsProviderForTests(provider);

    expect(await resolveAgentId({ F402_AGENT_ID: "env-agent" })).toBe(
      "env-agent",
    );
    expect(reads).toEqual([]);
  });

  test("absent and locked stores both resolve to empty", async () => {
    setSecretsProviderForTests(fakeSecrets({}).provider);
    expect(await resolveAgentId({})).toBe("");

    setSecretsProviderForTests({
      async get() {
        throw new Error("keychain locked");
      },
    });
    expect(await resolveAgentId({})).toBe("");
  });

  test("agent credentials read canonical first", async () => {
    const { provider, reads } = fakeSecrets({
      [`${CANONICAL_SECRETS_SERVICE}/${name}`]: "canonical-agent",
      [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`]:
        "canonical-password",
      [`${LEGACY_SECRETS_SERVICE}/${name}`]: "legacy-agent",
      [`${LEGACY_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`]:
        "legacy-password",
    });

    const credentials = await loadF402Credentials({}, provider);
    expect(credentials.agentId).toBe("canonical-agent");
    expect(credentials.password).toBe("canonical-password");
    expect(reads.slice(0, 2)).toEqual([
      `${CANONICAL_SECRETS_SERVICE}/${name}`,
      `${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`,
    ]);
    expect(reads).not.toContain(`${LEGACY_SECRETS_SERVICE}/${name}`);
  });
});

describe("player credentials: canonical keychain first, then env", () => {
  test("a canonical keychain pair wins over env", async () => {
    const { provider, reads } = fakeSecrets({
      [`${CANONICAL_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.playerId}`]:
        "canonical-player",
      [`${CANONICAL_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.password}`]:
        "canonical-secret",
      [`${LEGACY_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.playerId}`]:
        "legacy-player",
    });
    setSecretsProviderForTests(provider);

    expect(
      await loadF402PlayerCredentials(
        { F402_PLAYER_ID: "env-player", F402_PLAYER_PASSWORD: "env-secret" },
        provider,
      ),
    ).toEqual({
      loginId: "canonical-player",
      password: "canonical-secret",
      kind: "player",
    });
    expect(reads[0]).toBe(
      `${CANONICAL_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.playerId}`,
    );
    expect(reads.join("\n")).not.toContain("env-player");
  });

  test("legacy fallback resolves when the canonical pair is absent", async () => {
    const { provider } = fakeSecrets({
      [`${LEGACY_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.playerId}`]:
        "legacy-player",
      [`${LEGACY_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.password}`]:
        "legacy-secret",
    });
    expect(await loadF402PlayerCredentials({}, provider)).toEqual({
      loginId: "legacy-player",
      password: "legacy-secret",
      kind: "player",
    });
  });

  test("env is used when the keychain has no player pair", async () => {
    const { provider, reads } = fakeSecrets({});
    setSecretsProviderForTests(provider);

    expect(
      await loadF402PlayerCredentials(
        { F402_PLAYER_ID: "env-player", F402_PLAYER_PASSWORD: "env-secret" },
        provider,
      ),
    ).toEqual({
      loginId: "env-player",
      password: "env-secret",
      kind: "player",
    });
    expect(reads.length).toBeGreaterThan(0);
  });

  test("a locked keychain falls back to env", async () => {
    const provider: SecretsProvider = {
      async get() {
        throw new Error("keychain locked");
      },
    };
    expect(
      await loadF402PlayerCredentials(
        { F402_PLAYER_ID: "env-player", F402_PLAYER_PASSWORD: "env-secret" },
        provider,
      ),
    ).toEqual({
      loginId: "env-player",
      password: "env-secret",
      kind: "player",
    });
  });

  test("missing everywhere fails closed after keychain attempts", async () => {
    const { provider, reads } = fakeSecrets({});
    await expect(
      loadF402PlayerCredentials({}, provider),
    ).rejects.toBeInstanceOf(MissingF402CredentialsError);
    expect(reads.length).toBeGreaterThan(0);
  });

  test("the player login kind routes through the player loader", async () => {
    const { provider } = fakeSecrets({
      [`${CANONICAL_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.playerId}`]:
        "canonical-player",
      [`${CANONICAL_SECRETS_SERVICE}/${F402_PLAYER_KEYCHAIN_NAMES.password}`]:
        "canonical-secret",
    });
    expect(await loadF402LoginIdentity({}, "player", provider)).toEqual({
      loginId: "canonical-player",
      password: "canonical-secret",
      kind: "player",
    });
  });
});
