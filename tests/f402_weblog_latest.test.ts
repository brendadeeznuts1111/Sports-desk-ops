import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadWeblogLatest } from "../lib/f402_weblog_latest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "weblog-latest-"));
  dirs.push(dir);
  return dir;
};
const rollup = {
  kind: "f402-weblog",
  rows: { total: 1 },
  join: {},
  flags: {},
  ipClasses: {},
  gates: [],
};

describe("f402 weblog latest", () => {
  test("resolves a local pointer to its keyed rollup", async () => {
    const root = temp();
    writeFileSync(join(root, "rollup.json"), JSON.stringify(rollup));
    writeFileSync(
      join(root, "f402-weblog-latest.json"),
      JSON.stringify({ key: "rollup.json" }),
    );
    // resolver probes Scratch/weblog/latest.json; place the pointer there
    const scratch = join(root, "Scratch/weblog");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, "latest.json"),
      JSON.stringify({ key: join(root, "rollup.json") }),
    );
    const latest = await loadWeblogLatest({ root });
    expect(latest.status).toBe("ok");
    if (latest.status === "ok") expect(latest.rollup.kind).toBe("f402-weblog");
  });

  test("falls back to the R2 pointer chain", async () => {
    const calls: string[] = [];
    const latest = await loadWeblogLatest({
      root: temp(),
      r2LatestUrl: "https://cdn.test/f402-weblog/latest.json",
      fetchImpl: async (url) => {
        calls.push(url);
        return url.endsWith("latest.json")
          ? new Response(
              JSON.stringify({ key: "f402-weblog/2026-11-02/rollup.json" }),
              { status: 200 },
            )
          : new Response(JSON.stringify(rollup), { status: 200 });
      },
    });
    expect(calls).toEqual([
      "https://cdn.test/f402-weblog/latest.json",
      "https://cdn.test/f402-weblog/2026-11-02/rollup.json",
    ]);
    expect(latest.status).toBe("ok");
  });

  test("returns unavailable instead of throwing", async () => {
    const latest = await loadWeblogLatest({
      root: temp(),
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    expect(latest.status).toBe("unavailable");
  });
});
