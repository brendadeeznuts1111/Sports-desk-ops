import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startThemePreviewServer } from "../src/preview-server.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

describe("theme preview server", () => {
  test("serves theme.json and avatar files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-"));
    dirs.push(dir);
    writeFileSync(join(dir, "avatar.png"), png);
    const server = startThemePreviewServer({
      port: 0,
      avatarsDir: dir,
      lut: {
        alpha: {
          colorLabel: "amber",
          colorCss: "#f59e0b",
          colorInt: 0xf59e0b,
          colorHex: "#f59e0b",
          ansi16m: "\u001b[38;2;245;158;11m",
        },
      },
    });
    try {
      const theme = await fetch(
        "http://localhost:" + server.port + "/theme.json",
      );
      expect(theme.status).toBe(200);
      expect(await theme.json()).toEqual({
        alpha: {
          colorLabel: "amber",
          colorCss: "#f59e0b",
          colorInt: 0xf59e0b,
          colorHex: "#f59e0b",
          ansi16m: "\u001b[38;2;245;158;11m",
        },
      });
      const avatar = await fetch(
        "http://localhost:" + server.port + "/avatars/avatar.png",
      );
      expect(avatar.status).toBe(200);
      expect(avatar.headers.get("content-type")).toBe("image/png");
    } finally {
      server.stop(true);
    }
  });
});
