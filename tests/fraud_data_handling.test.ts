import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  CLI_PATH,
  FIXED_NOW_ISO,
  buildFixtureRoot,
  readFixtureJson,
  writeAt,
} from "./fixtures/fraud/support.ts";

const ROOT = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(async () => {
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

function rawFixtureIps(): readonly string[] {
  const document = readFixtureJson("betreport-small.json") as {
    r: { bets: Record<string, unknown>[] };
  };
  return [
    ...new Set(
      document.r.bets
        .map((bet) => String(bet["ipAddress"] ?? "").trim())
        .filter((value) => value !== ""),
    ),
  ];
}

/** Commands that answer successfully against the crafted fixture root. */
const READ_COMMANDS = [
  ["status"],
  ["bets"],
  ["queue"],
  ["ip-graph"],
  ["weblog"],
  ["patterns"],
  ["explore"],
  ["dossier", "U003"],
  ["research"],
] as const;

describe("data handling invariants across every read command", () => {
  test("no command emits a raw fixture IP and every answer carries sources + timing", () => {
    const root = track(buildFixtureRoot());
    const rawIps = rawFixtureIps();
    expect(rawIps.length).toBeGreaterThan(0);

    for (const args of READ_COMMANDS) {
      const result = runCli(root, args);
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.body.success).toBe(true);
      expect(Array.isArray(result.body.sources)).toBe(true);
      expect(
        result.body.timing !== null && typeof result.body.timing === "object",
      ).toBe(true);
      for (const rawIp of rawIps) {
        expect(
          result.stdout.includes(rawIp),
          `${args.join(" ")} leaked ${rawIp}`,
        ).toBe(false);
      }
    }
  });

  test("status reports a measured dataHandling audit block, not zeros", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    const sources = result.body.sources as readonly {
      id: string;
      sha256: string | null;
    }[];
    const block = result.body.dataHandling as {
      masking: {
        rawIpEmitted: boolean;
        maskedFields: string[];
        selfCheck: string;
      };
      integrity: {
        sources: number;
        withSha256: string[];
        withoutSha256: string[];
        fixtureSources: string[];
        missingSources: string[];
        provenance: Record<string, number>;
      };
      auditability: { envelope: string[]; modelFitsExcludeFixtures: boolean };
      limits: string[];
    };
    expect(block.masking.rawIpEmitted).toBe(false);
    expect(block.masking.maskedFields).toEqual([
      "ipMasked",
      "ipTag",
      "ipPrefix24",
    ]);
    expect(block.masking.selfCheck).toContain("no IPv4 literal");
    expect(block.integrity.sources).toBe(sources.length);
    expect(
      block.integrity.withSha256.length + block.integrity.withoutSha256.length,
    ).toBe(sources.length);
    expect(block.integrity.missingSources.length).toBeGreaterThan(0);
    expect(block.integrity.fixtureSources).toContain("customer_book");
    expect(
      Object.values(block.integrity.provenance).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(sources.length);
    expect(block.auditability.envelope).toEqual(["sources", "timing"]);
    expect(block.auditability.modelFitsExcludeFixtures).toBe(true);
    expect(block.limits.length).toBeGreaterThan(0);
  });

  test("explore is read-only, bounded and carries no frozen-catalog change", async () => {
    const root = track(buildFixtureRoot());
    // The CLI resolves the Lead-owned catalog relative to its --root; copy the real one in so the
    // backlog path is exercised without reading the repo from the CLI.
    writeAt(
      root,
      "config/fraud-research.json",
      await Bun.file(join(ROOT, "config", "fraud-research.json")).text(),
    );
    const result = runCli(root, ["explore", "--limit", "3"]);
    expect(result.code).toBe(0);
    expect(result.body.command).toBe("explore");
    expect(Array.isArray(result.body.backlog)).toBe(true);
    expect((result.body.backlog as unknown[]).length).toBeGreaterThan(0);
    expect((result.body.frozenDetectors as unknown[]).length).toBeGreaterThan(
      0,
    );
    const candidates = result.body.candidates as Record<
      string,
      { status: string; rows: unknown[]; caveat: string }
    >;
    for (const candidate of Object.values(candidates)) {
      expect(candidate.status).toBe("exploratory");
      expect(candidate.rows.length).toBeLessThanOrEqual(3);
      expect(candidate.caveat.length).toBeGreaterThan(20);
    }
  });
});
