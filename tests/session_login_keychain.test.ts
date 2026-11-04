import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  setSecretsProviderForTests,
  type SecretsProvider,
} from "../lib/secrets.ts";
import { resolveLoginCredentials } from "../scripts/session_login.ts";

/**
 * `resolveLoginCredentials` is the pure half of `session:login --from-keychain`: it decides the
 * credential SOURCE (env / keychain) without writing a file or logging a value. The CLI itself is
 * only exercised for the fail-closed exit paths here, so the real keychain and the real session
 * file are never touched.
 */

const dir = mkdtempSync(join(tmpdir(), "session-login-keychain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setSecretsProviderForTests(null));

const script = join(import.meta.dir, "../scripts/session_login.ts");

interface KeychainFixture {
  readonly provider: SecretsProvider;
  readonly reads: readonly string[];
}

/** In-memory keychain: map of `<service>/<name>` to value. */
function keychain(
  entries: Readonly<Record<string, string>>,
  options: { readonly throwOnRead?: boolean } = {},
): KeychainFixture {
  const reads: string[] = [];
  const provider: SecretsProvider = {
    async get({ service, name }) {
      reads.push(`${service}/${name}`);
      if (options.throwOnRead === true) throw new Error("keychain locked");
      return entries[`${service}/${name}`] ?? null;
    },
  };
  return { provider, reads };
}

const canonicalEntries = {
  [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`]: "agent-118",
  [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`]:
    "keychain-password",
};

const GATED_ENV = { F402_LIVE_LOGIN: "1" } as const;

describe("resolveLoginCredentials", () => {
  test("reads both credentials from the canonical service", async () => {
    const { provider, reads } = keychain(canonicalEntries);
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: true,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.credentials).toEqual({
      agentId: "agent-118",
      password: "keychain-password",
      source: "keychain",
    });
    expect(reads).toEqual([
      `${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`,
      `${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`,
    ]);
  });

  test("falls back to the legacy service per entry", async () => {
    const { provider } = keychain({
      [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`]:
        "canonical-agent",
      [`${LEGACY_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`]:
        "legacy-password",
    });
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: true,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.credentials.agentId).toBe("canonical-agent");
    expect(resolved.credentials.password).toBe("legacy-password");
    expect(resolved.credentials.source).toBe("keychain");
  });

  test("env credentials win over the keychain when both are present", async () => {
    const { provider, reads } = keychain(canonicalEntries);
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: {
        F402_LIVE_LOGIN: "1",
        F402_AGENT_ID: "env-agent",
        F402_PASSWORD: "env-password",
      },
      fromKeychain: true,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.credentials).toEqual({
      agentId: "env-agent",
      password: "env-password",
      source: "env",
    });
    expect(reads).toEqual([]);
  });

  test("refuses before reading the keychain when F402_LIVE_LOGIN is unset", async () => {
    const { provider, reads } = keychain({});
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: {
        F402_AGENT_ID: "env-agent",
        F402_PASSWORD: "env-password",
      },
      fromKeychain: true,
    });

    expect(resolved).toEqual({ ok: false, reason: "live-login-disabled" });
    expect(reads).toEqual([]);
  });

  test("one missing keychain value fails closed and names the service", async () => {
    const { provider } = keychain({
      [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`]:
        "agent-118",
    });
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: true,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("missing-keychain-credentials");
    if (resolved.reason !== "missing-keychain-credentials") return;
    expect(resolved.missing).toEqual([F402_KEYCHAIN_NAMES.password]);
    expect(resolved.service).toBe(CANONICAL_SECRETS_SERVICE);
    expect(resolved.message).toContain(CANONICAL_SECRETS_SERVICE);
    expect(resolved.message).toContain(LEGACY_SECRETS_SERVICE);
    expect(resolved.message).toContain(F402_KEYCHAIN_NAMES.password);
    expect(resolved.message).not.toContain("keychain-password");
  });

  test("a throwing provider and blank values are treated as missing", async () => {
    setSecretsProviderForTests(keychain({}, { throwOnRead: true }).provider);
    const thrown = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: true,
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok && thrown.reason === "missing-keychain-credentials") {
      expect(thrown.missing).toEqual([
        F402_KEYCHAIN_NAMES.agentId,
        F402_KEYCHAIN_NAMES.password,
      ]);
    } else {
      throw new Error("expected missing-keychain-credentials");
    }

    setSecretsProviderForTests(
      keychain({
        [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.agentId}`]: "   ",
        [`${CANONICAL_SECRETS_SERVICE}/${F402_KEYCHAIN_NAMES.password}`]: "",
      }).provider,
    );
    const blank = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: true,
    });
    expect(blank).toMatchObject({
      ok: false,
      reason: "missing-keychain-credentials",
    });
  });

  test("without --from-keychain, missing env credentials stay a usage error", async () => {
    const { provider, reads } = keychain(canonicalEntries);
    setSecretsProviderForTests(provider);

    const resolved = await resolveLoginCredentials({
      env: GATED_ENV,
      fromKeychain: false,
    });

    expect(resolved).toEqual({ ok: false, reason: "missing-env-credentials" });
    expect(reads).toEqual([]);
  });
});

describe("session:login CLI fail-closed paths", () => {
  function run(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", script, ...args],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: Bun.env["PATH"] ?? "",
        HOME: Bun.env["HOME"] ?? "",
        ...env,
      },
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    };
  }

  test("--from-keychain still refuses without F402_LIVE_LOGIN=1 and writes no file", () => {
    const sessionPath = join(dir, "gate-session.json");
    const result = run(["--from-keychain"], {
      F402_SESSION_FILE: sessionPath,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("F402_LIVE_LOGIN=1");
    expect(result.err).toContain("--from-keychain");
    expect(existsSync(sessionPath)).toBe(false);
  });

  test("missing env credentials exit 2 and write no file", () => {
    const sessionPath = join(dir, "missing-session.json");
    const result = run([], {
      F402_LIVE_LOGIN: "1",
      F402_SESSION_FILE: sessionPath,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("F402_AGENT_ID and F402_PASSWORD");
    expect(existsSync(sessionPath)).toBe(false);
  });

  test("--from-keychain with only one env value does not run a login", () => {
    // One env value is not enough to open the gate and does not mix with a keychain read: the
    // resolver refuses before any network/WebView work, and no session file appears.
    const sessionPath = join(dir, "one-env-session.json");
    const result = run([], {
      F402_LIVE_LOGIN: "1",
      F402_AGENT_ID: "agent-only",
      F402_SESSION_FILE: sessionPath,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("F402_AGENT_ID and F402_PASSWORD");
    expect(existsSync(sessionPath)).toBe(false);
  });
});
