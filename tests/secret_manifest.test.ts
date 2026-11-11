import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  audit,
  classifyName,
  explainUnregistered,
  scanEnvReads,
} from "../lib/secret_audit.ts";
import { manifestStatus, SECRET_ENV_NAMES } from "../lib/secret_env.ts";
import {
  getSecretsForGroup,
  manifestNames,
  NON_SECRET_ALLOWLIST,
  SECRET_GROUPS,
  SECRET_MANIFEST,
} from "../lib/secret_manifest.ts";

const ROOT = path.resolve(import.meta.dir, "..");

describe("secret manifest invariants", () => {
  test("every variable and every keychain entry is listed once", () => {
    const envNames = SECRET_MANIFEST.map((secret) => secret.envName);
    expect(new Set(envNames).size).toBe(envNames.length);
    const keychain = SECRET_MANIFEST.flatMap((secret) =>
      secret.keychainName === null ? [] : [secret.keychainName],
    );
    expect(new Set(keychain).size).toBe(keychain.length);
  });

  test("everything injectable has a keychain entry, and every entry is in a group", () => {
    for (const secret of SECRET_MANIFEST) {
      expect(secret.groups.length).toBeGreaterThan(0);
      if (secret.inject) expect(secret.keychainName).not.toBeNull();
    }
  });

  test("F402 stays out of `dx exec --with`: its scripts read the keychain themselves", () => {
    for (const secret of getSecretsForGroup("f402")) {
      expect(secret.inject).toBe(false);
    }
    expect(SECRET_ENV_NAMES.some((name) => name.startsWith("F402_"))).toBe(
      false,
    );
  });

  test("an alias never shadows another entry", () => {
    const names = SECRET_MANIFEST.map((secret) => secret.envName as string);
    for (const secret of SECRET_MANIFEST) {
      for (const alias of secret.aliases ?? []) {
        expect(names).not.toContain(alias);
      }
    }
  });

  test("the allowlist holds only names the audit would otherwise flag", () => {
    for (const name of Object.keys(NON_SECRET_ALLOWLIST)) {
      expect(classifyName(name)).toBe("soft");
      expect(manifestNames().has(name)).toBe(false);
    }
  });

  test("groups are exactly those the manifest uses", () => {
    expect(SECRET_GROUPS).toEqual([
      ...new Set(SECRET_MANIFEST.flatMap((secret) => secret.groups)),
    ]);
  });

  test("telegram holds every variable the bot reads so seeding is one `--with` call", () => {
    const telegram = getSecretsForGroup("telegram").map(
      (secret) => secret.envName,
    );
    expect(new Set(telegram)).toEqual(
      new Set([
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_WEBHOOK_SECRET",
        "TELEGRAM_CHAT_ID",
        "TELEGRAM_WEBHOOK_URL",
        "TELEGRAM_MINIAPP_URL",
      ]),
    );
    for (const secret of getSecretsForGroup("telegram")) {
      expect(secret.inject).toBe(true);
      expect(secret.keychainName).toBe(String(secret.envName));
    }
  });

  test("TELEGRAM_CHAT_ID moved out of NON_SECRET_ALLOWLIST once it joined the manifest", () => {
    expect(Object.keys(NON_SECRET_ALLOWLIST)).not.toContain("TELEGRAM_CHAT_ID");
  });
});

describe("classifyName", () => {
  test("hard suffixes are always credentials", () => {
    for (const name of [
      "X_TOKEN",
      "X_SECRET",
      "X_PASSWORD",
      "X_COOKIE",
      "X_SESSION",
      "X_API_KEY",
    ]) {
      expect(classifyName(name)).toBe("hard");
    }
  });

  test("soft suffixes need a manifest entry or a reason", () => {
    for (const name of ["R2_ACCESS_KEY_ID", "SIGNING_KEY", "F402_AGENT_ID"]) {
      expect(classifyName(name)).toBe("soft");
    }
  });

  test("paths, ports and flags are not credentials", () => {
    for (const name of [
      "F402_TOKEN_FILE",
      "GSLIVE_SESSION_FILE",
      "PORT",
      "NODE_ENV",
    ]) {
      expect(classifyName(name)).toBe("none");
    }
  });
});

describe("scanEnvReads", () => {
  test("finds dot and bracket reads with their lines and nothing else", () => {
    const text = [
      "const a = process.env.ONE_TOKEN;",
      'const b = Bun.env["TWO_SECRET"];',
      "const c = import.meta.env.THREE_ID;",
      "const d = other.env.NOT_THIS_TOKEN; // not an env object",
      'const e = "process.env.IN_A_STRING_TOKEN is still a read the scan counts";',
    ].join("\n");
    const reads = scanEnvReads(text).map((read) => `${read.name}@${read.line}`);
    expect(reads).toContain("ONE_TOKEN@1");
    expect(reads).toContain("TWO_SECRET@2");
    expect(reads).toContain("THREE_ID@3");
    expect(reads).not.toContain("NOT_THIS_TOKEN@4");
  });

  test('detects MODULE "bun", namespace, destructured, and globalThis.Bun env reads', () => {
    const imported = [
      'import { env, sql } from "bun";',
      "const a = env.IMPORTED_PASSWORD;",
      'const b = env["IMPORTED_TOKEN"];',
      "const c = globalThis.Bun.env.GLOBAL_SECRET;",
    ].join("\n");
    expect(scanEnvReads(imported).map((r) => `${r.name}@${r.line}`)).toEqual([
      "IMPORTED_PASSWORD@2",
      "IMPORTED_TOKEN@3",
      "GLOBAL_SECRET@4",
    ]);

    const aliasedAndNs = [
      'import { env as bunEnv } from "bun";',
      'import * as bunNs from "bun";',
      "const { env: localEnv } = Bun;",
      "const x = bunEnv.ALIASED_SECRET;",
      'const y = bunNs.env["NS_COOKIE"];',
      "const z = localEnv.DESTRUCTURED_KEY;",
    ].join("\n");
    expect(
      scanEnvReads(aliasedAndNs).map((r) => `${r.name}@${r.line}`),
    ).toEqual(["ALIASED_SECRET@4", "NS_COOKIE@5", "DESTRUCTURED_KEY@6"]);

    // Unbound local `env` without importing from "bun" or destructuring Bun is ignored
    const unbound =
      "function f(env: Record<string, string>) { return env.UNBOUND_TOKEN; }";
    expect(scanEnvReads(unbound)).toEqual([]);
  });
});

describe("audit", () => {
  const base = {
    registered: new Set(["KNOWN_TOKEN", "OLD_NAME_TOKEN"]),
    entries: [{ names: ["KNOWN_TOKEN", "OLD_NAME_TOKEN"] }],
    allowlist: { SAFE_ID: "numeric destination" } as Record<string, string>,
    manifestPaths: ["lib/secret_manifest.ts"],
  };
  const file = (filePath: string, text: string) => ({ path: filePath, text });

  test("an unregistered hard name fails and cannot be allowlisted away", () => {
    const sources = [file("a.ts", "Bun.env.NEW_TOKEN")];
    const result = audit({
      ...base,
      sources,
      everything: sources,
      allowlist: { ...base.allowlist, NEW_TOKEN: "no" },
    });
    expect(result.unregistered.map((item) => item.name)).toEqual(["NEW_TOKEN"]);
    expect(result.badAllowlist).toEqual(["NEW_TOKEN"]);
  });

  test("a registered name, an alias and an allowlisted soft name pass", () => {
    const sources = [
      file(
        "a.ts",
        "Bun.env.KNOWN_TOKEN; Bun.env.OLD_NAME_TOKEN; Bun.env.SAFE_ID",
      ),
    ];
    const result = audit({ ...base, sources, everything: sources });
    expect(result.unregistered).toEqual([]);
  });

  test("an unregistered soft name fails with both fixes spelled out", () => {
    const sources = [file("lib/x.ts", "\nBun.env.SOME_KEY")];
    const result = audit({ ...base, sources, everything: sources });
    const item = result.unregistered[0];
    expect(item?.where).toEqual(["lib/x.ts:2"]);
    const text = explainUnregistered(item!);
    expect(text).toContain("SECRET_MANIFEST");
    expect(text).toContain("NON_SECRET_ALLOWLIST");
    expect(text).toContain("secrets:env set SOME_KEY");
  });

  test("a manifest entry nothing mentions is reported dead, mentions inside the manifest do not count", () => {
    const everything = [file("lib/secret_manifest.ts", "KNOWN_TOKEN")];
    const result = audit({ ...base, sources: [], everything });
    expect(result.dead).toEqual(["KNOWN_TOKEN"]);
    const used = [...everything, file("scripts/x.ts", "read('KNOWN_TOKEN')")];
    expect(audit({ ...base, sources: [], everything: used }).dead).toEqual([]);
  });
});

describe("manifestStatus", () => {
  test("lists every entry; env-only entries are unset, not missing", async () => {
    const rows = await manifestStatus({
      env: { CLOUDFLARE_API_TOKEN: "x", GSID: "old" },
      read: async (name) =>
        name === "R2_BUCKET_NAME"
          ? { value: "bucket", service: "com.bookdeskops.sportsdesk" }
          : null,
    });
    expect(rows.length).toBe(SECRET_MANIFEST.length);
    const kind = (name: string) =>
      rows.find((row) => row.name === name)?.source;
    expect(kind("CLOUDFLARE_API_TOKEN")).toEqual({ kind: "env" });
    expect(kind("GSLIVE_SESSION_ID")).toEqual({ kind: "env", via: "GSID" });
    expect(kind("R2_BUCKET_NAME")).toMatchObject({ kind: "keychain" });
    expect(kind("R2_ACCESS_KEY_ID")).toEqual({ kind: "missing" });
    expect(kind("F402_BEARER_TOKEN")).toEqual({ kind: "unset" });
  });

  test("a keychain entry is read by its own name: F402 is kebab-case", async () => {
    const asked: string[] = [];
    await manifestStatus({
      env: {},
      read: async (name) => {
        asked.push(name);
        return null;
      },
    });
    expect(asked).toContain("f402-agent-id");
    expect(asked).toContain("f402-password");
    expect(asked).not.toContain("F402_PASSWORD");
  });
});

describe("audit:secrets on this repository", () => {
  async function run(args: string[]) {
    const child = Bun.spawn(["bun", "scripts/audit_secrets.ts", ...args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  test("every secret-like variable the code reads is registered or allowlisted", async () => {
    const result = await run([]);
    expect(result.stderr).not.toContain(
      "Secret-like variable read but not registered",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 unregistered");
  });

  test("--explain names the files that read a variable", async () => {
    const result = await run(["--explain", "SPORTSDESK_ADMIN_TOKEN"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\.ts:\d+/);
    expect(result.stdout).toContain("in the manifest");
  });
});
