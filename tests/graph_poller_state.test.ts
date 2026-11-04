/**
 * The portal banner used to restamp "Last Updated" with the page's own clock whenever the feed
 * fetch threw, so an outage read as "0s ago" under a green "LIVE POLLER ACTIVE". These tests run
 * the real docs/graph.js against a stubbed DOM and pin what the banner shows instead.
 */
import { describe, expect, test } from "bun:test";

class FakeEl {
  attrs: Record<string, string> = {};
  textContent = "";
  className = "";
  title = "";
  id = "";
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  focused = false;
  private listeners = new Map<string, ((event?: unknown) => void)[]>();
  getAttribute(key: string) {
    return this.attrs[key] ?? null;
  }
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
  }
  removeAttribute(key: string) {
    delete this.attrs[key];
  }
  focus() {
    this.focused = true;
  }
  addEventListener(type: string, handler: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  fire(type: string, event?: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

type Fetch = () => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

const ids = [
  "live-poller-state",
  "live-poller-dot",
  "live-status-announce",
  "live-last-updated-ts",
  "live-last-updated-age",
  "poll-now-btn",
] as const;

let instance = 0;

/** Load a fresh copy of graph.js (the query string defeats the module cache). */
async function mount(
  fetchImpl: Fetch,
  selectors: Record<string, FakeEl[]> = {},
) {
  const els = Object.fromEntries(ids.map((id) => [id, new FakeEl()])) as Record<
    (typeof ids)[number],
    FakeEl
  >;
  els["live-last-updated-ts"].textContent = "— awaiting live feed —";
  els["live-last-updated-age"].textContent = "—";

  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: g.document,
    fetch: g.fetch,
    setInterval: g.setInterval,
  };
  g.document = {
    querySelectorAll: (selector: string) => selectors[selector] ?? [],
    getElementById: (id: string) => (els as Record<string, FakeEl>)[id] ?? null,
  };
  let currentFetch = fetchImpl;
  g.fetch = () => currentFetch();
  g.setInterval = () => 0;

  const specifier = `../docs/graph.js?poller-state=${++instance}`;
  await import(specifier);
  const settle = () => Bun.sleep(20);
  await settle();

  return {
    els,
    /** Make the next poll use `next`, click "Poll & Refresh Now", and wait for it to settle. */
    async pollAgain(next: Fetch) {
      currentFetch = next;
      els["poll-now-btn"].fire("click");
      await settle();
    },
    restore() {
      g.document = saved.document;
      g.fetch = saved.fetch;
      g.setInterval = saved.setInterval;
    },
  };
}

const feedAt = (ageMs: number) => {
  const publishedMs = Date.now() - ageMs;
  return {
    lastUpdatedCdt: "11/04/2026, 05:44:39 CST",
    lastUpdatedIso: new Date(publishedMs).toISOString(),
    pollEpochMs: publishedMs,
    pollSequence: 3,
    walletProfiles: [],
  };
};
const ok =
  (body: unknown): Fetch =>
  async () => ({ ok: true, json: async () => body });
const httpError =
  (status: number): Fetch =>
  async () => ({ ok: false, status, json: async () => ({}) });
const networkError: Fetch = async () => {
  throw new TypeError("fetch failed");
};

describe("portal banner feed state (graph.js)", () => {
  test("a network failure is reported, and does not restamp the clock", async () => {
    const page = await mount(networkError);
    try {
      const { els } = page;
      expect(els["live-poller-state"].textContent).toBe("FEED FETCH FAILED");
      expect(els["live-poller-state"].title).toContain("network error");
      expect(els["live-poller-dot"].className).toBe("pulse-dot pulse-dot-rose");
      expect(els["live-last-updated-age"].className).toBe("pill pill-rose");
      // the old code wrote the page's own time here and "0s ago" below
      expect(els["live-last-updated-ts"].textContent).toBe(
        "— awaiting live feed —",
      );
      expect(els["live-last-updated-age"].textContent).toBe("—");
      expect(els["live-status-announce"].textContent).toContain(
        "FEED FETCH FAILED",
      );
    } finally {
      page.restore();
    }
  });

  test("a non-OK response is reported instead of silently ignored", async () => {
    const page = await mount(httpError(503));
    try {
      expect(page.els["live-poller-state"].textContent).toBe(
        "FEED FETCH FAILED",
      );
      expect(page.els["live-poller-state"].title).toContain("HTTP 503");
    } finally {
      page.restore();
    }
  });

  test("an old feed shows its real age, never LIVE or fresh", async () => {
    const page = await mount(ok(feedAt(3 * 3_600_000)));
    try {
      const { els } = page;
      expect(els["live-last-updated-age"].textContent).toBe("3h ago");
      expect(els["live-poller-state"].textContent).toBe("SNAPSHOT");
      expect(els["live-poller-dot"].className).toBe(
        "pulse-dot pulse-dot-amber",
      );
      expect(els["live-last-updated-ts"].textContent).toContain("11/04/2026");
    } finally {
      page.restore();
    }
  });

  test("a fresh feed reads as polling", async () => {
    const page = await mount(ok(feedAt(5_000)));
    try {
      expect(page.els["live-poller-state"].textContent).toBe("POLL 15s");
      expect(page.els["live-poller-dot"].className).toBe(
        "pulse-dot pulse-dot-emerald",
      );
      expect(page.els["live-last-updated-age"].textContent).toMatch(
        /^\ds ago$/,
      );
    } finally {
      page.restore();
    }
  });

  test("a feed with no publish time is undated, not fresh", async () => {
    const { pollEpochMs: _drop, lastUpdatedIso: _iso, ...undated } = feedAt(0);
    const page = await mount(ok({ ...undated, lastUpdatedIso: "not a date" }));
    try {
      expect(page.els["live-poller-state"].textContent).toBe("FEED UNDATED");
      expect(page.els["live-last-updated-age"].textContent).toBe("—");
    } finally {
      page.restore();
    }
  });

  test("success, then a failing poll: the last good age keeps counting", async () => {
    const page = await mount(ok(feedAt(20 * 60_000)));
    try {
      const { els } = page;
      expect(els["live-last-updated-age"].textContent).toBe("20m ago");
      const stamp = els["live-last-updated-ts"].textContent;

      await page.pollAgain(networkError);

      expect(els["live-poller-state"].textContent).toBe("FEED FETCH FAILED");
      expect(els["live-poller-state"].title).toContain(
        "showing the last good feed (20m old)",
      );
      expect(els["live-last-updated-age"].textContent).toBe("20m ago");
      expect(els["live-last-updated-ts"].textContent).toBe(stamp);

      await page.pollAgain(ok(feedAt(2_000)));
      expect(els["live-poller-state"].textContent).toBe("POLL 15s");
    } finally {
      page.restore();
    }
  });

  test("the live region is told about state changes, not about every tick", async () => {
    const page = await mount(ok(feedAt(5_000)));
    try {
      const { els } = page;
      const first = els["live-status-announce"].textContent;
      expect(first).toContain("POLL 15s");
      await page.pollAgain(ok(feedAt(4_000)));
      expect(els["live-status-announce"].textContent).toBe(first);
      await page.pollAgain(httpError(500));
      expect(els["live-status-announce"].textContent).toContain(
        "FEED FETCH FAILED",
      );
    } finally {
      page.restore();
    }
  });
});

describe("tab groups (graph.js wireTabs)", () => {
  const keydown = (key: string) => {
    const event = {
      key,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    return event;
  };

  async function mountTabs() {
    const buttons = ["A", "B", "C"].map((key, index) => {
      const el = new FakeEl();
      el.attrs["data-tab-target"] = key;
      el.attrs["aria-selected"] = index === 0 ? "true" : "false";
      return el;
    });
    const panels = ["A", "B", "C"].map((key, index) => {
      const el = new FakeEl();
      el.attrs["data-tab-panel"] = key;
      if (index !== 0) el.attrs.hidden = "";
      return el;
    });
    const page = await mount(ok(feedAt(1_000)), {
      "[data-tab-target]": buttons,
      "[data-tab-panel]": panels,
    });
    return { page, buttons, panels };
  }

  test("pairs each tab with its panel and puts only the selected tab in the Tab order", async () => {
    const { page, buttons, panels } = await mountTabs();
    try {
      expect(buttons.map((b) => b.attrs.tabindex)).toEqual(["0", "-1", "-1"]);
      for (const [i, button] of buttons.entries()) {
        const panel = panels[i] as FakeEl;
        expect(panel.attrs.role).toBe("tabpanel");
        expect(button.attrs["aria-controls"]).toBe(panel.id);
        expect(panel.attrs["aria-labelledby"]).toBe(button.id);
        expect(button.id).not.toBe("");
      }
    } finally {
      page.restore();
    }
  });

  test("ArrowRight selects and focuses the next tab and swaps the visible panel", async () => {
    const { page, buttons, panels } = await mountTabs();
    try {
      const event = keydown("ArrowRight");
      (buttons[0] as FakeEl).fire("keydown", event);
      expect(event.defaultPrevented).toBe(true);
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "false",
        "true",
        "false",
      ]);
      expect(buttons.map((b) => b.attrs.tabindex)).toEqual(["-1", "0", "-1"]);
      expect((buttons[1] as FakeEl).focused).toBe(true);
      expect(panels.map((p) => "hidden" in p.attrs)).toEqual([
        true,
        false,
        true,
      ]);
    } finally {
      page.restore();
    }
  });

  test("ArrowLeft wraps to the last tab; End and Home jump", async () => {
    const { page, buttons } = await mountTabs();
    try {
      (buttons[0] as FakeEl).fire("keydown", keydown("ArrowLeft"));
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "false",
        "false",
        "true",
      ]);
      (buttons[2] as FakeEl).fire("keydown", keydown("Home"));
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "true",
        "false",
        "false",
      ]);
      (buttons[0] as FakeEl).fire("keydown", keydown("End"));
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "false",
        "false",
        "true",
      ]);
    } finally {
      page.restore();
    }
  });

  test("keys that are not navigation keys are not swallowed", async () => {
    const { page, buttons } = await mountTabs();
    try {
      for (const key of ["Enter", "Tab", " ", "a"]) {
        const event = keydown(key);
        (buttons[0] as FakeEl).fire("keydown", event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "true",
        "false",
        "false",
      ]);
    } finally {
      page.restore();
    }
  });

  test("a click still selects without stealing focus", async () => {
    const { page, buttons, panels } = await mountTabs();
    try {
      (buttons[2] as FakeEl).fire("click");
      expect(buttons.map((b) => b.attrs["aria-selected"])).toEqual([
        "false",
        "false",
        "true",
      ]);
      expect(buttons.every((b) => !b.focused)).toBe(true);
      expect(panels.map((p) => "hidden" in p.attrs)).toEqual([
        true,
        true,
        false,
      ]);
    } finally {
      page.restore();
    }
  });
});
