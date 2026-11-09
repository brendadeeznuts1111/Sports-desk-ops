import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultWeblogCapturePath,
  resolveWeblogCorpusPaths,
  WEBLOG_BRIDGE_USAGE_HINT,
} from "../lib/f402_weblog_bridge_inputs.ts";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "t".repeat(32);

const weblogLine = (loginId: string, accessDateTime: string) =>
  JSON.stringify({
    AccessDateTime: accessDateTime,
    LoginID: loginId,
    IPAddress: "203.0.113.1",
    Operation: "login",
  });

describe("f402_weblog_bridge inputs", () => {
  test("defaultWeblogCapturePath matches staging convention", () => {
    expect(defaultWeblogCapturePath("2026-11-08")).toBe(
      "out/f402/weblog/11-08-2026.jsonl",
    );
  });

  test("--fetch-mode captures then returns that path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-bridge-"));
    const capturePath = join(dir, "capture.jsonl");
    const captured: { capturePath: string; mode: string }[] = [];
    const result = await resolveWeblogCorpusPaths(
      {
        "fetch-mode": "A",
        date: "2026-11-08",
        "save-capture": capturePath,
        "bearer-token": TOKEN,
      },
      {
        resolveToken: () => ({ token: TOKEN, source: "cli" as const }),
        fetchAndPersist: async (opts) => {
          captured.push({
            capturePath: opts.capturePath,
            mode: opts.request.mode,
          });
          writeFileSync(
            opts.capturePath,
            `${weblogLine("BB7884", "2026-11-08 12:00:00")}\n`,
            { mode: 0o600 },
          );
          return {
            rows: [],
            body: {},
            url: "https://mock.test/cloud/api/Manager/getWebLog",
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.paths).toEqual([capturePath]);
    expect(captured[0]?.capturePath).toBe(capturePath);
    expect(captured[0]?.mode).toBe("A");
    expect(existsSync(capturePath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("--fetch-mode B is rejected for activity rollup", async () => {
    const result = await resolveWeblogCorpusPaths({
      "fetch-mode": "B",
      date: "2026-11-08",
      "bearer-token": TOKEN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/not supported/);
    expect(result.message).toMatch(/LoginID, IPAddress/);
  });

  test("--from without --fetch-mode still resolves paths", async () => {
    const result = await resolveWeblogCorpusPaths({
      from: "a.jsonl,b.jsonl",
    });
    expect(result).toEqual({ ok: true, paths: ["a.jsonl", "b.jsonl"] });
  });

  test("neither --from nor --fetch-mode fails with hint", async () => {
    const result = await resolveWeblogCorpusPaths({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(WEBLOG_BRIDGE_USAGE_HINT);
  });
});

describe("f402_weblog_bridge CLI", () => {
  test("exits 2 with usage hint when no corpus source", () => {
    const proc = Bun.spawnSync(["bun", "scripts/f402_weblog_bridge.ts"], {
      cwd: ROOT,
      stderr: "pipe",
      stdout: "pipe",
      env: { ...Bun.env, F402_BEARER_TOKEN: "" },
    });
    expect(proc.exitCode).toBe(2);
    const err = proc.stderr.toString();
    expect(err).toContain("--from required");
    expect(err).toContain("--fetch-mode");
  });

  test("--from + --dry-run rolls up fixture jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-cli-"));
  try {
    const jsonl = join(dir, "corpus.jsonl");
    writeFileSync(
      jsonl,
      `${weblogLine("U1", "2026-11-08 10:00:00")}\n`,
      { mode: 0o600 },
    );
    const bets = join(dir, "bets.jsonl");
    writeFileSync(bets, "", { mode: 0o600 });
    const out = join(dir, "rollup.json");
    const proc = Bun.spawnSync(
      [
        "bun",
        "scripts/f402_weblog_bridge.ts",
        "--from",
        jsonl,
        "--bets",
        bets,
        "--out",
        out,
        "--dry-run",
        "--no-r2",
      ],
      { cwd: ROOT, stderr: "pipe", stdout: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(proc.stdout.toString()).toContain("gates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
});
