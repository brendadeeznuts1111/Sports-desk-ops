import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static checks on the scoreboard page. There is no DOM in `bun:test`, so these assert the
 * wiring a browser depends on: parseable inline script, required element ids, the combobox
 * contract, and the API surfaces the page calls. Behavioural clicking is verified by hand.
 */
describe("static/live-bets.html", () => {
  const html = readFileSync(
    resolve(import.meta.dir, "../static/live-bets.html"),
    "utf8",
  );

  const script = (() => {
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (match?.[1] === undefined) throw new Error("no inline script block");
    return match[1];
  })();

  test("inline script parses", () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script.length).toBeGreaterThan(5_000);
  });

  test("never assigns innerHTML", () => {
    expect(html).not.toContain("innerHTML");
  });

  test("declares the element ids the script looks up", () => {
    for (const id of [
      "agent-scope",
      "tree-toggle",
      "f-all",
      "f-league",
      "f-money",
      "q",
      "tree",
      "tree-body",
      "tree-meta",
      "tree-q",
      "tree-collapse",
      "totals",
      "t-games",
      "t-wagered",
      "t-towin",
      "t-pending",
      "scope-bar",
      "scope-text",
      "scope-clear",
      "source",
      "count",
      "refresh",
      "games",
      "sports",
      "acct-results",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("exposes the account search as an accessible combobox", () => {
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="acct-results"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="listbox"');
    expect(script).toContain('setAttribute("aria-expanded"');
    expect(script).toContain("ArrowDown");
    expect(script).toContain("ArrowUp");
  });

  test("calls only endpoints the server serves, over same-origin paths", () => {
    const endpoints = [...script.matchAll(/fetch\("([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint?.startsWith("/api/")).toBe(true);
    }
    for (const path of ["/api/live-bets", "/api/agent-tree"]) {
      expect(script).toContain(path);
    }
    expect(script).toContain("/api/logo/");
  });

  test("labels the account search scope honestly", () => {
    // The page cannot search the portal's full player list, so it must say so in the source.
    expect(script).toContain("captured customer");
    expect(script).toContain("No agent or captured customer matches.");
  });

  test("polls only while visible and never caches the snapshot", () => {
    expect(script).toContain('document.visibilityState === "visible"');
    expect(script).toContain('cache: "no-store"');
  });
});
