/**
 * The daemon's CLI entrypoint must not read `bridgeWebsocket` during module evaluation.
 *
 * `startServer` builds `Bun.serve({ websocket: bridgeWebsocket, ... })`, and
 * `bridgeWebsocket` is a module-level const declared after the entrypoint's position.
 * When the entrypoint ran inline, the documented command
 * (`bun run services/sportsdesk_webview_server.ts`) threw
 * `ReferenceError: Cannot access 'bridgeWebsocket' before initialization` and never
 * listened — so nothing could reach the live bridge hub. Tests that import `startServer`
 * never caught it because module evaluation had already completed by then.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dirname, "..", "services", "sportsdesk_webview_server.ts"),
  "utf8",
);

describe("daemon CLI entrypoint evaluation", () => {
  test("the entrypoint defers past module evaluation", () => {
    const mainIndex = SOURCE.indexOf("if (import.meta.main)");
    expect(mainIndex).toBeGreaterThan(-1);

    // The entrypoint must schedule startServer rather than call it inline: either a
    // queueMicrotask/setTimeout wrapper or a call placed after the hub const.
    const window = SOURCE.slice(mainIndex, mainIndex + 400);
    expect(window).toContain("queueMicrotask");
    expect(window).toContain("startServer(");

    const hubIndex = SOURCE.indexOf("export const bridgeWebsocket = {");
    expect(hubIndex).toBeGreaterThan(-1);
  });

  test("the hub const is not initialized before the deferred entrypoint body", () => {
    // A deferral is only correct because the const is initialized by the time the
    // microtask runs. Pinning the declaration's existence after the entrypoint keeps a
    // future refactor from deleting it or moving startServer's dependency earlier.
    const hubIndex = SOURCE.indexOf("export const bridgeWebsocket = {");
    const mainIndex = SOURCE.indexOf("if (import.meta.main)");
    expect(hubIndex).toBeGreaterThan(mainIndex);
  });
});
