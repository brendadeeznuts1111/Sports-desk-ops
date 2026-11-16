import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";

// `data/live-wagers.json` is a gitignored local capture (see .gitignore). Without it the
// profile matrix has no row for this login and `profile` exits 1, so these assertions are
// only meaningful on a desk machine that holds the capture. CI and fresh clones skip.
const hasLiveWagersCapture = existsSync(
  resolve(import.meta.dir, "../data/live-wagers.json"),
);
const describeWithCapture = describe.skipIf(!hasLiveWagersCapture);

describeWithCapture("terminal profile live book resolve", () => {
  test("profile DCC306 --radar uses data/live-wagers.json", async () => {
    const radarRes = await executeTerminalQuery("profile DCC306 --radar");
    expect(radarRes.exitCode).toBe(0);
    expect(radarRes.stdout).toContain("SHARPNESS RADAR DECOMPOSITION");
    expect(radarRes.stdout).toContain("DCC306");
  });

  test("profile DCC306 tier is derived from open wagers, not hardcoded", async () => {
    const res = await executeTerminalQuery("profile DCC306");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Sharpness Tier");
    expect(res.stdout).toContain("TIER_5");
    expect(res.stdout).not.toContain("TIER_4_SEMI_SHARP");
  });
});
