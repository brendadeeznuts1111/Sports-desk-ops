import { describe, expect, test } from "bun:test";
import {
  isPartner118Channel,
  PARTNER_118_CHANNELS,
  WAGER_CHANNEL_LABELS,
  wagerChannelOf,
} from "@sportsdesk-ops/contracts";
import { writerOf } from "../lib/live_wagers.ts";

describe("wagerChannelOf", () => {
  test("classifies the four wire writers and preserves the raw label", () => {
    expect(wagerChannelOf("GSLIVE")).toBe("gslive");
    expect(
      wagerChannelOf("GSBUILDER                                         "),
    ).toBe("gsbuilder");
    expect(wagerChannelOf("Internet")).toBe("internet");
    expect(wagerChannelOf("alert")).toBe("alert");
  });

  test("never guesses a channel for unknown or missing writers", () => {
    expect(wagerChannelOf("EZL - INTERNET")).toBe("other");
    expect(wagerChannelOf("")).toBe("other");
    expect(wagerChannelOf(null)).toBe("other");
    expect(wagerChannelOf(42)).toBe("other");
  });

  test("the ingest projection and the dashboard share one classifier", () => {
    for (const writer of [
      "GSLIVE",
      "GSBUILDER",
      "Internet",
      "ALERT",
      "BLOCKED",
    ]) {
      expect(writerOf(writer)).toBe(wagerChannelOf(writer));
    }
    expect(writerOf("not-a-writer")).toBe(wagerChannelOf("not-a-writer"));
  });

  test("Partner 118 is exactly gslive + gsbuilder", () => {
    expect([...PARTNER_118_CHANNELS]).toEqual(["gslive", "gsbuilder"]);
    expect(isPartner118Channel("gslive")).toBe(true);
    expect(isPartner118Channel("gsbuilder")).toBe(true);
    expect(isPartner118Channel("internet")).toBe(false);
    expect(WAGER_CHANNEL_LABELS.gsbuilder).toBe("GS Builder");
  });
});
