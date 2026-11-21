import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AvatarImageError,
  buildAnsiTheme,
  detectImageProtocol,
  renderIterm2ImageFrameAsync,
  renderKittyImageFrameAsync,
  renderMarkdownWithAvatar,
} from "../src/lib/terminal_avatar.ts";

const onePixelPng = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("terminal avatar pipeline", () => {
  test("detects Kitty and iTerm2 environments", () => {
    expect(detectImageProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectImageProtocol({ TERM: "xterm-ghostty" })).toBe("kitty");
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectImageProtocol({ TERM: "xterm-256color" })).toBe("none");
  });

  test("builds chunked Kitty and sized iTerm2 frames", async () => {
    const kitty = await renderKittyImageFrameAsync(onePixelPng, {
      cols: 2,
      rows: 1,
    });
    expect(kitty.startsWith("\u001b_Ga=T,f=100,c=2,r=1,m=")).toBe(true);
    expect(kitty.endsWith("\u001b\\")).toBe(true);

    const iterm = await renderIterm2ImageFrameAsync(onePixelPng, {
      cols: 2,
      rows: 1,
      name: "avatar.png",
    });
    expect(iterm.startsWith("\u001b]1337;File=inline=1;size=")).toBe(true);
    expect(iterm).toContain(";width=2;height=1;preserveAspectRatio=1");
    expect(iterm.endsWith("\u0007")).toBe(true);
  });

  test("respects NO_COLOR and columns in AnsiTheme", () => {
    const plain = buildAnsiTheme({ columns: 40 }, { NO_COLOR: "1" }, true);
    expect(plain.colors).toBe(false);
    expect(plain.columns).toBe(40);
    const forced = buildAnsiTheme({ colors: true, columns: 0 }, {}, false);
    expect(forced.colors).toBe(true);
    expect(forced.columns).toBe(0);

    const forceOverridesNoColor = buildAnsiTheme(
      {},
      { NO_COLOR: "1", FORCE_COLOR: "1" },
      false,
    );
    expect(forceOverridesNoColor.colors).toBe(true);
    const forceZero = buildAnsiTheme({}, { FORCE_COLOR: "0" }, true);
    expect(forceZero.colors).toBe(false);
  });

  test("renders Markdown with a local-file Kitty image only", () => {
    const markdown = renderMarkdownWithAvatar("## Synced", {
      colors: false,
      columns: 0,
      avatarPath: "/tmp/avatar.png",
    });
    expect(markdown).toContain("Synced");
    expect(markdown).toContain("avatar");
  });
});

/**
 * `Bun.Image` is lazy, so a mislabelled file (an HTML error page saved as `.png`) only fails at
 * the terminal call — and with `ERR_IMAGE_UNKNOWN_FORMAT`, which a decode-only catch list misses.
 * The pipeline classifies those as `AvatarImageError` so a banner can skip the file, while a
 * programming error (a transferred buffer, `ERR_INVALID_STATE`) still propagates untouched.
 */
describe("avatar image failure classification", () => {
  test("a non-image body raises AvatarImageError with the Bun.Image code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-bad-"));
    try {
      const path = join(dir, "error-page.png");
      writeFileSync(path, "<!doctype html><title>session expired</title>");
      for (const render of [
        renderKittyImageFrameAsync,
        renderIterm2ImageFrameAsync,
      ]) {
        const error = await render(path).then(
          () => null,
          (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(AvatarImageError);
        expect((error as AvatarImageError).code).toBe(
          "ERR_IMAGE_UNKNOWN_FORMAT",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid image still renders", async () => {
    const frame = await renderIterm2ImageFrameAsync(onePixelPng, {
      cols: 1,
      rows: 1,
    });
    expect(frame.startsWith("\u001b]1337;File=")).toBe(true);
  });
});
