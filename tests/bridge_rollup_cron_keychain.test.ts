/**
 * The cron daemon runs as a fresh process with no shell environment, so an env-only credential gate
 * would put 3a/3b/3c to sleep on the operator's Mac even though GSID and the F402 agent/password
 * live in the OS keychain. These tests pin the keychain-aware gate, per job, and the one thing it
 * must NOT do: hand the F402 password to a child process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIDGE_ROLLUP_JOBS,
  keychainCredentialProbe,
  runBridgeRollupCycle,
  type BridgeRollupJobId,
  type BridgeSpawnResult,
} from "../lib/bridge_rollup_cron.ts";
import type { F402Session } from "../lib/f402_session.ts";
import { F402_KEYCHAIN_NAMES, GSID_KEYCHAIN_NAME } from "../lib/secrets.ts";
import { SECRET_NAMES } from "../scripts/capture/f402_login.ts";
import { GSID_SECRET } from "../scripts/fetch-bet-tally.ts";

const job = (id: BridgeRollupJobId) => {
  const found = BRIDGE_ROLLUP_JOBS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing job ${id}`);
  return found;
};

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {
  HOME: "/nonexistent",
};

function keychain(
  values: Readonly<Record<string, string>>,
  overrides: {
    sessionPresent?: boolean;
    tokenFilePresent?: boolean;
    readSession?: () => F402Session | null;
    readFile?: (path: string) => string;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  const reads: string[] = [];
  return {
    reads,
    probe: keychainCredentialProbe({
      env: overrides.env ?? EMPTY_ENV,
      readSecret: async (name) => {
        reads.push(name);
        return values[name] ?? null;
      },
      sessionPresent: () => overrides.sessionPresent ?? false,
      tokenFilePresent: () => overrides.tokenFilePresent ?? false,
      readSession: overrides.readSession ?? (() => null),
      readFile:
        overrides.readFile ??
        (() => {
          throw new Error("ENOENT");
        }),
    }),
  };
}

describe("keychain names match the canonical constants", () => {
  test("the cron probe cannot drift from the login/GSID modules", () => {
    expect(F402_KEYCHAIN_NAMES.agentId).toBe(SECRET_NAMES.agentId);
    expect(F402_KEYCHAIN_NAMES.password).toBe(SECRET_NAMES.password);
    expect(GSID_KEYCHAIN_NAME).toBe(GSID_SECRET.name);
  });
});

describe("bridge3c: GSID is keychain-first", () => {
  test("a stored GSID satisfies 3c with no environment", async () => {
    const { probe } = keychain({ [GSID_KEYCHAIN_NAME]: "stored-session" });
    expect(await probe.check(job("bridge3c"))).toEqual({
      ok: true,
      source: "keychain:GSLIVE_SESSION_ID",
    });
  });

  test("a keychain entry stored under the pre-rename name still satisfies 3c", async () => {
    const { probe } = keychain({ GSID: "stored-session" });
    expect(await probe.check(job("bridge3c"))).toEqual({
      ok: true,
      source: "keychain:GSID",
    });
  });

  test("the new env name satisfies 3c", async () => {
    const { probe, reads } = keychain(
      {},
      { env: { GSLIVE_SESSION_ID: "env-session" } },
    );
    expect(await probe.check(job("bridge3c"))).toEqual({
      ok: true,
      source: "env:GSLIVE_SESSION_ID",
    });
    expect(reads).toEqual([]);
  });

  test("an env GSID wins without touching the keychain", async () => {
    const { probe, reads } = keychain(
      { [GSID_KEYCHAIN_NAME]: "stored-session" },
      { env: { GSID: "env-session" } },
    );
    expect(await probe.check(job("bridge3c"))).toEqual({
      ok: true,
      source: "env:GSID",
    });
    expect(reads).toEqual([]);
  });

  test("neither source is a named failure", async () => {
    const { probe } = keychain({});
    const decision = await probe.check(job("bridge3c"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain("GSID");
  });
});

describe("bridge3b: a bearer source only (Q2)", () => {
  test("the stored agent id/password do NOT satisfy the bearer fetch", async () => {
    const { probe } = keychain(
      {
        [F402_KEYCHAIN_NAMES.agentId]: "agent",
        [F402_KEYCHAIN_NAMES.password]: "password",
      },
      { readSession: () => null },
    );
    const decision = await probe.check(job("bridge3b"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toContain("bearer");
    }
  });

  test("an env bearer token satisfies 3b", async () => {
    const { probe } = keychain(
      {},
      { env: { F402_BEARER_TOKEN: "x".repeat(32) } },
    );
    expect(await probe.check(job("bridge3b"))).toEqual({
      ok: true,
      source: "env:F402_BEARER_TOKEN",
    });
  });

  test("a token file satisfies 3b", async () => {
    const token = "x".repeat(32);
    const { probe } = keychain(
      {},
      {
        env: { HOME: "/tmp", F402_TOKEN_FILE: "/tmp/sportsdesk/f402-token" },
        readFile: () => token,
      },
    );
    expect(await probe.check(job("bridge3b"))).toEqual({
      ok: true,
      source: "token-file",
    });
  });

  test("session authorizationHeader satisfies 3b", async () => {
    const token = "x".repeat(32);
    const { probe } = keychain(
      {},
      {
        readSession: () =>
          ({
            cookieHeader: "x=1",
            cookieNames: ["x"],
            authorizationHeader: token,
            obtainedAtIso: "2026-01-01T00:00:00.000Z",
            expiresAtIso: "2027-01-01T00:00:00.000Z",
          }) satisfies F402Session,
      },
    );
    expect(await probe.check(job("bridge3b"))).toEqual({
      ok: true,
      source: "session:bearer",
    });
  });
});

describe("bridge3a: agent + session, agent injected only", () => {
  test("a keychain agent id is injected as F402_AGENT_ID and nothing else", async () => {
    const { probe } = keychain(
      { [F402_KEYCHAIN_NAMES.agentId]: "keychain-agent" },
      { sessionPresent: true },
    );
    const decision = await probe.check(job("bridge3a"));
    expect(decision).toEqual({
      ok: true,
      source: "keychain:agent",
      extraEnv: { F402_AGENT_ID: "keychain-agent" },
    });
    if (decision.ok) {
      expect(Object.keys(decision.extraEnv ?? {})).toEqual(["F402_AGENT_ID"]);
      expect(JSON.stringify(decision.extraEnv)).not.toContain("password");
    }
  });

  test("no session file is a named failure, not a spawn", async () => {
    const { probe } = keychain(
      { [F402_KEYCHAIN_NAMES.agentId]: "keychain-agent" },
      { sessionPresent: false },
    );
    const decision = await probe.check(job("bridge3a"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain("session file");
  });

  test("no agent id at all is a named failure", async () => {
    const { probe } = keychain({}, { sessionPresent: true });
    const decision = await probe.check(job("bridge3a"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain("F402_AGENT_ID");
  });
});

describe("weblog needs no credentials", () => {
  test("the corpus gate is always open", async () => {
    const { probe } = keychain({});
    expect(await probe.check(job("weblog"))).toEqual({
      ok: true,
      source: "corpus",
    });
  });
});

describe("the default gate stays env-only (tests never read the real keychain)", () => {
  test("a credential-less env skips every job without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cron-env-"));
    const spawned: BridgeRollupJobId[] = [];
    const { probe } = keychain({}, { readSession: () => null });
    const result = await runBridgeRollupCycle({
      root,
      // weblog needs no credentials (its corpus is local), so keep the gate focused here.
      jobs: ["bridge3a", "bridge3b", "bridge3c"],
      env: { HOME: "/nonexistent" },
      credentials: probe,
      statePath: join(root, "state.json"),
      historyPath: join(root, "history.jsonl"),
      spawnJob: async (context) => {
        spawned.push(context.id);
        const ok: BridgeSpawnResult = {
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          timedOut: false,
        };
        return ok;
      },
      readArtifact: async () => null,
    });
    expect(spawned).toEqual([]);
    expect(result.jobs.every((entry) => !entry.ok)).toBe(true);
    expect(result.jobs[0]?.error).toContain("missing credentials");
  });
});

describe("the cycle hands the child the probe extras", () => {
  test("3a receives F402_AGENT_ID from the keychain, never the password", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-cron-keychain-"));
    const seenEnv: Readonly<Record<string, string | undefined>>[] = [];
    const { probe } = keychain(
      {
        [F402_KEYCHAIN_NAMES.agentId]: "keychain-agent",
        [F402_KEYCHAIN_NAMES.password]: "keychain-password",
      },
      { sessionPresent: true },
    );
    const result = await runBridgeRollupCycle({
      root,
      jobs: ["bridge3a"],
      env: { HOME: "/nonexistent", F402_PASSWORD: "" },
      credentials: probe,
      statePath: join(root, "state.json"),
      historyPath: join(root, "history.jsonl"),
      spawnJob: async (context) => {
        seenEnv.push(context.childEnv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true }),
          stderr: "",
          timedOut: false,
        } satisfies BridgeSpawnResult;
      },
      readArtifact: async () => null,
    });
    expect(seenEnv).toHaveLength(1);
    expect(seenEnv[0]?.F402_AGENT_ID).toBe("keychain-agent");
    expect(seenEnv[0]?.F402_PASSWORD ?? "").toBe("");
    expect(result.jobs[0]?.ok).toBe(true);
  });
});
