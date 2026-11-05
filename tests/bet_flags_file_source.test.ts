import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The flags CLI's `--source file` path: a recorded getBetTicker capture is parsed into the same
 * wide records the rules evaluate, and the HTML table is refused because it carries no account
 * identity. Also pins the `kalshi` arming report: unarmed is the normal state in this checkout,
 * and no order path is reachable from the CLI.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli/sportsdesk_bet_flags_cli.ts");
const JSON_FIXTURE = join(
  import.meta.dir,
  "fixtures/live-wagers-list-sample.json",
);
const HTML_FIXTURE = join(import.meta.dir, "fixtures/bet-ticker.html");
const TMP = mkdtempSync(join(tmpdir(), "bet-flags-file-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
    env: { ...Bun.env, EXECUTION_LIVE: "", EXECUTION_MODE: "" },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return { code, stdout, stderr };
}

function json(runResult: Run): Record<string, unknown> {
  const parsed: unknown = JSON.parse(runResult.stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`expected one JSON object, got ${runResult.stdout}`);
  }
  return parsed as Record<string, unknown>;
}

describe("--source file", () => {
  test("parses a recorded getBetTicker capture into wide records", async () => {
    const result = await run([
      "scan",
      "--json",
      "--source",
      "file",
      "--file",
      JSON_FIXTURE,
    ]);
    expect(result.code).toBe(0);
    const payload = json(result);
    expect(payload["success"]).toBe(true);
    const source = payload["source"] as Record<string, unknown>;
    expect(source["kind"]).toBe("file-capture");
    expect(source["transport"]).toBe("file-capture");
    const counts = payload["counts"] as Record<string, unknown>;
    expect(counts["rows"]).toBe(7);
    expect(typeof counts["findings"]).toBe("number");
  });

  test("refuses an HTML capture with the account-identity reason", async () => {
    const result = await run([
      "scan",
      "--json",
      "--source",
      "file",
      "--file",
      HTML_FIXTURE,
    ]);
    expect(result.code).toBe(3);
    const payload = json(result);
    expect(payload["success"]).toBe(false);
    const error = payload["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("source_unavailable");
    const details = error["details"] as Record<string, unknown>;
    const diagnostic = details["diagnostic"] as Record<string, unknown>;
    expect(diagnostic["code"]).toBe("file_unsupported_html");
    expect(String(diagnostic["message"])).toContain(
      "no customer/agent identity",
    );
  });

  test("requires --file when the source is file", async () => {
    const result = await run(["scan", "--source", "file"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--source file requires --file");
  });

  test("a missing capture is a structured file_missing refusal", async () => {
    const result = await run([
      "scan",
      "--json",
      "--source",
      "file",
      "--file",
      join(TMP, "absent.json"),
    ]);
    expect(result.code).toBe(3);
    const payload = json(result);
    const error = payload["error"] as Record<string, unknown>;
    const details = error["details"] as Record<string, unknown>;
    expect((details["diagnostic"] as Record<string, unknown>)["code"]).toBe(
      "file_missing",
    );
  });
});

describe("alert from a capture file", () => {
  test("dry-run reports simulated deliveries and writes no dedupe ledger", async () => {
    const root = mkdtempSync(join(TMP, "root-"));
    // The rules pack is root-relative; copy the shipped one into the temp root.
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync(
      join(ROOT, "config/bet-flags.yml"),
      join(root, "config/bet-flags.yml"),
    );
    writeFileSync(join(root, "keep.txt"), "scratch");
    const result = await run([
      "alert",
      "--json",
      "--root",
      root,
      "--source",
      "file",
      "--file",
      JSON_FIXTURE,
      "--dry-run",
      "--min-severity",
      "info",
    ]);
    expect(result.code).toBe(0);
    const payload = json(result);
    expect(payload["success"]).toBe(true);
    const summary = payload["summary"] as Record<string, unknown>;
    expect(Number(summary["scannedFindings"])).toBeGreaterThan(0);
    expect(Number(summary["simulated"])).toBeGreaterThan(0);
    // The dry run must not create Scratch/watchlist-autobet/alert-state.json under the root.
    const statePath = join(root, "Scratch/watchlist-autobet/alert-state.json");
    expect(await Bun.file(statePath).exists()).toBe(false);
  });
});

describe("kalshi arming report", () => {
  test("is unarmed in a checkout with no credentials or live env, with exact reasons", async () => {
    const result = await run(["kalshi", "--json"]);
    expect(result.code).toBe(3);
    const payload = json(result);
    expect(payload["success"]).toBe(false);
    const error = payload["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("kalshi_not_armed");
    const arming = (error["details"] as Record<string, unknown>)[
      "arming"
    ] as Record<string, unknown>;
    expect(arming["armed"]).toBe(false);
    expect(arming["mode"]).toBe("paper");
    expect(Array.isArray(arming["blockingReasons"])).toBe(true);
    expect(JSON.stringify(arming)).not.toContain("PRIVATE KEY");
  });

  test("documents the credential names without reading values", async () => {
    const result = await run(["kalshi", "--json"]);
    const payload = json(result);
    const arming = (
      (payload["error"] as Record<string, unknown>)["details"] as Record<
        string,
        unknown
      >
    )["arming"] as Record<string, unknown>;
    const creds = arming["credentials"] as Record<string, unknown>;
    expect(creds["apiKeyIdEnv"]).toBe("KALSHI_API_KEY_ID");
    expect(creds["privateKeyPathEnv"]).toBe("KALSHI_PRIVATE_KEY_PATH");
    expect(creds["keychainService"]).toBe("com.bookdeskops.sportsdesk");
  });
});
