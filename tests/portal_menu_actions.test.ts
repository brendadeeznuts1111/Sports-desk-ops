import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The portal's left menu, as pasted by an operator.
 *
 * This exists because the ledger asserted `data-action="get-weekly-figure"` appeared in "no capture,
 * test or code artifact in either tree". The paste disproved that, so the string is now pinned to an
 * artifact: if someone deletes the fixture, the claim has nowhere to stand.
 */
const fixture = readFileSync(
  resolve(import.meta.dir, "fixtures/portal-left-menu-actions.html"),
  "utf8",
);

/**
 * The element only — the fixture's own header comment names the action and the words a credential
 * scan looks for, so scanning the whole file would be checking prose instead of markup.
 */
const element = (() => {
  const start = fixture.indexOf("<ul");
  const end = fixture.lastIndexOf("</ul>");
  if (start === -1 || end === -1)
    throw new Error("fixture has no <ul> element");
  return fixture.slice(start, end + "</ul>".length);
})();

/** `data-action="get-pending"` → `get-pending`, in document order. */
const actions = [...element.matchAll(/data-action="([^"]+)"/g)].map(
  (match) => match[1] as string,
);

describe("portal left menu markup", () => {
  test("carries the six nav actions the paste showed", () => {
    expect(actions).toEqual([
      "go-home-menu",
      "get-weekly-figure",
      "get-pending",
      "get-game-admin",
      "get-messaging",
      "show-search-mobile-icons",
    ]);
  });

  test("get-weekly-figure is a real action string", () => {
    // The specific claim the ledger used to make: it is present, and it is marked heavy.
    expect(actions).toContain("get-weekly-figure");
    expect(element).toContain(
      'data-action="get-weekly-figure" data-type="heavy"',
    );
  });

  test("the actions the server implements are among them", () => {
    // get-pending and get-game-admin are the two the daemon serves; they are not invented names.
    expect(actions).toContain("get-pending");
    expect(actions).toContain("get-game-admin");
  });

  test("records no credential material", () => {
    // Nav markup is committable precisely because it carries none of this.
    for (const forbidden of [
      "Authorization",
      "Bearer",
      "Cookie",
      "password",
      "Set-Cookie",
    ]) {
      expect(element).not.toContain(forbidden);
    }
  });
});
