/**
 * The `ui.json` resolver: fallback chain, the upstream JAPANESE bug, label rendering and
 * language coverage. Deterministic: the shipped fixture is real app data from the desktop
 * WebView cache (2026-11-04), and every assertion below is against those bytes.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_UI_TABLE_PATH,
  ENGLISH_LABEL_KEYS,
  JAPANESE_GREEK_UPSTREAM_BUG,
  KEYS_MODE,
  LANG_CODES,
  coverage,
  japaneseFallbackNotice,
  label,
  labelOrKey,
  languageList,
  loadUiTable,
  parseLangArg,
  t,
  tryLoadUiTable,
  type UiTable,
} from "../cli/i18n.ts";

describe("t() fallback chain", () => {
  const table: UiTable = {
    "L-83": { ENGLISH: "Straight", SPANISH: "Directa" },
    "L-245": { ENGLISH: "To Win", SPANISH: "" },
  };

  test("selected language wins, then ENGLISH, then the key", () => {
    expect(t("L-83", "SPANISH", table)).toBe("Directa");
    expect(t("L-83", "GREEK", table)).toBe("Straight"); // no GREEK value -> ENGLISH
    expect(t("L-245", "SPANISH", table)).toBe("To Win"); // blank is missing, not a value
    expect(t("L-999", "ENGLISH", table)).toBe("L-999"); // unknown key stays the key
  });

  test("keys mode is a pass-through (raw L-key)", () => {
    expect(t("L-83", KEYS_MODE, table)).toBe("L-83");
    expect(labelOrKey("L-83", KEYS_MODE)).toBe("L-83");
    expect(labelOrKey("L-83", "SPANISH", table)).toBe("Directa");
  });

  test("a missing table degrades to the key instead of throwing at a call site", () => {
    expect(tryLoadUiTable("tests/fixtures/does-not-exist.json")).toBeNull();
    expect(t("L-83", "ENGLISH", {})).toBe("L-83");
  });
});

describe("the upstream JAPANESE → GREEK bug is not replicated", () => {
  test("JAPANESE never reads the GREEK column", () => {
    const table: UiTable = {
      "L-83": { ENGLISH: "Straight", JAPANESE: "", GREEK: "Ίσια" },
    };
    // Upstream would return "Ίσια"; we fall through to ENGLISH instead.
    expect(t("L-83", "JAPANESE", table)).toBe("Straight");
    expect(JAPANESE_GREEK_UPSTREAM_BUG.replicated).toBe(false);
    for (const lang of LANG_CODES) {
      // GREEK is the only column with a value; every other language must not pick it up.
      if (lang === "GREEK") {
        expect(t("L-83", lang, table)).toBe("Ίσια");
      } else {
        expect(t("L-83", lang, table)).not.toBe("Ίσια");
      }
    }
  });

  test("the CLI warns the operator about the fallback", () => {
    expect(japaneseFallbackNotice("JAPANESE")).toContain("JAPANESE → ENGLISH");
    expect(japaneseFallbackNotice("SPANISH")).toBeNull();
  });
});

describe("label rendering", () => {
  test("ENGLISH keeps the caller's literal text byte-for-byte", () => {
    expect(label("To Win", "ENGLISH")).toBe("To Win");
    // The ticket CLI's headline says "To win"; pinned default output must not change casing.
    expect(label("To win", "ENGLISH")).toBe("To win");
    expect(label("Stake", "ENGLISH")).toBe("Stake");
  });

  test("keys mode renders the verified L-key", () => {
    expect(label("Ticket", KEYS_MODE)).toBe("L-38");
    expect(label("Parlay", KEYS_MODE)).toBe("L-84");
    expect(label("Stake", KEYS_MODE)).toBe("Stake"); // no dedicated key
  });

  test("a sparse locale falls back to the English literal, never to an L-key", () => {
    expect(label("Parlay", "SPANISH")).toBe("Combinada");
    expect(label("Pregame", "SPANISH")).toBe("Pregame");
    expect(label("Stake", "SPANISH")).toBe("Stake");
  });
});

describe("argument and language helpers", () => {
  test("parseLangArg accepts the shipped codes and keys, case-insensitively", () => {
    expect(parseLangArg("spanish")).toBe("SPANISH");
    expect(parseLangArg("KEYS")).toBe(KEYS_MODE);
    expect(parseLangArg("klingon")).toBeNull();
    expect(languageList()).toContain("ENGLISH");
    expect(LANG_CODES).toHaveLength(8);
  });
});

describe("the shipped table (real Manager ui.json)", () => {
  const table = loadUiTable();

  test("loads the extracted table and caches it", () => {
    expect(table).toBe(loadUiTable());
    expect(Object.keys(table).length).toBe(1461);
    expect(DEFAULT_UI_TABLE_PATH).toBe("tests/fixtures/ui.json");
  });

  test("known L-keys resolve in several languages", () => {
    expect(t("L-83", "ENGLISH", table)).toBe("Straight");
    expect(t("L-84", "ENGLISH", table)).toBe("Parlay");
    expect(t("L-144", "SPANISH", table)).toBe("Totales");
    expect(t("L-213", "ENGLISH", table)).toBe("Customer");
    expect(t("L-1030", "ENGLISH", table)).toBe("Time (ET)");
    // Japanese has zero rows in this table; the chain must answer in ENGLISH.
    expect(t("L-83", "JAPANESE", table)).toBe("Straight");
  });

  test("every curated render key exists and is non-empty in ENGLISH", () => {
    for (const [english, key] of Object.entries(ENGLISH_LABEL_KEYS)) {
      const value = t(key, "ENGLISH", table);
      expect(value, `${english} -> ${key}`).not.toBe(key);
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  test("coverage reports the measured locale gaps and the VIETNAMES typo", () => {
    const result = coverage(table);
    expect(result.totalKeys).toBe(1461);
    expect(Object.keys(result.byLang).sort()).toEqual([...LANG_CODES].sort());
    expect(result.byLang.ENGLISH).toMatchObject({ present: 1461, missing: 0 });
    expect(result.byLang.SPANISH).toMatchObject({ present: 1422, missing: 39 });
    expect(result.byLang.CHINESE).toMatchObject({ present: 1460, missing: 1 });
    expect(result.byLang.FRENCH).toMatchObject({ present: 23 });
    expect(result.byLang.GREEK).toMatchObject({ present: 0, missing: 1461 });
    expect(result.byLang.JAPANESE).toMatchObject({ present: 0, missing: 1461 });
    expect(result.byLang.KOREAN).toMatchObject({ present: 402 });
    expect(result.byLang.VIETNAMESE).toMatchObject({ present: 438 });
    expect(result.unknownLanguageTags).toContain("VIETNAMES");
    expect(result.byLang.ENGLISH.missingKeys).toEqual([]);
  });
});
