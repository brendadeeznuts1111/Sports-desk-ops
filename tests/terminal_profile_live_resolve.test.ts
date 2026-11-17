import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";

// `data/live-wagers.json` is a gitignored live-rotating capture (see .gitignore).
// On CI / fresh clones it does not exist, and locally cron refreshes rotate open logins.
const liveWagersPath = resolve(import.meta.dir, "../data/live-wagers.json");
const hasLiveDcc306 =
  existsSync(liveWagersPath) &&
  readFileSync(liveWagersPath, "utf8").includes('"DCC306"');
const describeWithLiveDcc306 = describe.skipIf(!hasLiveDcc306);

describeWithLiveDcc306("terminal profile live book resolve", () => {
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
