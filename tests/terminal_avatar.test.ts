import { describe, expect, test } from "bun:test";
import {
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
