import { describe, expect, test } from "bun:test";
import { FIXTURE_LIVE_WAGERS } from "./fixtures/dashboard_ui_fixtures.ts";
import {
  formatShadowSliceRibbonLabel,
  NFL_1H_PREGAME_SLICE,
  parseActiveShadowSlice,
  shadowSliceHasTapeFocus,
  summarizeSliceWagers,
  wagerMatchesShadowSlice,
} from "../packages/ui/src/desk_quick_jump.ts";

describe("desk quick-jump shadow slice", () => {
  test("parseActiveShadowSlice reads NFL 1H pregame matrix deep link", () => {
    const slice = parseActiveShadowSlice(
      "matrix=1&sport=Football&subSport=NFL&period=1h&regime=pregame",
    );
    expect(slice.sport).toBe("Football");
    expect(slice.subSport).toBe("NFL");
    expect(slice.period).toBe("1h");
    expect(slice.regime).toBe("pregame");
    expect(shadowSliceHasTapeFocus(slice)).toBe(true);
    expect(formatShadowSliceRibbonLabel(slice)).toBe("NFL · 1H · Pregame");
  });

  test("wagerMatchesShadowSlice filters NFL live GSLIVE out of pregame slice", () => {
    const nflLive = FIXTURE_LIVE_WAGERS[0]!;
    expect(wagerMatchesShadowSlice(nflLive, NFL_1H_PREGAME_SLICE)).toBe(false);
  });

  test("summarizeSliceWagers returns zero when no rows match slice", () => {
    const stats = summarizeSliceWagers(
      FIXTURE_LIVE_WAGERS,
      NFL_1H_PREGAME_SLICE,
    );
    expect(stats.count).toBe(0);
    expect(stats.riskUsd).toBe(0);
  });
});
