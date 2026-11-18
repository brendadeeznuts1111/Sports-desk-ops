import { afterEach, describe, expect, test } from "bun:test";
import {
  getShadowSliceSnapshot,
  parseActiveShadowSlice,
} from "../packages/ui/src/desk_quick_jump.ts";

function setLocationSearch(search: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { search } },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("desk_quick_jump · slice parsing", () => {
  test("accepts the deep-link slice from the URL", () => {
    const slice = parseActiveShadowSlice(
      "?sport=Football&subSport=NFL&period=1h&regime=pregame",
    );
    expect(slice.sport).toBe("Football");
    expect(slice.subSport).toBe("NFL");
    expect(slice.period).toBe("1h");
    expect(slice.market).toBe("ALL");
    expect(slice.regime).toBe("pregame");
  });

  test("normalizes unknown codes and ALL to the empty slice", () => {
    const slice = parseActiveShadowSlice(
      "?sport=Mars&subSport=NFL&period=99z&regime=halftime",
    );
    expect(slice.sport).toBe("ALL");
    expect(slice.subSport).toBe("NFL");
    expect(slice.period).toBe("ALL");
    expect(slice.regime).toBe("ALL");
  });

  test("a missing search string is the empty slice", () => {
    expect(parseActiveShadowSlice("")).toEqual(parseActiveShadowSlice("?"));
  });
});

describe("desk_quick_jump · useSyncExternalStore snapshot", () => {
  test("returns a stable reference while the URL search is unchanged", () => {
    setLocationSearch("?sport=Football&subSport=NFL&period=1h&regime=pregame");
    const first = getShadowSliceSnapshot();
    const second = getShadowSliceSnapshot();
    // A fresh object per call makes React loop until "Maximum update depth exceeded".
    expect(second).toBe(first);
    expect(first.subSport).toBe("NFL");
  });

  test("rebuilds the snapshot when the URL slice changes", () => {
    setLocationSearch("?sport=Football");
    const football = getShadowSliceSnapshot();
    setLocationSearch("?sport=Basketball&period=game");
    const basketball = getShadowSliceSnapshot();
    expect(basketball).not.toBe(football);
    expect(basketball.sport).toBe("Basketball");
    expect(basketball.period).toBe("game");
  });

  test("returns the empty slice outside a browser", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(getShadowSliceSnapshot().sport).toBe("ALL");
  });
});
