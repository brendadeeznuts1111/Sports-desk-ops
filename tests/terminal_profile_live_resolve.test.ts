import { describe, expect, test } from "bun:test";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";

describe("terminal profile live book resolve", () => {
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
