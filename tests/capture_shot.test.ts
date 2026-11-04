import { describe, expect, test } from "bun:test";

import {
  captureShotFile,
  describeShotError,
  withView,
  type ShotFileRequest,
  type ShotFileView,
} from "../scripts/capture/shot.ts";
import { WebViewError } from "../scripts/capture/webview.ts";

const REQUEST: ShotFileRequest = {
  url: "https://example.com",
  out: "/tmp/never-written.png",
  width: 1440,
  height: 900,
  backend: "webkit",
  format: "png",
  encoding: "blob",
  quality: 82,
  resize: null,
  waitSelector: null,
  waitMs: 0,
  timeoutMs: 20_000,
  retries: 0,
  f402Login: false,
  f402Page: "/",
  profile: null,
  thumb: null,
  placeholder: false,
  console: false,
  cookies: false,
};

/** A view whose screenshot settles late and whose disposal is recorded. */
function slowView(events: string[], label = "") {
  const view: ShotFileView & AsyncDisposable = {
    async evaluate(script: string) {
      return script === "document.title" ? "Example" : "https://example.com/";
    },
    async screenshotToFile(path: string) {
      events.push(`${label}shot-start`);
      await Bun.sleep(10);
      events.push(`${label}shot-done`);
      return { path, bytes: 1, sha256: "00", mimeType: "image/png" };
    },
    consoleLog: [],
    async getAllCookies() {
      return [];
    },
    async [Symbol.asyncDispose]() {
      events.push(`${label}dispose`);
    },
  };
  return view;
}

describe("withView", () => {
  test("disposes the view only after the capture settles", async () => {
    const events: string[] = [];
    const result = await withView(
      async () => slowView(events),
      (view) => captureShotFile(view, REQUEST),
    );
    expect(result.screenshot).toBe("/tmp/never-written.png");
    expect(events).toEqual(["shot-start", "shot-done", "dispose"]);
  });

  test("runs one view at a time, in call order", async () => {
    const events: string[] = [];
    await Promise.all([
      withView(
        async () => slowView(events, "a:"),
        (view) => captureShotFile(view, REQUEST),
      ),
      withView(
        async () => slowView(events, "b:"),
        (view) => captureShotFile(view, REQUEST),
      ),
    ]);
    expect(events).toEqual([
      "a:shot-start",
      "a:shot-done",
      "a:dispose",
      "b:shot-start",
      "b:shot-done",
      "b:dispose",
    ]);
  });

  test("a failed capture still disposes, and does not block the next one", async () => {
    const events: string[] = [];
    const failed = withView(
      async () => slowView(events, "a:"),
      () => Promise.reject(new WebViewError("screenshot-failed", "boom")),
    );
    const next = withView(
      async () => slowView(events, "b:"),
      (view) => captureShotFile(view, REQUEST),
    );
    await expect(failed).rejects.toThrow("boom");
    await next;
    expect(events).toEqual([
      "a:dispose",
      "b:shot-start",
      "b:shot-done",
      "b:dispose",
    ]);
  });
});

describe("describeShotError", () => {
  test("code, reason and the next step on one line", () => {
    expect(
      describeShotError(
        new WebViewError("selector-timeout", "#app never appeared in 20000ms"),
      ),
    ).toBe(
      "selector-timeout: #app never appeared in 20000ms. Next: the selector never matched: check it against the page, or raise the timeout",
    );
  });
});
