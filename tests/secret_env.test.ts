import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  childEnv,
  describeSource,
  expandSecretSelection,
  resolveSecretEnv,
  SECRET_ENV_GROUPS,
  SECRET_ENV_NAMES,
} from "../lib/secret_env.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
} from "../lib/secrets.ts";
import { UsageError } from "../lib/usage_error.ts";

const ROOT = path.join(import.meta.dir, "..");
const SECRETS_ENV = path.join(ROOT, "scripts/secrets_env.ts");

/** A keychain stand-in: the real one is never read by these tests. */
function fakeKeychain(
  entries: Record<string, { value: string; service: string }>,
) {
  return async (name: string) => entries[name] ?? null;
}

describe("expandSecretSelection", () => {
  test("a group expands to its names, sorted and de-duplicated across groups", () => {
    expect(expandSecretSelection(["pages", "r2"])).toEqual(
      [
        ...new Set([...SECRET_ENV_GROUPS.pages, ...SECRET_ENV_GROUPS.r2]),
      ].sort(),
    );
  });

  test("a variable name selects just that name", () => {
    expect(expandSecretSelection(["GSLIVE_SESSION_ID"])).toEqual([
      "GSLIVE_SESSION_ID",
    ]);
  });

  test("an unknown token is a usage error, not an empty selection", () => {
    expect(() => expandSecretSelection(["pagess"])).toThrow(UsageError);
    expect(() => expandSecretSelection(["F402_PASSWORD"])).toThrow(UsageError);
  });

  test("F402 credentials are never injectable: the F402 scripts read the keychain themselves", () => {
    expect(SECRET_ENV_NAMES.some((name) => name.startsWith("F402_"))).toBe(
      false,
    );
  });
});

describe("resolveSecretEnv", () => {
  test("environment wins over the keychain", async () => {
    const result = await resolveSecretEnv(["GSLIVE_SESSION_ID"], {
      env: { GSLIVE_SESSION_ID: " from-env " },
      read: fakeKeychain({
        GSLIVE_SESSION_ID: {
          value: "from-keychain",
          service: CANONICAL_SECRETS_SERVICE,
        },
      }),
    });
    expect(result.env["GSLIVE_SESSION_ID"]).toBe("from-env");
    expect(result.report[0]?.source).toEqual({ kind: "env" });
  });

  test("the pre-rename GSID is read from env and from the keychain, and injected under the new name", async () => {
    const fromEnv = await resolveSecretEnv(["GSLIVE_SESSION_ID"], {
      env: { GSID: "old-env" },
      read: fakeKeychain({}),
    });
    expect(fromEnv.env["GSLIVE_SESSION_ID"]).toBe("old-env");
    expect(fromEnv.env["GSID"]).toBeUndefined();
    expect(describeSource(fromEnv.report[0]!.source)).toBe("env (as GSID)");

    const fromKeychain = await resolveSecretEnv(["GSLIVE_SESSION_ID"], {
      env: {},
      read: fakeKeychain({
        GSID: { value: "old-keychain", service: CANONICAL_SECRETS_SERVICE },
      }),
    });
    expect(fromKeychain.env["GSLIVE_SESSION_ID"]).toBe("old-keychain");
    expect(describeSource(fromKeychain.report[0]!.source)).toBe(
      "keychain (as GSID)",
    );
  });

  test("the new name wins over the pre-rename one", async () => {
    const result = await resolveSecretEnv(["GSLIVE_SESSION_ID"], {
      env: { GSLIVE_SESSION_ID: "new", GSID: "old" },
      read: fakeKeychain({}),
    });
    expect(result.env["GSLIVE_SESSION_ID"]).toBe("new");
    expect(result.report[0]?.source).toEqual({ kind: "env" });
  });

  test("a blank environment value falls through to the keychain", async () => {
    const result = await resolveSecretEnv(["GSLIVE_SESSION_ID"], {
      env: { GSLIVE_SESSION_ID: "   " },
      read: fakeKeychain({
        GSLIVE_SESSION_ID: {
          value: "from-keychain",
          service: CANONICAL_SECRETS_SERVICE,
        },
      }),
    });
    expect(result.env["GSLIVE_SESSION_ID"]).toBe("from-keychain");
    expect(describeSource(result.report[0]!.source)).toBe("keychain");
  });

  test("a legacy-service hit is reported as legacy", async () => {
    const result = await resolveSecretEnv(["R2_BUCKET_NAME"], {
      env: {},
      read: fakeKeychain({
        R2_BUCKET_NAME: { value: "b", service: LEGACY_SECRETS_SERVICE },
      }),
    });
    expect(describeSource(result.report[0]!.source)).toBe(
      "keychain (legacy service)",
    );
  });

  test("a name found nowhere is reported missing and is absent from env", async () => {
    const result = await resolveSecretEnv(["BLOB_API_TOKEN"], {
      env: {},
      read: fakeKeychain({}),
    });
    expect(result.env).toEqual({});
    expect(result.report[0]?.source).toEqual({ kind: "missing" });
  });

  test("the report never contains a value", async () => {
    const result = await resolveSecretEnv(
      ["GSLIVE_SESSION_ID", "BLOB_API_TOKEN"],
      {
        env: { GSLIVE_SESSION_ID: "sekrit-env-value" },
        read: fakeKeychain({
          BLOB_API_TOKEN: {
            value: "sekrit-keychain-value",
            service: CANONICAL_SECRETS_SERVICE,
          },
        }),
      },
    );
    const printed = JSON.stringify(result.report);
    expect(printed).not.toContain("sekrit-env-value");
    expect(printed).not.toContain("sekrit-keychain-value");
  });
});

describe("childEnv", () => {
  test("layers resolved secrets over the parent and drops undefined entries", () => {
    const merged = childEnv(
      { PATH: "/bin", GSLIVE_SESSION_ID: "old", GONE: undefined },
      { env: { GSLIVE_SESSION_ID: "new" }, report: [] },
    );
    expect(merged).toEqual({ PATH: "/bin", GSLIVE_SESSION_ID: "new" });
  });
});

/** Spawns the real CLI with a scrubbed environment so the developer's keychain is not consulted for set names. */
async function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SECRETS_ENV, ...args], {
    env: { PATH: Bun.env["PATH"] ?? "", HOME: Bun.env["HOME"] ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("secrets_env.ts exec", () => {
  test("injects only the requested names into the child, and says where they came from", async () => {
    const result = await run(
      [
        "exec",
        "--with",
        "GSLIVE_SESSION_ID",
        "--",
        "sh",
        "-c",
        'printf "%s|%s" "$GSLIVE_SESSION_ID" "${TELEGRAM_BOT_TOKEN:-unset}"',
      ],
      { GSLIVE_SESSION_ID: "g-123", TELEGRAM_BOT_TOKEN: "" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("g-123|unset");
    expect(result.stderr).toContain("injecting GSLIVE_SESSION_ID←env");
    expect(result.stderr).not.toContain("g-123");
  });

  test("the child's exit code is passed through", async () => {
    const result = await run(
      ["exec", "--with", "GSLIVE_SESSION_ID", "--", "sh", "-c", "exit 7"],
      { GSLIVE_SESSION_ID: "x" },
    );
    expect(result.code).toBe(7);
  });

  test("--with is required, so a bare exec never injects by accident", async () => {
    const result = await run(["exec", "--", "true"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--with is required");
  });

  test("a typo in the group is refused before anything runs", async () => {
    const result = await run(["exec", "--with", "pagess", "--", "true"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown secret or group "pagess"');
  });
});

describe("secrets_env.ts status and set", () => {
  test("status names each source and never prints a value", async () => {
    const result = await run(
      ["status", "--with", "GSLIVE_SESSION_ID", "--json"],
      {
        GSLIVE_SESSION_ID: "value-that-must-not-print",
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "GSLIVE_SESSION_ID", source: { kind: "env" } },
    ]);
    expect(result.stdout).not.toContain("value-that-must-not-print");
  });

  test("set refuses a name outside the registry", async () => {
    const result = await run(["set", "F402_PASSWORD"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown secret "F402_PASSWORD"');
  });
});
