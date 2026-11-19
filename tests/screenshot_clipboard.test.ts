import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendScreenshotManifestEntry,
  emptyScreenshotManifest,
  ERR_SCREENSHOT_CLIPBOARD_EMPTY,
  mimeForScreenFormat,
  optimizeScreenshot,
  parseScreenshotManifest,
  publicUrlFor,
  readClipboardImage,
  readScreenshotManifest,
  ScreenshotError,
  screenshotObjectKey,
  targetDimensions,
  writeScreenshotManifest,
  type ClipboardImageApi,
  type ScreenshotManifestEntry,
} from "../lib/screenshot_clipboard.ts";
import {
  captureOnce,
  parseScreenshotArgs,
  type CaptureDeps,
  type ScreenshotCliOptions,
} from "../cli/sportsdesk_screenshot_cli.ts";

/** 1×1 PNG: decodes on every platform and keeps the encoder cases fast. */
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const SHA = "ab".repeat(32);

function scratch(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "shot-clip-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(
  overrides: Partial<ScreenshotManifestEntry> = {},
): ScreenshotManifestEntry {
  return {
    sha256: SHA,
    key: "screenies/2026/11/19/abababababab.webp",
    publicUrl: null,
    bytes: 96,
    width: 1,
    height: 1,
    format: "webp",
    quality: 78,
    maxEdge: 1600,
    sourceBytes: 70,
    sourceFormat: "png",
    sourceWidth: 1,
    sourceHeight: 1,
    capturedAt: "2026-11-19T12:00:00.000Z",
    clipboardChangeCount: null,
    ...overrides,
  };
}

describe("targetDimensions", () => {
  test("never upscales and preserves the aspect ratio", () => {
    expect(targetDimensions(1600, 920, 1600)).toEqual({
      width: 1600,
      height: 920,
    });
    expect(targetDimensions(1600, 920, 800)).toEqual({
      width: 800,
      height: 460,
    });
    expect(targetDimensions(900, 1600, 800)).toEqual({
      width: 450,
      height: 800,
    });
    expect(targetDimensions(1, 1, 1600)).toEqual({ width: 1, height: 1 });
  });

  test("refuses inputs that would encode to nothing", () => {
    expect(() => targetDimensions(0, 10, 100)).toThrow(ScreenshotError);
    expect(() => targetDimensions(10, 10, 0)).toThrow(ScreenshotError);
  });
});

describe("object keys and URLs", () => {
  const at = new Date("2026-11-19T12:34:56.000Z");

  test("dated, content-addressed, extension follows the format", () => {
    expect(screenshotObjectKey(SHA, "webp", at)).toBe(
      `screenies/2026/11/19/${SHA.slice(0, 12)}.webp`,
    );
    expect(screenshotObjectKey(SHA, "jpeg", at)).toEndWith(".jpg");
    expect(screenshotObjectKey(SHA, "png", at, "/shots/")).toBe(
      `shots/2026/11/19/${SHA.slice(0, 12)}.png`,
    );
  });

  test("a key needs a real digest", () => {
    expect(() => screenshotObjectKey("not-a-digest", "webp", at)).toThrow(
      ScreenshotError,
    );
  });

  test("public URLs join without doubling the slash", () => {
    expect(publicUrlFor("https://cdn.example/", "a/b.webp")).toBe(
      "https://cdn.example/a/b.webp",
    );
    expect(publicUrlFor("", "a/b.webp")).toBe("a/b.webp");
  });

  test("each format has a MIME type", () => {
    expect(mimeForScreenFormat("webp")).toBe("image/webp");
    expect(mimeForScreenFormat("png")).toBe("image/png");
    expect(mimeForScreenFormat("jpeg")).toBe("image/jpeg");
  });
});

describe("screenshot manifest", () => {
  test("appends newest-first and keeps one row per digest", () => {
    const first = appendScreenshotManifestEntry(
      emptyScreenshotManifest(),
      entry(),
    );
    expect(first.replaced).toBe(false);
    expect(first.manifest.entries).toHaveLength(1);

    const other = entry({ sha256: "cd".repeat(32), key: "screenies/x.webp" });
    const second = appendScreenshotManifestEntry(first.manifest, other);
    expect(second.manifest.entries[0]?.sha256).toBe("cd".repeat(32));
    expect(second.manifest.entries).toHaveLength(2);

    const again = appendScreenshotManifestEntry(second.manifest, entry());
    expect(again.replaced).toBe(true);
    expect(again.manifest.entries).toHaveLength(2);
  });

  test("a different version reads as null, not a half-match", () => {
    expect(parseScreenshotManifest({ version: 99, entries: [] })).toBeNull();
    expect(parseScreenshotManifest({ entries: [] })).toBeNull();
    expect(parseScreenshotManifest({ version: 1, entries: [] })).not.toBeNull();
  });

  test("a missing manifest reads as empty; a written one round-trips", async () => {
    const { dir, cleanup } = scratch();
    try {
      const manifestPath = path.join(dir, "m.json");
      expect((await readScreenshotManifest(manifestPath)).entries).toEqual([]);
      await writeScreenshotManifest(
        manifestPath,
        appendScreenshotManifestEntry(emptyScreenshotManifest(), entry())
          .manifest,
      );
      const readBack = await readScreenshotManifest(manifestPath);
      expect(readBack.entries).toHaveLength(1);
      expect(readBack.entries[0]?.key).toContain("screenies/");
    } finally {
      cleanup();
    }
  });
});

describe("clipboard adapter", () => {
  const image = { blob: async () => new Blob([TINY_PNG]) };

  test("an empty clipboard is its own error, not a decode failure", () => {
    const api: ClipboardImageApi = {
      hasClipboardImage: () => false,
      clipboardChangeCount: () => 1,
      fromClipboard: () => null,
    };
    try {
      readClipboardImage(api);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotError);
      expect((error as ScreenshotError).code).toBe(
        ERR_SCREENSHOT_CLIPBOARD_EMPTY,
      );
    }
  });

  test("hasClipboardImage() true but no image is still reported, not silently skipped", () => {
    const api: ClipboardImageApi = {
      hasClipboardImage: () => true,
      clipboardChangeCount: () => 2,
      fromClipboard: () => null,
    };
    expect(() => readClipboardImage(api)).toThrow(ScreenshotError);
  });

  test("returns the image when the clipboard holds one", () => {
    const api: ClipboardImageApi = {
      hasClipboardImage: () => true,
      clipboardChangeCount: () => 3,
      fromClipboard: () => image,
    };
    expect(readClipboardImage(api)).toBe(image);
  });

  test("an object without blob() is refused rather than cast to Blob", () => {
    const api: ClipboardImageApi = {
      hasClipboardImage: () => true,
      clipboardChangeCount: () => 4,
      fromClipboard: () => ({}),
    };
    expect(() => readClipboardImage(api)).toThrow(ScreenshotError);
  });
});

describe("optimizeScreenshot", () => {
  test("encodes webp and reports the source facts it actually saw", async () => {
    const out = await optimizeScreenshot(new Blob([TINY_PNG]), {
      maxEdge: 1600,
      quality: 78,
      format: "webp",
    });
    expect(String.fromCharCode(...out.bytes.slice(0, 4))).toBe("RIFF");
    expect(out.format).toBe("webp");
    expect(out.mime).toBe("image/webp");
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(out.source).toEqual({
      width: 1,
      height: 1,
      format: "png",
      bytes: TINY_PNG.length,
    });
  });

  test("an empty source is refused with a named error", async () => {
    await expect(
      optimizeScreenshot(new Blob([]), {
        maxEdge: 100,
        quality: 78,
        format: "webp",
      }),
    ).rejects.toThrow(ScreenshotError);
  });
});

describe("parseScreenshotArgs", () => {
  const parsed = (argv: readonly string[]): ScreenshotCliOptions => {
    const result = parseScreenshotArgs(argv);
    if (!result.ok) throw new Error(result.message);
    return result.options;
  };

  test("defaults are the publish defaults", () => {
    const options = parsed([]);
    expect(options.format).toBe("webp");
    expect(options.maxEdge).toBe(1600);
    expect(options.quality).toBe(78);
    expect(options.prefix).toBe("screenies");
    expect(options.manifest).toContain("screenshot-manifest.json");
    expect(options.dryRun).toBe(false);
    expect(options.watch).toBe(false);
  });

  test("rejects an unknown flag, a bad format, and an out-of-range quality", () => {
    expect(parseScreenshotArgs(["--nope"])).toMatchObject({ ok: false });
    const badFormat = parseScreenshotArgs(["--format", "avif"]);
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) expect(badFormat.message).toContain("webp, png, jpeg");
    const badQuality = parseScreenshotArgs(["--quality", "101"]);
    expect(badQuality.ok).toBe(false);
  });

  test("accepts the documented invocation forms", () => {
    expect(parsed(["--file", "a.png", "--dry-run", "--json"]).dryRun).toBe(
      true,
    );
    expect(parsed(["--watch", "--interval", "800"]).intervalMs).toBe(800);
    expect(parsed(["--max-edge", "640", "--format", "png"]).maxEdge).toBe(640);
  });
});

describe("captureOnce with an injected uploader", () => {
  const baseOptions = (overrides: Partial<ScreenshotCliOptions>) =>
    ({ ...parseOptions([]), ...overrides }) as ScreenshotCliOptions;

  function parseOptions(argv: readonly string[]): ScreenshotCliOptions {
    const result = parseScreenshotArgs(argv);
    if (!result.ok) throw new Error(result.message);
    return result.options;
  }

  test("dry-run writes neither an object nor a manifest", async () => {
    const { dir, cleanup } = scratch();
    try {
      const pngPath = path.join(dir, "shot.png");
      await Bun.write(pngPath, TINY_PNG);
      const manifestPath = path.join(dir, "manifest.json");
      const summary = await captureOnce(
        baseOptions({
          file: pngPath,
          manifest: manifestPath,
          dryRun: true,
        }),
        null,
        {
          resolveUploader: () => {
            throw new Error("dry-run must not resolve an uploader");
          },
        },
      );
      expect(summary.status).toBe("dry-run");
      expect(existsSync(manifestPath)).toBe(false);
      expect(summary.publicUrl).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("uploads once, then reports already-present for the same pixels", async () => {
    const { dir, cleanup } = scratch();
    try {
      const pngPath = path.join(dir, "shot.png");
      await Bun.write(pngPath, TINY_PNG);
      const manifestPath = path.join(dir, "manifest.json");
      const puts: string[] = [];
      const deps: CaptureDeps = {
        resolveUploader: async () => ({
          publicBase: "https://cdn.example",
          put: async (key, bytes) => {
            puts.push(key);
            return bytes.length;
          },
        }),
      };
      const options = baseOptions({ file: pngPath, manifest: manifestPath });

      const first = await captureOnce(options, 7, deps);
      expect(first.status).toBe("uploaded");
      expect(first.publicUrl).toStartWith("https://cdn.example/screenies/");
      expect(puts).toHaveLength(1);

      const manifest = await readScreenshotManifest(manifestPath);
      expect(manifest.entries).toHaveLength(1);
      const row = manifest.entries[0];
      expect(row?.sourceWidth).toBe(1);
      expect(row?.sourceFormat).toBe("png");
      expect(row?.clipboardChangeCount).toBe(7);
      expect(row?.sha256).toBe(first.sha256);

      const second = await captureOnce(options, 7, deps);
      expect(second.status).toBe("already-present");
      expect(puts).toHaveLength(1);
      expect((await readScreenshotManifest(manifestPath)).entries).toHaveLength(
        1,
      );
    } finally {
      cleanup();
    }
  });

  test("no credentials fails closed instead of reporting a local success", async () => {
    const { dir, cleanup } = scratch();
    try {
      const pngPath = path.join(dir, "shot.png");
      await Bun.write(pngPath, TINY_PNG);
      await expect(
        captureOnce(
          baseOptions({
            file: pngPath,
            manifest: path.join(dir, "m.json"),
          }),
          null,
          { resolveUploader: async () => null },
        ),
      ).rejects.toMatchObject({ code: "ERR_SCREENSHOT_CREDENTIALS" });
    } finally {
      cleanup();
    }
  });
});

describe("shot-clip CLI surface", () => {
  const SCRIPT = path.join(
    import.meta.dir,
    "..",
    "cli",
    "sportsdesk_screenshot_cli.ts",
  );

  function run(
    argv: readonly string[],
    env: Record<string, string> = {},
  ): { readonly code: number; readonly out: string; readonly err: string } {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, NO_COLOR: "1", ...env },
    });
    return {
      code: proc.exitCode ?? -1,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    };
  }

  test("--help carries the flags and runnable examples", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--max-edge");
    expect(result.out).toContain("Examples:");
    expect(result.out).toContain("./bin/dx shot-clip --dry-run --json");
    expect(result.out).toContain("Exit codes:");
  });

  test("an unknown flag exits 2 with a corrective command", () => {
    const result = run(["--nope"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("./bin/dx shot-clip --help");
  });

  test("--file + --dry-run --json is machine-readable and writes nothing", async () => {
    const { dir, cleanup } = scratch();
    try {
      const pngPath = path.join(dir, "shot.png");
      const manifestPath = path.join(dir, "never.json");
      await Bun.write(pngPath, TINY_PNG);
      const result = run([
        "--file",
        pngPath,
        "--dry-run",
        "--json",
        "--manifest",
        manifestPath,
      ]);
      expect(result.code).toBe(0);
      const summary = JSON.parse(result.out.trim()) as {
        status: string;
        key: string;
        sourceBytes: number;
      };
      expect(summary.status).toBe("dry-run");
      expect(summary.key).toStartWith("screenies/");
      expect(summary.sourceBytes).toBe(TINY_PNG.length);
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
