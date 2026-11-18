/**
 * @file tests/assets_git_metadata.test.ts
 * @description Keeps `.gitattributes` aligned with `IMAGE_ASSET_EXTENSIONS` and pins the generated
 * thumbnail directory as ignored but its manifest reproducible (baselines stay tracked).
 */
import { describe, expect, test } from "bun:test";

import { IMAGE_ASSET_EXTENSIONS } from "../lib/bun_image_assets.ts";

const gitattributes = await Bun.file(".gitattributes").text();
const gitignore = await Bun.file(".gitignore").text();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("asset git metadata", () => {
  test("every raster extension is marked binary", () => {
    for (const extension of IMAGE_ASSET_EXTENSIONS) {
      const rule = new RegExp(
        `^\\*${escapeRegExp(extension)}\\s+binary\\s*$`,
        "m",
      );
      expect(gitattributes).toMatch(rule);
    }
  });

  test("generated thumbnails are ignored and marked generated", () => {
    expect(gitignore).toContain("**/.thumbs/");
    expect(gitattributes).toContain("**/.thumbs/** linguist-generated=true");
  });

  test("baselines remain tracked", () => {
    expect(gitignore).not.toContain("*baseline*");
    expect(gitattributes).not.toContain("*baseline*");
  });

  test("the bun.lock rules keep their order", () => {
    const lines = gitattributes.split("\n").map((line) => line.trim());
    const bunLock = lines.findIndex(
      (line) => line.split(/\s+/)[0] === "bun.lock",
    );
    const lockb = lines.findIndex((line) => line.split(/\s+/)[0] === "*.lockb");
    expect(bunLock).toBeGreaterThanOrEqual(0);
    expect(lockb).toBeGreaterThan(bunLock);
  });
});
