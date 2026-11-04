import { describe, expect, test } from "bun:test";

import {
  loadF402CredentialsSecure,
  wrapF402Credentials,
} from "./f402_credentials_policy.ts";

const SENTINEL_PASSWORD = "super-secret-sentinel-password-xyzzy";

describe("F402 credentials inspect safety", () => {
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

  test("deprecated env path wraps with inspect-safe source", async () => {
    const creds = await loadF402CredentialsSecure(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "a1",
        F402_PASSWORD: SENTINEL_PASSWORD,
      },
      // An empty fake store, not `null`: `null` would spawn the real `security` CLI.
      {
        async get() {
          return null;
        },
      },
    );
    expect(Bun.inspect(creds)).not.toContain(SENTINEL_PASSWORD);
    expect(creds.credentialSource).toBe("deprecated-env");
    expect(creds.password).toBe(SENTINEL_PASSWORD);
  });
});
