/**
 * Pins the keychain boundary. Two independent guarantees:
 *
 * 1. **Behaviour** — a test process is denied by the runtime decision, reads return `null`,
 *    writes throw `KeychainAccessDeniedError`, and the blocked `security` CLI is never spawned.
 * 2. **Reachability** — no tracked/untracked non-test code file (`.ts/.tsx/.mts/.cts/.js/.jsx/.cjs`)
 *    calls `Bun.secrets` or spawns `security` outside the boundary. A new direct call fails this
 *    test instead of silently bypassing the guard. Stale `.worktrees/`/`.agents/` copies are
 *    excluded from the pass/fail scan and reported separately.
 *
 * The macOS keychain can raise an interactive consent dialog. A test run must never trigger one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import {
  KEYCHAIN_ACCESS_ENV,
  KEYCHAIN_TRACE_ENV,
  KeychainAccessDeniedError,
  describeKeychainAccess,
  guardedSecrets,
  isTestEntrypoint,
  keychainAccessDecision,
  platformKeychainAllowed,
} from "../lib/keychain_access.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  SECRET_ENTRIES,
  deleteSecret,
  readSecretOrNull,
  setSecretsProviderForTests,
  writeSecret,
} from "../lib/secrets.ts";

// The gate asserts denial via the decision, the null read and the thrown error — it does not
// need trace output. Silencing the trace here keeps the suite-wide invariant clean: a
// `SPORTSDESK_KEYCHAIN_TRACE=1 bun test` run must print ZERO `[keychain] denied` lines.
const originalTrace = Bun.env[KEYCHAIN_TRACE_ENV];

beforeEach(() => {
  delete Bun.env[KEYCHAIN_TRACE_ENV];
});

afterEach(() => {
  setSecretsProviderForTests(null);
  if (originalTrace === undefined) delete Bun.env[KEYCHAIN_TRACE_ENV];
  else Bun.env[KEYCHAIN_TRACE_ENV] = originalTrace;
});

describe("runtime decision", () => {
  test("an ordinary script/daemon is allowed", () => {
    expect(
      keychainAccessDecision(
        {},
        "/Users/operator/repo/scripts/session_login.ts",
      ),
    ).toEqual({ allowed: true, reason: "default" });
  });

  test("NODE_ENV=test is denied even for a non-test entrypoint", () => {
    // `bun test` sets NODE_ENV=test; every spawned child inherits it.
    expect(
      keychainAccessDecision(
        { NODE_ENV: "test" },
        "/Users/operator/repo/scripts/session_login.ts",
      ),
    ).toEqual({ allowed: false, reason: "NODE_ENV=test" });
  });

  test("a test entrypoint is denied even when NODE_ENV was overwritten", () => {
    expect(
      keychainAccessDecision(
        { NODE_ENV: "production" },
        "/repo/tests/a.test.ts",
      ),
    ).toEqual({ allowed: false, reason: "test entrypoint a.test.ts" });
    expect(isTestEntrypoint("/repo/lib/thing.spec.ts")).toBe(true);
    expect(isTestEntrypoint("/repo/tests/support/capabilities.ts")).toBe(true);
    expect(isTestEntrypoint("/repo/scripts/probe.ts")).toBe(false);
    expect(isTestEntrypoint("")).toBe(false);
  });

  test("explicit deny wins over everything; explicit allow is a two-key opt-in", () => {
    expect(
      keychainAccessDecision(
        { [KEYCHAIN_ACCESS_ENV]: "deny" },
        "/repo/scripts/probe.ts",
      ),
    ).toEqual({ allowed: false, reason: `${KEYCHAIN_ACCESS_ENV}=deny` });

    // A test process can only reach the keychain when the operator explicitly opts in.
    expect(
      keychainAccessDecision(
        { NODE_ENV: "test", [KEYCHAIN_ACCESS_ENV]: "allow" },
        "/repo/tests/a.test.ts",
      ),
    ).toEqual({ allowed: true, reason: "explicit-allow" });
  });

  test("denies only provably-test processes — production/staging/unset stay allowed", () => {
    // The guard's ALLOW path is production behaviour; an accidental deny would surface as a
    // "credentials missing" bug. Fail open for everything that is not provably a test.
    const main = "/opt/sportsdesk/services/serve.ts";
    for (const nodeEnv of ["production", "staging", "development", undefined]) {
      expect(keychainAccessDecision({ NODE_ENV: nodeEnv }, main)).toEqual({
        allowed: true,
        reason: "default",
      });
    }
    // A compiled binary has no script path; unknown context must fail open.
    expect(keychainAccessDecision({}, "").allowed).toBe(true);
    // An unrecognized NODE_ENV value must not deny.
    expect(keychainAccessDecision({ NODE_ENV: "ci" }, main).allowed).toBe(true);
    // Only the provable test signals deny.
    expect(keychainAccessDecision({ NODE_ENV: "test" }, main).allowed).toBe(
      false,
    );
    expect(keychainAccessDecision({}, "/repo/tests/x.test.ts").allowed).toBe(
      false,
    );
  });

  test("this process reports denied", () => {
    // `bun test` => NODE_ENV=test and Bun.main is this .test.ts file.
    expect(describeKeychainAccess()).toContain("denied");
    expect(platformKeychainAllowed()).toBe(false);
  });
});

describe("guarded surface in a denied process", () => {
  test("a read returns null instead of touching the store", async () => {
    expect(
      await guardedSecrets.get({
        service: CANONICAL_SECRETS_SERVICE,
        name: "GSID",
      }),
    ).toBeNull();
  });

  test("a write and a delete throw instead of silently no-opping", async () => {
    await expect(
      guardedSecrets.set({
        service: CANONICAL_SECRETS_SERVICE,
        name: "GSID",
        value: "not-a-real-secret",
      }),
    ).rejects.toBeInstanceOf(KeychainAccessDeniedError);

    await expect(
      guardedSecrets.delete({
        service: CANONICAL_SECRETS_SERVICE,
        name: "GSID",
      }),
    ).rejects.toBeInstanceOf(KeychainAccessDeniedError);
  });

  test("the lib/secrets defaults are the guarded surface, not Bun.secrets", async () => {
    // Restore the default provider, then prove a default read cannot reach the keychain.
    setSecretsProviderForTests(null);
    expect(
      await readSecretOrNull(CANONICAL_SECRETS_SERVICE, "GSID"),
    ).toBeNull();

    // The default writer throws before Bun.secrets is called.
    await expect(
      writeSecret(SECRET_ENTRIES.gsid, "not-a-real-secret"),
    ).rejects.toBeInstanceOf(KeychainAccessDeniedError);

    // deleteSecret treats a denied delete as "not removed", never as an error.
    expect(await deleteSecret(SECRET_ENTRIES.gsid)).toBe(0);
  });
});

interface KeychainSite {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

/** Files allowed to name the OS store because they ARE the boundary or its guard. */
const BUN_SECRETS_ALLOWLIST = new Set([
  "lib/keychain_access.ts",
  "bin/bun_surface.ts", // metadata: `read: () => Bun.secrets.get`, never invoked as a call
  "scripts/bun_shape_contracts.ts", // doc string describing the pinned surface
]);

/** Files allowed to spawn `security` because they gate it with `platformKeychainAllowed()`. */
const SECURITY_SPAWN_ALLOWLIST = new Set([
  "lib/f402_credentials_policy.ts",
  "scripts/secrets_r2.ts",
  // The boundary's own sentinel target is named `find-generic-password` for the trace.
  "lib/keychain_access.ts",
]);

function isTestFile(file: string): boolean {
  return (
    /[./](?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /^(?:tests?|__tests__)\//.test(file)
  );
}

/** Directories that hold stale copies, not the live tree. Reported, never scanned for pass/fail. */
const EXCLUDED_TREES = [".worktrees", ".agents"] as const;

function trackedCodeFiles(): string[] {
  const result = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.js",
      "*.jsx",
      "*.mjs",
      "*.cjs",
      ":(exclude)node_modules/**",
      ":(exclude).worktrees/**",
      ":(exclude).agents/**",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "");
}

function scanSites(
  files: readonly string[],
  pattern: RegExp,
  allowlist: ReadonlySet<string>,
): KeychainSite[] {
  const sites: KeychainSite[] = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    if (allowlist.has(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (pattern.test(line)) {
        sites.push({ file, line: index + 1, match: line.trim() });
      }
    }
  }
  return sites;
}

function formatSites(sites: readonly KeychainSite[]): string[] {
  return sites.map((s) => `${relative(".", s.file)}:${s.line}`);
}

/** Stale copies under the excluded trees that still hold an unguarded call. Informational. */
function staleCopyHits(): { readonly files: number; readonly trees: string } {
  const present = EXCLUDED_TREES.filter((tree) => existsSync(tree));
  if (present.length === 0) return { files: 0, trees: "(none present)" };
  const result = Bun.spawnSync(
    [
      "git",
      "grep",
      "--no-index",
      "-l",
      "-E",
      "Bun\\.secrets|find-(generic|internet)-password",
      "--",
      ...present,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // git grep exits 1 when there are no matches (and 128 when a path is absent).
  const text = new TextDecoder().decode(result.stdout).trim();
  return {
    files: text === "" ? 0 : text.split("\n").length,
    trees: present.join(", "),
  };
}

describe("reachability (static)", () => {
  test("only lib/keychain_access.ts invokes Bun.secrets", () => {
    const files = trackedCodeFiles();
    // Dot call, bracket access, destructured method binding, and a bare method reference all
    // reach the same OS store; matching `Bun.secrets.get` alone would miss three of the four.
    const patterns = [
      /\bBun\.secrets\s*\.\s*(?:get|set|delete)\s*\(/,
      /\bBun\.secrets\s*\[\s*["'](?:get|set|delete)["']\s*\]/,
      /\{[^}]*\b(?:get|set|delete)\b[^}]*\}\s*=\s*Bun\.secrets/,
      /=\s*Bun\.secrets\.(?:get|set|delete)\b/,
    ];
    const sites = patterns.flatMap((pattern) =>
      scanSites(files, pattern, BUN_SECRETS_ALLOWLIST),
    );
    expect(formatSites(sites)).toEqual([]);
  });

  test("no namespace alias reaches .secrets.get/set/delete", () => {
    // `import * as b from "bun"; b.secrets.get(...)` bypasses both the Bun.* and import scans.
    const sites = scanSites(
      trackedCodeFiles(),
      /\b(?!Bun\b)[A-Za-z_$][\w$]*\.secrets\.(?:get|set|delete)\s*\(/,
      BUN_SECRETS_ALLOWLIST,
    );
    expect(formatSites(sites)).toEqual([]);
  });

  test("nothing binds the raw `secrets` export from bun", () => {
    const sites = scanSites(
      trackedCodeFiles(),
      /\b(?:import\s*\{[^}]*\bsecrets\b[^}]*\}\s*from\s*["']bun["']|\{[^}]*\bsecrets\b[^}]*\}\s*=\s*await\s+import\(\s*["']bun["']\s*\)|\{[^}]*\bsecrets\b[^}]*\}\s*=\s*require\(\s*["']bun["']\s*\))/,
      BUN_SECRETS_ALLOWLIST,
    );
    expect(formatSites(sites)).toEqual([]);
  });

  test("the macOS security CLI is spawned only behind platformKeychainAllowed()", () => {
    const sites = scanSites(
      trackedCodeFiles(),
      /find-(?:generic|internet)-password/,
      SECURITY_SPAWN_ALLOWLIST,
    );
    expect(formatSites(sites)).toEqual([]);
  });

  test("each allowlisted security spawn is guarded in the same function", () => {
    const spawnPattern = /find-(?:generic|internet)-password/;
    for (const file of SECURITY_SPAWN_ALLOWLIST) {
      const lines = readFileSync(file, "utf8").split("\n");
      const spawnLines = lines
        .map((line, index) => ({ line: line.trim(), index }))
        .filter(
          ({ line }) =>
            spawnPattern.test(line) &&
            !line.startsWith("*") &&
            !line.startsWith("//"),
        );
      expect(spawnLines.length).toBeGreaterThan(0);
      for (const { index } of spawnLines) {
        // The guard may be defined before the spawn or in its only caller; a tight symmetric
        // window is the practical static check.
        const window = lines
          .slice(Math.max(0, index - 40), Math.min(lines.length, index + 41))
          .join("\n");
        expect(window).toContain("platformKeychainAllowed()");
      }
    }
  });

  test("Bun.main really is the test entrypoint under `bun test`", () => {
    // `NODE_ENV=test` alone could pass the denial test; this pins the second, load-bearing half
    // (a `.env` that sets NODE_ENV=production must still be denied by the entrypoint check).
    expect(isTestEntrypoint()).toBe(true);
  });
});

describe("excluded stale copies (informational, never fails the gate)", () => {
  test("live tree is clear; stale copies are counted and reported", () => {
    const stale = staleCopyHits();
    console.log(
      `[keychain-boundary] live tree: 0 unguarded sites; excluded stale copies in ${stale.trees}: ${stale.files} file(s) with keychain references (not scanned by the gate)`,
    );
    // Deliberately no assertion on stale copies: they are not the live tree.
    expect(typeof stale.files).toBe("number");
  });
});
