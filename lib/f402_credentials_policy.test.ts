import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  loadF402CredentialsSecure,
  wrapF402Credentials,
} from "./f402_credentials_policy.ts";

const SENTINEL_PASSWORD = "super-secret-sentinel-password-xyzzy";

describe("F402 credentials inspect safety", () => {
  const origIsTTY = process.stdin.isTTY;
  beforeAll(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterAll(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
  });

  test("Bun.inspect never contains password substring", () => {
    const creds = wrapF402Credentials(
      { agentId: "agent-118", password: SENTINEL_PASSWORD },
      "keychain",
    );
    const inspected = Bun.inspect(creds);
    expect(inspected).not.toContain(SENTINEL_PASSWORD);
    expect(inspected).not.toContain("xyzzy");
    expect(inspected).toContain("keychain");
  });

  test("deprecated env path wraps with inspect-safe source (with reader returning null)", async () => {
    let getCallCount = 0;
    const fakeReader = {
      async get() {
        getCallCount++;
        return null;
      },
    };
    const creds = await loadF402CredentialsSecure(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "a1",
        F402_PASSWORD: SENTINEL_PASSWORD,
      },
      fakeReader,
    );
    expect(Bun.inspect(creds)).not.toContain(SENTINEL_PASSWORD);
    expect(creds.credentialSource).toBe("deprecated-env");
    expect(creds.password).toBe(SENTINEL_PASSWORD);
    expect(getCallCount).toBeGreaterThan(0);
  });

  test("deprecated env path wraps with inspect-safe source (explicit null guard)", async () => {
    const creds = await loadF402CredentialsSecure(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "a1",
        F402_PASSWORD: SENTINEL_PASSWORD,
      },
      null,
    );
    expect(Bun.inspect(creds)).not.toContain(SENTINEL_PASSWORD);
    expect(creds.credentialSource).toBe("deprecated-env");
    expect(creds.password).toBe(SENTINEL_PASSWORD);
  });

  test("keychain reader trims whitespace and returns keychain credentials", async () => {
    const fakeReader = {
      async get(options: { service: string; name: string }) {
        if (options.name === "f402-agent-id") return "  agent-trimmed  ";
        if (options.name === "f402-password") return "  secret-trimmed  ";
        return null;
      },
    };
    const creds = await loadF402CredentialsSecure(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "env-agent",
        F402_PASSWORD: "env-password",
      },
      fakeReader,
    );
    expect(creds.credentialSource).toBe("keychain");
    expect(creds.agentId).toBe("agent-trimmed");
    expect(creds.password).toBe("secret-trimmed");
  });

  test("locked keychain errors fall through gracefully to env fallback", async () => {
    const throwingReader = {
      async get() {
        throw new Error(
          "ERR_SECRETS_PLATFORM_ERROR: Authorization denied (code: -60005)",
        );
      },
    };
    const creds = await loadF402CredentialsSecure(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "a1",
        F402_PASSWORD: SENTINEL_PASSWORD,
      },
      throwingReader,
    );
    expect(creds.credentialSource).toBe("deprecated-env");
    expect(creds.agentId).toBe("a1");
    expect(creds.password).toBe(SENTINEL_PASSWORD);
  });
});
