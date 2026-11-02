import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ticker is an independent view of who exists, so diffing it against the tree measures how
 * incomplete the tree is — 208 of 2,272 tree edges already skip a level.
 */

const dir = mkdtempSync(join(tmpdir(), "ticker-coverage-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const tree = {
  roots: ["A"],
  nodes: {
    A: { l: 1, t: "M" },
    B: { l: 2, p: "A", t: "A" },
    "RM11.": { l: 3, p: "B", t: "A" },
    CUB22: { l: 3, p: "B", t: "A" },
  },
};
const treePath = join(dir, "tree.json");
writeFileSync(treePath, JSON.stringify(tree));

const script = join(import.meta.dir, "../scripts/ticker_tree_coverage.ts");

function run(ticker: unknown, extra: string[] = []) {
  const tickerPath = join(
    dir,
    `ticker-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(tickerPath, JSON.stringify(ticker));
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      script,
      tickerPath,
      "--tree",
      treePath,
      "--json",
      ...extra,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("ticker_tree_coverage", () => {
  test("joins on AgentLogin, not the period-suffixed AgentID", () => {
    const result = run({
      LIST: [
        // padded login, unpadded AgentID with a trailing period — the real shape
        { AgentLogin: "B         ", AgentID: "B." },
        { AgentLogin: "RM11.     ", AgentID: "RM11." },
      ],
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.distinctAgents).toBe(2);
    expect(report.inTree).toBe(2);
    expect(report.missing).toEqual([]);
  });

  test("reports a missing agent with its nearest tree keys", () => {
    const result = run({
      wagers: [
        { AgentLogin: "CUB22A", AgentID: "CUB22A" },
        { AgentLogin: "KOBE8", AgentID: "KOBE8" },
      ],
    });
    const report = JSON.parse(result.out);
    expect(report.inTree).toBe(0);
    expect(
      report.missing.map((entry: { agent: string }) => entry.agent),
    ).toEqual(["CUB22A", "KOBE8"]);
    const cub = report.missing.find(
      (entry: { agent: string }) => entry.agent === "CUB22A",
    );
    expect(cub.near).toEqual(["CUB22"]);
    const kobe = report.missing.find(
      (entry: { agent: string }) => entry.agent === "KOBE8",
    );
    expect(kobe.near).toEqual([]);
  });

  test("does not strip a trailing period that is part of the key", () => {
    const result = run({ LIST: [{ AgentLogin: "RM11.", AgentID: "RM11." }] });
    const report = JSON.parse(result.out);
    expect(report.inTree).toBe(1);
  });

  test("--fail-on-missing exits 1 when the tree is short", () => {
    const result = run({ LIST: [{ AgentLogin: "KOBE8", AgentID: "KOBE8" }] }, [
      "--fail-on-missing",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(
      report.missing.map((entry: { agent: string }) => entry.agent),
    ).toEqual(["KOBE8"]);
  });

  test("--fail-on-missing exits 0 when every agent is known", () => {
    const result = run({ LIST: [{ AgentLogin: "B", AgentID: "B" }] }, [
      "--fail-on-missing",
    ]);
    expect(result.code).toBe(0);
  });
});
