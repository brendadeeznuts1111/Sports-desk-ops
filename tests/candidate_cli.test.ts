import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  createMatchEvaluationStore,
  evaluateCandidateOverlay,
} from "../lib/candidate_match_evaluation.ts";
import {
  DEFAULT_MATCH_POLICY,
  hashPolicy,
  type MatchPolicy,
} from "../lib/candidate_ticket_enrich.ts";
import { auditRunAt, auditRunId } from "../lib/audit_run_id.ts";

describe("candidate_cli", () => {
  test("pin subcommand exits 0", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "cli/sportsdesk_candidate_cli.ts", "pin"],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("replay exits 2 when policy flip-flops matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candidate-replay-"));
    const dbPath = join(dir, "eval.sqlite");
    const policyPath = join(dir, "policy-v3.json");
    const v3: MatchPolicy = { ms: 15, mode: "exact" };
    writeFileSync(policyPath, JSON.stringify(v3));

    const pending = await Bun.file(
      join(
        import.meta.dir,
        "fixtures/candidate-match-pending-football-college.json",
      ),
    ).json();
    const ticker = {
      matchKey: pending.matchKey,
      timeDifferenceMs: 12,
      payload: { lane: "GATEWAY", seq: 2 },
    };
    const baseline = DEFAULT_MATCH_POLICY;
    const result = evaluateCandidateOverlay(ticker, pending, baseline);
    const db = new Database(dbPath);
    const store = createMatchEvaluationStore(db);
    store.insertEvaluation({
      result,
      replayInput: {
        ticker,
        pending,
        validTime: "2026-10-15T12:00:00.000Z",
      },
      runId: auditRunId("cli-test-run"),
      runAt: auditRunAt("2026-10-15T12:00:00.000Z"),
    });
    db.close();

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "cli/sportsdesk_candidate_cli.ts",
        "replay",
        "--db",
        dbPath,
        "--policy",
        policyPath,
        "--baseline-policy-sha256",
        hashPolicy(baseline),
        "--since",
        "2026-10-01",
        "--until",
        "2026-10-31",
        "--json",
      ],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
    });
    const code = await proc.exited;
    const out = await proc.stdout.text();
    const body = JSON.parse(out) as { newlyAccepted: number; exitCode: number };
    expect(body.newlyAccepted).toBe(1);
    expect(code).toBe(2);
  });

  test("verify exits 5 on serializer drift", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candidate-verify-"));
    const dbPath = join(dir, "eval.sqlite");
    const pending = await Bun.file(
      join(
        import.meta.dir,
        "fixtures/candidate-match-pending-football-college.json",
      ),
    ).json();
    const ticker = {
      matchKey: pending.matchKey,
      timeDifferenceMs: 8,
      payload: { lane: "GATEWAY", seq: 1 },
    };
    const baseline = DEFAULT_MATCH_POLICY;
    const db = new Database(dbPath);
    const store = createMatchEvaluationStore(db);
    const good = evaluateCandidateOverlay(ticker, pending, baseline);
    store.insertEvaluation({
      result: good,
      replayInput: { ticker, pending },
      runId: auditRunId("a"),
      runAt: auditRunAt("2026-10-01T00:00:00.000Z"),
    });
    store.insertEvaluation({
      result: { ...good, candidateRows: 0, unresolvedRows: 1 },
      replayInput: { ticker, pending },
      runId: auditRunId("b"),
      runAt: auditRunAt("2026-10-02T00:00:00.000Z"),
    });
    db.close();

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "cli/sportsdesk_candidate_cli.ts",
        "verify",
        "--db",
        dbPath,
      ],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(5);
  });

  test("verify exits 5 on valid_time fork", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candidate-valid-fork-"));
    const dbPath = join(dir, "eval.sqlite");
    const pending = await Bun.file(
      join(
        import.meta.dir,
        "fixtures/candidate-match-pending-football-college.json",
      ),
    ).json();
    const ticker = {
      matchKey: pending.matchKey,
      timeDifferenceMs: 8,
      payload: { lane: "GATEWAY", seq: 1 },
    };
    const baseline = DEFAULT_MATCH_POLICY;
    const db = new Database(dbPath);
    const store = createMatchEvaluationStore(db);
    const result = evaluateCandidateOverlay(ticker, pending, baseline);
    store.insertEvaluation({
      result,
      replayInput: {
        ticker,
        pending,
        validTime: "2026-10-01T12:00:00.000Z",
      },
      runId: auditRunId("a"),
      runAt: auditRunAt("2026-10-01T00:00:00.000Z"),
    });
    store.insertEvaluation({
      result,
      replayInput: {
        ticker,
        pending,
        validTime: "2026-10-02T12:00:00.000Z",
      },
      runId: auditRunId("b"),
      runAt: auditRunAt("2026-10-02T00:00:00.000Z"),
    });
    db.close();

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "cli/sportsdesk_candidate_cli.ts",
        "verify",
        "--db",
        dbPath,
      ],
      cwd: import.meta.dir + "/..",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(5);
  });

  test("replay exits 4 when valid_time axis and rows lack validTime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candidate-valid-time-"));
    const dbPath = join(dir, "eval.sqlite");
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(DEFAULT_MATCH_POLICY));

    const pending = await Bun.file(
      join(
        import.meta.dir,
        "fixtures/candidate-match-pending-football-college.json",
      ),
    ).json();
    const ticker = {
      matchKey: pending.matchKey,
      timeDifferenceMs: 8,
      payload: { lane: "GATEWAY", seq: 1 },
    };
    const db = new Database(dbPath);
    const store = createMatchEvaluationStore(db);
    store.insertEvaluation({
      result: evaluateCandidateOverlay(ticker, pending, DEFAULT_MATCH_POLICY),
      replayInput: { ticker, pending },
      runId: auditRunId("no-valid"),
      runAt: auditRunAt("2026-10-15T00:00:00.000Z"),
    });
    db.close();

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "cli/sportsdesk_candidate_cli.ts",
        "replay",
        "--db",
        dbPath,
        "--policy",
        policyPath,
        "--baseline-policy-sha256",
        hashPolicy(DEFAULT_MATCH_POLICY),
        "--since-axis",
        "valid_time",
        "--since",
        "2026-10-01",
      ],
      cwd: import.meta.dir + "/..",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(4);
  });
});
