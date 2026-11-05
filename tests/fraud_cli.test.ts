import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  CLI_PATH,
  FIXED_NOW_ISO,
  buildFixtureRoot,
  buildSyntheticRoot,
  makeRoot,
  readFixtureJson,
  writeAt,
} from "./fixtures/fraud/support.ts";

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
  readonly stdout: string;
  readonly stderr: string;
  readonly body: Record<string, unknown>;
}

function runCliRaw(
  args: readonly string[],
  nowIso: string = FIXED_NOW_ISO,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      ...(args.includes("--json") ? [] : ["--json"]),
      ...(args.some((arg) => arg.startsWith("--now")) ? [] : ["--now", nowIso]),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Run the real CLI with global flags appended AFTER the command (the plugin does this). */
function runCli(
  root: string,
  args: readonly string[],
  nowIso: string = FIXED_NOW_ISO,
): CliResult {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      nowIso,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    body = {};
  }
  return { code: proc.exitCode ?? -1, stdout, stderr, body };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorCode(result: CliResult): string {
  return String(record(result.body["error"])["code"] ?? "");
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

function assertNoRawIps(text: string): void {
  for (const ip of rawFixtureIps()) {
    expect(text.includes(ip)).toBe(false);
  }
}

/* -------------------------------------------------------------------------- */
/* Status, sources and the envelope contract                                   */
/* -------------------------------------------------------------------------- */

describe("CLI envelope and status", () => {
  test("status prints one success object with all 11 sources and timing", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    expect(result.body["success"]).toBe(true);
    expect(result.body["schemaVersion"]).toBe(1);
    expect(result.body["command"]).toBe("status");
    expect(typeof result.body["generatedAt"]).toBe("string");
    const sources = result.body["sources"] as unknown[];
    expect(sources).toHaveLength(11);
    const corpus = record(result.body["corpus"]);
    expect(corpus["rows"]).toBe(16);
    expect(corpus["accounts"]).toBe(12);
    expect(corpus["sha256"]).not.toBeNull();
    const model = record(result.body["model"]);
    expect(model["present"]).toBe(false);
    expect(model["metrics"]).toBeNull();
    expect(model["command"]).toContain("model fit --write");
    expect(String(result.body["nextStep"])).toContain("model fit");
    expect(typeof record(result.body["timing"])["elapsedMs"]).toBe("number");
    const weblogState = (sources as Record<string, unknown>[]).find(
      (source) => source["id"] === "gslive_weblogs",
    );
    expect(weblogState?.["state"]).toBe("session_expired");
    expect(record(result.body["config"])["exists"]).toBe(true);
  });

  test("a missing root reports missing sources, never zero rows", () => {
    const root = track(makeRoot());
    const result = runCli(root, ["status"]);
    expect(result.code).toBe(0);
    expect(result.body["corpus"]).toBeNull();
    const sources = result.body["sources"] as Record<string, unknown>[];
    for (const source of sources) {
      expect(source["exists"]).toBe(false);
      expect(source["records"]).toBeNull();
    }
  });

  test("the pinned clock makes stale sources explicit", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["status"], "2026-12-01T00:00:00.000Z");
    const sources = result.body["sources"] as Record<string, unknown>[];
    const stale = sources.filter((source) => source["stale"] === true);
    expect(stale.length).toBeGreaterThan(0);
    for (const source of stale) {
      expect(source["state"]).toBe("stale");
    }
  });

  test("--json stdout is exactly one object", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["status"]);
    const trimmed = result.stdout.trim();
    expect(trimmed.startsWith("{")).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
    expect(trimmed.split("\n")).toHaveLength(1);
    expect(() => JSON.parse(trimmed)).not.toThrow();
  });

  test("every success envelope carries the command NAME (never a shell line)", () => {
    const root = track(buildFixtureRoot());
    const fixtureCases: readonly (readonly [readonly string[], string])[] = [
      [["status"], "status"],
      [["bets"], "bets"],
      [["ip-graph"], "ip-graph"],
      [["weblog"], "weblog"],
      [["patterns"], "patterns"],
      [["research"], "research"],
      [["dossier", "U003"], "dossier"],
    ];
    for (const [args, expected] of fixtureCases) {
      const result = runCli(root, args);
      expect(result.code).toBe(0);
      expect(result.body["success"]).toBe(true);
      expect(result.body["schemaVersion"]).toBe(1);
      expect(result.body["command"]).toBe(expected);
    }
    const { root: synthetic } = buildSyntheticRoot();
    track(synthetic);
    const fit = runCli(synthetic, ["model", "fit"]);
    expect(fit.code).toBe(0);
    expect(fit.body["command"]).toBe("model");
    expect(fit.body["fitCommand"]).toBe(
      "bun run cli/sportsdesk_fraud_cli.ts model fit --write --json",
    );
    expect(String(fit.body["command"])).not.toContain("bun run");
  });

  test("global flags are accepted before and after the command", () => {
    const root = track(buildFixtureRoot());
    const before = runCliRaw([
      "--json",
      "--root",
      root,
      "--now",
      FIXED_NOW_ISO,
      "status",
    ]);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout).success).toBe(true);
    const after = runCliRaw([
      "status",
      "--json",
      "--root",
      root,
      "--now",
      FIXED_NOW_ISO,
    ]);
    expect(after.code).toBe(0);
    const equalsForm = runCliRaw([
      "status",
      `--root=${root}`,
      "--now",
      FIXED_NOW_ISO,
      "--json",
    ]);
    expect(equalsForm.code).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* bets / ip-graph / weblog / patterns / research                              */
/* -------------------------------------------------------------------------- */

describe("read commands", () => {
  test("bets filters, aggregates and masks", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["bets", "--limit", "5"]);
    expect(result.code).toBe(0);
    const aggregate = record(result.body["aggregate"]);
    expect(aggregate["rows"]).toBe(16);
    expect(aggregate["suspectedBot"]).toBe(2);
    expect(aggregate["reversedCredit"]).toBe(1);
    expect(aggregate["manualLog"]).toBe(1);
    expect(aggregate["oddsDrift"]).toBe(1);
    expect(Array.isArray(aggregate["delayHistogram"])).toBe(true);
    for (const key of ["bySport", "bySubSport", "byPeriod", "byWagerType"]) {
      const rows = aggregate[key] as { value: string | null; rows: number }[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.reduce((sum, row) => sum + row.rows, 0)).toBe(16);
    }
    expect(aggregate["bySubSport"]).toEqual([{ value: null, rows: 16 }]);
    const sample = result.body["sample"] as Record<string, unknown>[];
    expect(sample).toHaveLength(5);
    for (const bet of sample) {
      // Normalized rows use the upstream API vocabulary.
      expect(bet["sport"]).toBeDefined();
      expect(bet["subSport"]).toBeNull();
      expect(bet["period"]).toBe("m");
      expect(bet["wagerType"]).toBeDefined();
      expect(String(bet["ipMasked"])).toMatch(/\*\*\*/);
      expect(String(bet["ipTag"])).toMatch(/^[0-9a-f]{8}$/);
      expect(bet["ipAddress"]).toBeUndefined();
    }
    assertNoRawIps(result.stdout);

    const noBots = runCli(root, ["bets", "--include-bots", "false"]);
    expect(record(noBots.body["aggregate"])["rows"]).toBe(14);
    const wins = runCli(root, ["bets", "--state", "1"]);
    expect(record(wins.body["aggregate"])["rows"]).toBe(1);
    const agent = runCli(root, ["bets", "--agent", "AG1"]);
    expect(Number(record(agent.body["aggregate"])["rows"])).toBeGreaterThan(0);
    expect(record(agent.body["filters"])["agent"]).toBe("AG1");
  });

  test("ip-graph returns masked clusters and a measured summary", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["ip-graph", "--limit", "10"]);
    expect(result.code).toBe(0);
    const summary = record(result.body["summary"]);
    expect(summary["distinctIps"]).toBe(13);
    expect(summary["maxAccountsPerIp"]).toBe(3);
    const clusters = result.body["clusters"] as Record<string, unknown>[];
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) {
      expect(String(cluster["key"])).toMatch(/^ip:[0-9a-f]{8}$/);
      expect(String(cluster["masked"])).toMatch(/\*\*\*/);
    }
    assertNoRawIps(result.stdout);
    const highMin = runCli(root, ["ip-graph", "--min-accounts", "3"]);
    const highClusters = highMin.body["clusters"] as unknown[];
    expect(highClusters).toHaveLength(1);
    const prefix = runCli(root, ["ip-graph", "--prefix24", "10.20.30"]);
    expect(prefix.code).toBe(0);
    const prefixClusters = prefix.body["clusters"] as Record<string, unknown>[];
    expect(prefixClusters.length).toBeGreaterThan(0);
    for (const cluster of prefixClusters) {
      expect(String(cluster["key"])).toMatch(/^prefix24:10\.20\.30$/);
    }
  });

  test("weblog exposes posture, gates and the missing activity artifact", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["weblog"]);
    expect(result.code).toBe(0);
    const posture = record(result.body["posture"]);
    expect(posture["kind"]).toBe("f402-weblog");
    expect(posture["rows"]).toHaveProperty("parsed", 998);
    const gates = result.body["gates"] as Record<string, unknown>[];
    expect(gates).toHaveLength(4);
    const flags = result.body["flags"] as Record<string, unknown>[];
    expect(flags.map((item) => item["id"])).toContain("WEBLOG_GATE_FAIL");
    expect(result.body["insufficientReason"]).toBeNull();
    expect(record(result.body["weblogsActivity"])["status"]).toBe(
      "not_measured",
    );
  });

  test("patterns returns counts that sum to the findings", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["patterns"]);
    expect(result.code).toBe(0);
    const findings = result.body["findings"] as unknown[];
    const counts = record(result.body["counts"]);
    const severity = record(counts["bySeverity"]);
    const category = record(counts["byCategory"]);
    for (const value of Object.values(severity)) {
      expect(typeof value).toBe("number");
    }
    expect(
      Object.values(severity).reduce<number>(
        (sum, value) => sum + Number(value),
        0,
      ),
    ).toBe(findings.length);
    expect(
      Object.values(category).reduce<number>(
        (sum, value) => sum + Number(value),
        0,
      ),
    ).toBe(findings.length);
    expect(Array.isArray(result.body["insufficient"])).toBe(true);
    assertNoRawIps(result.stdout);
    const critical = runCli(root, ["patterns", "--min-severity", "critical"]);
    const criticalFindings = critical.body["findings"] as Record<
      string,
      unknown
    >[];
    expect(
      criticalFindings.every((item) => item["severity"] === "critical"),
    ).toBe(true);
    const ipNetwork = runCli(root, ["patterns", "--category", "ip_network"]);
    const ipFindings = ipNetwork.body["findings"] as Record<string, unknown>[];
    expect(ipFindings.length).toBeGreaterThan(0);
    expect(ipFindings.every((item) => item["category"] === "ip_network")).toBe(
      true,
    );
    const limited = runCli(root, ["patterns", "--limit", "1"]);
    expect(limited.body["findings"]).toHaveLength(1);
  });

  test("research reports the catalog honestly when absent and when present", () => {
    const root = track(buildFixtureRoot());
    const absent = runCli(root, ["research"]);
    expect(absent.code).toBe(0);
    expect(absent.body["catalogPresent"]).toBe(false);
    expect(absent.body["catalog"]).toBeNull();
    expect((absent.body["modelLimits"] as string[]).length).toBeGreaterThan(0);
    writeAt(root, "config/fraud-research.json", {
      schemaVersion: 1,
      modelLimits: ["limit-a", "limit-b"],
    });
    const present = runCli(root, ["research"]);
    expect(present.code).toBe(0);
    expect(present.body["catalogPresent"]).toBe(true);
    expect(record(present.body["catalog"])["schemaVersion"]).toBe(1);
    expect(present.body["modelLimits"]).toEqual(["limit-a", "limit-b"]);
  });
});

describe("masking and research passthrough", () => {
  test("no raw IPv4 from the corpus appears in ANY --json output", () => {
    const root = track(buildFixtureRoot());
    const outputs: string[] = [];
    for (const args of [
      ["status"],
      ["bets", "--limit", "20"],
      ["ip-graph", "--limit", "20"],
      ["weblog"],
      ["patterns"],
      ["research"],
      ["dossier", "U003"],
    ] as const) {
      const result = runCli(root, args);
      expect(result.code).toBe(0);
      outputs.push(result.stdout);
    }
    const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    for (const stdout of outputs) {
      for (const rawIp of rawFixtureIps()) {
        expect(stdout.includes(rawIp)).toBe(false);
      }
      // The only IP-shaped literals allowed are the public bot-ring CIDR network constant.
      const literals = new Set(stdout.match(ipv4) ?? []);
      for (const literal of literals) {
        expect(literal).toBe("140.248.0.0");
      }
    }
  });

  test("research passes the Lead catalog through with its measured counts", () => {
    const root = track(buildFixtureRoot());
    const catalog = JSON.parse(
      readFileSync("config/fraud-research.json", "utf8"),
    ) as {
      externalPriorArt: unknown[];
      proposedDetectors: unknown[];
      modelLimits: unknown[];
    };
    writeAt(root, "config/fraud-research.json", catalog);
    const result = runCli(root, ["research"]);
    expect(result.code).toBe(0);
    expect(result.body["catalogPresent"]).toBe(true);
    const bodyCatalog = record(result.body["catalog"]);
    expect((bodyCatalog["externalPriorArt"] as unknown[]).length).toBe(23);
    expect((bodyCatalog["proposedDetectors"] as unknown[]).length).toBe(15);
    expect((result.body["modelLimits"] as unknown[]).length).toBe(8);
    expect(Array.isArray(bodyCatalog["thresholdProvenance"])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

describe("structured refusals (exit 3)", () => {
  test("model report and score refuse with model_missing before writing anything", () => {
    const root = track(buildFixtureRoot());
    for (const args of [
      ["model", "report"],
      ["model", "score", "U001"],
    ]) {
      const result = runCli(root, args);
      expect(result.code).toBe(3);
      expect(result.body["success"]).toBe(false);
      expect(errorCode(result)).toBe("model_missing");
      const error = record(result.body["error"]);
      expect(String(error["message"])).toContain("model fit --write");
      expect(record(error["details"])["command"]).toBe(
        "bun run cli/sportsdesk_fraud_cli.ts model fit --write --json",
      );
    }
    expect(existsSync(join(root, "reports", "security"))).toBe(false);
  });

  test("bets refuses source_missing when the corpus is absent", () => {
    const root = track(makeRoot());
    const result = runCli(root, ["bets"]);
    expect(result.code).toBe(3);
    expect(errorCode(result)).toBe("source_missing");
    const details = record(record(result.body["error"])["details"]);
    expect(Array.isArray(details["sources"])).toBe(true);
  });

  test("patterns still answers (insufficient, exit 0) without a corpus", () => {
    const root = track(makeRoot());
    const result = runCli(root, ["patterns"]);
    expect(result.code).toBe(0);
    expect((result.body["findings"] as unknown[]).length).toBeGreaterThan(0);
    expect((result.body["insufficient"] as unknown[]).length).toBeGreaterThan(
      0,
    );
  });

  test("model fit refuses insufficient_corpus with measured counts", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["model", "fit"]);
    expect(result.code).toBe(3);
    expect(errorCode(result)).toBe("insufficient_corpus");
    const details = record(record(result.body["error"])["details"]);
    expect(details["rows"]).toBe(16);
    expect(Number(details["accountsWithProxyLabel"])).toBeLessThan(20);
    expect(details["minRows"]).toBe(500);
  });

  test("dossier refuses unknown_subject and accepts a real account/agent", () => {
    const root = track(buildFixtureRoot());
    const unknown = runCli(root, ["dossier", "NOBODY"]);
    expect(unknown.code).toBe(3);
    expect(errorCode(unknown)).toBe("unknown_subject");
    const account = runCli(root, ["dossier", "U003"]);
    expect(account.code).toBe(0);
    const subject = record(account.body["subject"]);
    expect(subject["kind"]).toBe("account");
    expect(record(account.body["hierarchy"])["agentId"]).toBe("AG2");
    const agent = runCli(root, ["dossier", "AG2"]);
    expect(agent.code).toBe(0);
    expect(record(agent.body["subject"])["kind"]).toBe("agent");
  });
});

/* -------------------------------------------------------------------------- */
/* Fit -> write -> report -> score -> dossier (synthetic corpus)               */
/* -------------------------------------------------------------------------- */

describe("model lifecycle on a synthetic corpus", () => {
  test("dry run writes nothing, --write persists 0600, then report/score/dossier work", () => {
    const { root } = buildSyntheticRoot();
    track(root);
    const dry = runCli(root, ["model", "fit"]);
    expect(dry.code).toBe(0);
    expect(dry.body["written"]).toBe(false);
    expect(existsSync(join(root, "reports", "security"))).toBe(false);
    const summary = record(dry.body["summary"]);
    expect(summary["rows"]).toBe(700);
    expect(summary["featureCount"]).toBe(26);
    expect(typeof summary["aucRoc"]).toBe("number");
    expect(record(summary["labelSupport"])["proxy"]).toBe("desk_flag");
    const artifact = record(dry.body["artifact"]);
    expect(artifact["kind"]).toBe("fraud-model");
    expect((artifact["limits"] as string[]).length).toBeGreaterThan(0);

    const write = runCli(root, ["model", "fit", "--write"]);
    expect(write.code).toBe(0);
    expect(write.body["written"]).toBe(true);
    const artifactPath = join(root, "reports", "security", "fraud-model.json");
    expect(existsSync(artifactPath)).toBe(true);
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "reports", "security"))).toEqual([
      "fraud-model.json",
    ]);
    // No raw synthetic IP leaks into the persisted artifact.
    const persisted = readFileSync(artifactPath, "utf8");
    expect(/\b47\.223\.\d{1,3}\.\d{1,3}\b/.test(persisted)).toBe(false);

    const report = runCli(root, ["model", "report"]);
    expect(report.code).toBe(0);
    expect(report.body["present"]).toBe(true);
    expect((report.body["features"] as unknown[]).length).toBe(26);
    expect(record(report.body["metrics"])["aucRoc"]).not.toBeNull();
    expect((report.body["limits"] as string[]).length).toBeGreaterThan(0);

    const score = runCli(root, ["model", "score", "U003"]);
    expect(score.code).toBe(0);
    const account = record(score.body["account"]);
    expect(Number(account["score"])).toBeGreaterThanOrEqual(0);
    expect(Number(account["score"])).toBeLessThanOrEqual(100);
    expect(["low", "medium", "high", "critical"]).toContain(
      String(account["band"]),
    );
    const unknown = runCli(root, ["model", "score", "NOPE"]);
    expect(unknown.code).toBe(3);
    expect(errorCode(unknown)).toBe("unknown_subject");

    const dossier = runCli(root, ["dossier", "U003"]);
    expect(dossier.code).toBe(0);
    const model = record(dossier.body["model"]);
    expect(model["present"]).toBe(true);
    expect(model["score"]).not.toBeNull();
    expect(Array.isArray(model["contributions"])).toBe(true);

    const agentDossier = runCli(root, ["dossier", "AG01"]);
    expect(agentDossier.code).toBe(0);
    expect(record(agentDossier.body["model"])["present"]).toBe(true);

    const status = runCli(root, ["status"]);
    expect(record(status.body["model"])["present"]).toBe(true);
    expect(record(status.body["model"])["metrics"]).not.toBeNull();
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* Usage errors and help                                                       */
/* -------------------------------------------------------------------------- */

describe("usage errors (exit 2) and help", () => {
  test("unknown commands and flags are usage errors on stdout and stderr", () => {
    const root = track(buildFixtureRoot());
    const cases: readonly (readonly string[])[] = [
      ["nonsense"],
      ["status", "--bogus"],
      ["bets", "--limit", "500"],
      ["bets", "--include-bots", "maybe"],
      ["bets", "--state", "not-a-number"],
      ["bets", "--since", "not-a-date"],
      ["ip-graph", "--prefix24", "nope"],
      ["patterns", "--min-severity", "urgent"],
      ["patterns", "--category", "nope"],
      ["model", "bogus"],
      ["model", "fit", "--epochs", "10"],
      ["model", "fit", "--proxy", "nope"],
      ["status", "extra"],
    ];
    for (const args of cases) {
      const result = runCli(root, args);
      expect(result.code).toBe(2);
      expect(result.body["success"]).toBe(false);
      expect(errorCode(result)).toBe("usage_error");
      expect(result.stderr.trim().length).toBeGreaterThan(0);
    }
    const badNow = runCli(root, ["status", "--now", "not-a-date"]);
    expect(badNow.code).toBe(2);
    expect(errorCode(badNow)).toBe("usage_error");
  });

  test("--help prints command help without requiring artifacts", () => {
    const rootHelp = runCliRaw(["--help"]);
    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toContain("Commands:");
    expect(rootHelp.stdout).toContain("model");
    const commandHelp = runCliRaw(["bets", "--help"]);
    expect(commandHelp.code).toBe(0);
    expect(commandHelp.stdout).toContain("--include-bots");
    const modelHelp = runCliRaw(["model", "--help"]);
    expect(modelHelp.code).toBe(0);
    expect(modelHelp.stdout).toContain("--write");
    expect(modelHelp.stdout).toContain("--include-score-map");
  });
});
