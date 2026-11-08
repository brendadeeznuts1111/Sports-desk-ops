import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { FraudConfigError, loadFraudConfig } from "../lib/fraud_logs.ts";
import {
  CLI_PATH,
  CORPUS_FALLBACK_REL,
  CORPUS_PRIMARY_REL,
  FIXED_NOW_ISO,
  GROUP_VALID_CORPUS_FIXTURE,
  buildFixtureRoot,
  fixtureText,
  makeRoot,
  readFixtureJson,
  sha256Of,
  writeAt,
} from "./fixtures/fraud/support.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function track(root: string): string {
  roots.push(root);
  return root;
}

interface CliResult {
  readonly code: number;
  readonly body: Record<string, unknown>;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(root: string, args: readonly string[]): CliResult {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      FIXED_NOW_ISO,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    body = { unparseableStdout: stdout.slice(0, 200) };
  }
  return {
    code: proc.exitCode ?? -1,
    body,
    stdout,
    stderr: proc.stderr.toString(),
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function integrityOf(result: CliResult): Record<string, unknown> {
  return objectOf(result.body["integrity"]);
}

function countersOf(
  integrity: Record<string, unknown>,
): Record<string, unknown> {
  return objectOf(integrity["counters"]);
}

function observationsOf(
  integrity: Record<string, unknown>,
): Record<string, unknown> {
  return objectOf(integrity["observations"]);
}

function cleanRoot(
  overrides: Parameters<typeof buildFixtureRoot>[0] = {},
): string {
  return track(
    buildFixtureRoot({
      corpusFixture: GROUP_VALID_CORPUS_FIXTURE,
      ...overrides,
    }),
  );
}

describe("status --json integrity contract", () => {
  test("clean corpus is verified, with coverage and zero violations", () => {
    const root = cleanRoot();
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    expect(result.body["success"]).toBe(true);
    const integrity = integrityOf(result);
    expect(integrity["schemaVersion"]).toBe(1);
    expect(integrity["status"]).toBe("verified");
    expect(integrity["policyVersion"]).toBe("group-integrity-policy@1");
    const counters = countersOf(integrity);
    expect(counters["rows"]).toBe(6);
    expect(counters["groups"]).toBe(4);
    expect(counters["crossPlayerGroups"]).toBe(0);
    expect(counters["crossPartnerGroups"]).toBe(0);
    expect(counters["ticketFieldConflicts"]).toBe(0);
    expect(counters["invalidFinancialValues"]).toBe(0);
    const observations = observationsOf(integrity);
    // Mixed leg state and partially graded groups are observations, not violations.
    expect(observations["mixedStateGroups"]).toBe(1);
    expect(observations["partiallyGradedGroups"]).toBe(1);
    // Existing payload fields are preserved.
    expect(typeof result.body["corpus"]).toBe("object");
    expect(typeof result.body["model"]).toBe("object");
    expect(Array.isArray(result.body["sources"])).toBe(true);
    expect(typeof result.body["nextStep"]).toBe("string");
  });

  test("settlement verification is a separate top-level status, never inside integrity", () => {
    const root = cleanRoot();
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const settlement = objectOf(result.body["settlementVerification"]);
    expect(settlement["status"]).toBe("unverified");
    expect(settlement["blockedBy"]).toBe("no_same_book_settlement_ledger");
    const integrity = integrityOf(result);
    expect(integrity["settlementVerification"]).toBeUndefined();
    expect(integrity["settlement"]).toBeUndefined();
  });

  test("the deliberately invalid fixture still reports six cross-player groups", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("invalid");
    const counters = countersOf(integrity);
    expect(counters["groups"]).toBe(9);
    expect(counters["crossPlayerGroups"]).toBe(6);
    const violationCounts = objectOf(integrity["violationCounts"]);
    expect(violationCounts["BET_GROUP_MULTIPLE_PLAYERS"]).toBe(6);
  });

  test("an unknown provider enum is reported as incomplete schema drift", async () => {
    const root = cleanRoot();
    const corpusPath = join(root, CORPUS_PRIMARY_REL);
    const document = (await Bun.file(corpusPath).json()) as {
      r: { bets: Array<Record<string, unknown>> };
    };
    const first = document.r.bets[0];
    if (first === undefined) throw new Error("fixture corpus has no rows");
    first["state"] = "9";
    writeAt(root, CORPUS_PRIMARY_REL, `${JSON.stringify(document, null, 2)}\n`);
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("incomplete");
    const observations = observationsOf(integrity);
    expect(observations["unknownStates"]).toEqual([9]);
    expect(countersOf(integrity)["crossPlayerGroups"]).toBe(0);
  });

  test("genuinely overlapping captures are validated once, not double-counted", async () => {
    const root = cleanRoot();
    // Same groups, different bytes: a real second capture that overlaps the first, not a copy.
    const document = (await Bun.file(
      join(root, CORPUS_PRIMARY_REL),
    ).json()) as { r: { bets: Array<Record<string, unknown>> } };
    const first = document.r.bets[0];
    if (first === undefined) throw new Error("fixture corpus has no rows");
    first["logTime"] = "1793163601";
    writeAt(
      root,
      CORPUS_FALLBACK_REL,
      `${JSON.stringify(document, null, 2)}\n`,
    );
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("verified");
    const counters = countersOf(integrity);
    // 6 rows per capture, the same 4 groups in both; groups count once.
    expect(counters["rows"]).toBe(12);
    expect(counters["groups"]).toBe(4);
    expect(counters["overlappingGroups"]).toBe(4);
    expect(counters["crossPlayerGroups"]).toBe(0);
    expect(counters["ticketFieldConflicts"]).toBe(0);
  });

  test("byte-identical fallback copies are one capture, not double-counted", () => {
    const root = track(
      buildFixtureRoot({
        corpusFixture: GROUP_VALID_CORPUS_FIXTURE,
        corpusFallbackFixture: GROUP_VALID_CORPUS_FIXTURE,
      }),
    );
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("verified");
    const counters = countersOf(integrity);
    expect(counters["rows"]).toBe(6);
    expect(counters["groups"]).toBe(4);
    expect(counters["overlappingGroups"]).toBe(0);
  });

  test("an absent corpus is unavailable, never verified-with-zero", () => {
    const root = track(buildFixtureRoot({ corpus: false }));
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("unavailable");
    const counters = countersOf(integrity);
    expect(counters["rows"]).toBe(0);
    expect(counters["groups"]).toBe(0);
    expect(objectOf(result.body["settlementVerification"])["status"]).toBe(
      "unverified",
    );
  });

  test("a malformed groupIntegrity policy fails explicitly", () => {
    const root = cleanRoot({
      groupIntegrity: { allowedStates: [9] },
    });
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(1);
    expect(result.body["success"]).toBe(false);
    const error = result.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("invalid_config");
    expect(String(error["message"])).toContain("groupIntegrity.allowedStates");
  });
});

describe("bets --json integrity contract", () => {
  test("the loaded corpus integrity is exposed unchanged", () => {
    const root = cleanRoot();
    const result = runCli(root, ["bets", "--limit", "3"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("verified");
    expect(countersOf(integrity)["groups"]).toBe(4);
    expect(typeof result.body["aggregate"]).toBe("object");
    expect(Array.isArray(result.body["sample"])).toBe(true);
  });

  test("the invalid fixture exposes its violations through bets too", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["bets", "--limit", "2"]);
    expect(result.code).toBe(0);
    const integrity = integrityOf(result);
    expect(integrity["status"]).toBe("invalid");
    expect(countersOf(integrity)["crossPlayerGroups"]).toBe(6);
  });
});

describe("loadFraudConfig groupIntegrity validation", () => {
  test("a missing block keeps the defaults", async () => {
    const root = track(makeRoot());
    const loaded = await loadFraudConfig(root);
    expect(loaded.config.groupIntegrity.policyVersion).toBe(
      "group-integrity-policy@1",
    );
    expect(loaded.config.groupIntegrity.allowedStates).toEqual([
      -1, 0, 1, 2, 3,
    ]);
  });

  test("a malformed block throws instead of falling back", async () => {
    const root = track(makeRoot());
    writeAt(root, "config/fraud-model.json", {
      schemaVersion: 1,
      kind: "fraud-model-config",
      groupIntegrity: { allowedStates: "not-an-array" },
    });
    await expect(loadFraudConfig(root)).rejects.toBeInstanceOf(
      FraudConfigError,
    );
  });

  test("allowed enums must be a subset of known enums", async () => {
    const root = track(makeRoot());
    writeAt(root, "config/fraud-model.json", {
      schemaVersion: 1,
      kind: "fraud-model-config",
      groupIntegrity: { knownStates: [1, 2], allowedStates: [1, 7] },
    });
    await expect(loadFraudConfig(root)).rejects.toThrow(
      /subset of knownStates/,
    );
  });

  test("the clean fixture sidecar hashes the clean fixture, not the invalid one", () => {
    const root = cleanRoot();
    const sidecar = `${sha256Of(fixtureText(GROUP_VALID_CORPUS_FIXTURE))}  ${CORPUS_PRIMARY_REL}\n`;
    expect(corpusSidecarText(root)).toBe(sidecar);
  });

  test("fixture JSON is parseable and the valid fixture has no cross-player groups", () => {
    const document = readFixtureJson(GROUP_VALID_CORPUS_FIXTURE) as {
      r: { bets: Array<{ betGroupId: string; userID: string }> };
    };
    const owners = new Map<string, Set<string>>();
    for (const bet of document.r.bets) {
      const set = owners.get(bet.betGroupId) ?? new Set<string>();
      set.add(bet.userID);
      owners.set(bet.betGroupId, set);
    }
    expect([...owners.values()].every((set) => set.size === 1)).toBe(true);
  });
});

function corpusSidecarText(root: string): string {
  return fixtureTextOf(join(root, "Scratch/security/corpus/sha256.txt"));
}

function fixtureTextOf(path: string): string {
  // Local sync read keeps this assertion independent of the CLI under test.
  return readFileSync(path, "utf8");
}
