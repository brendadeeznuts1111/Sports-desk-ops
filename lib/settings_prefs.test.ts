import { describe, expect, test } from "bun:test";
import {
  AGENT_MENUS,
  DEFAULT_SETTINGS,
  LANGUAGES,
  NOTIFY_FLAGS,
  SETTINGS_EFFECTS,
  TIMEZONES,
  formatInTimezone,
  languageTag,
  readSettings,
  timezoneOffsetHours,
} from "./settings_prefs.ts";

describe("vocabulary matches the portal modal", () => {
  test("wager alerts are Y / N", () => {
    expect(NOTIFY_FLAGS.map((flag) => flag.value)).toEqual(["Y", "N"]);
    expect(NOTIFY_FLAGS.map((flag) => flag.label)).toEqual(["On", "Off"]);
  });

  test("languages are the four the modal offers", () => {
    expect(LANGUAGES.map((entry) => entry.value)).toEqual([
      "English",
      "Spanish",
      "Chinese (Simp)",
      "French",
    ]);
    expect(LANGUAGES[2]?.lang).toBe("zh-Hans");
  });

  test("timezone codes 0-3 map to EST/CST/MST/PST", () => {
    expect(TIMEZONES.map((zone) => `${zone.value}:${zone.label}`)).toEqual([
      "0:(EST)",
      "1:(CST)",
      "2:(MST)",
      "3:(PST)",
    ]);
    expect(TIMEZONES.map((zone) => zone.offsetHours)).toEqual([-5, -6, -7, -8]);
  });

  test("agent menu keeps the portal's two options", () => {
    expect(AGENT_MENUS.map((menu) => menu.value)).toEqual([
      "Left Menu",
      "Tile Menu",
    ]);
  });
});

describe("readSettings", () => {
  test("defaults match the modal's selected options", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      notify: "Y",
      language: "English",
      timezone: "1",
      agentMenu: "Left Menu",
    });
  });

  test("accepts a full valid blob", () => {
    const settings = readSettings({
      notify: "N",
      language: "French",
      timezone: "3",
      agentMenu: "Tile Menu",
    });
    expect(settings).toEqual({
      notify: "N",
      language: "French",
      timezone: "3",
      agentMenu: "Tile Menu",
    });
  });

  test("falls back per field instead of throwing on garbage", () => {
    const settings = readSettings({
      notify: "maybe",
      language: "Klingon",
      timezone: 9,
      agentMenu: "Sidebar",
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps valid fields while replacing invalid ones", () => {
    expect(readSettings({ notify: "N", timezone: "9" })).toEqual({
      notify: "N",
      language: "English",
      timezone: "1",
      agentMenu: "Left Menu",
    });
  });

  test("trims whitespace before validating", () => {
    expect(readSettings({ language: "  French  " }).language).toBe("French");
  });
});

describe("timezone handling", () => {
  test("offsets come from the portal codes", () => {
    expect(timezoneOffsetHours("0")).toBe(-5);
    expect(timezoneOffsetHours("3")).toBe(-8);
  });

  test("formats an instant in the selected zone", () => {
    // 2026-11-01T12:00:00Z is 07:00 EST and 04:00 PST.
    expect(formatInTimezone("2026-11-01T12:00:00.000Z", "0")).toBe(
      "2026-11-01 07:00:00 (EST)",
    );
    expect(formatInTimezone("2026-11-01T12:00:00.000Z", "3")).toBe(
      "2026-11-01 04:00:00 (PST)",
    );
  });

  test("can omit the date", () => {
    expect(
      formatInTimezone("2026-11-01T12:00:00.000Z", "1", { withDate: false }),
    ).toBe("06:00:00 (CST)");
  });

  test("crosses the date boundary correctly", () => {
    // 02:00Z on the 2nd is still the evening of the 1st in EST.
    expect(formatInTimezone("2026-11-02T02:00:00.000Z", "0")).toBe(
      "2026-11-01 21:00:00 (EST)",
    );
  });

  test("returns empty for missing or unparseable input", () => {
    expect(formatInTimezone(null, "0")).toBe("");
    expect(formatInTimezone("not a date", "0")).toBe("");
  });
});

describe("language tag", () => {
  test("maps each language to a BCP-47 tag", () => {
    expect(languageTag("English")).toBe("en");
    expect(languageTag("Spanish")).toBe("es");
    expect(languageTag("Chinese (Simp)")).toBe("zh-Hans");
    expect(languageTag("French")).toBe("fr");
  });
});

describe("effects are stated", () => {
  test("every preference says what it changes", () => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<
      keyof typeof DEFAULT_SETTINGS
    >) {
      expect(SETTINGS_EFFECTS[key].length).toBeGreaterThan(20);
    }
  });

  test("language admits it does not translate the UI", () => {
    expect(SETTINGS_EFFECTS.language).toContain("No strings are translated");
  });
});
