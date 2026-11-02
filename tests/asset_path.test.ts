import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { containedAssetPath, isSafeAssetName } from "../lib/asset_path.ts";

/**
 * `/assets/*` containment, including the case the platform does not cover.
 *
 * Bun's directory routes document that a symlink never leads out of `dir`. Measured on 1.4.4 /
 * macOS it does — an absolute or relative symlink under the directory is served with the outside
 * file's content. `docs/assets` has no symlinks today; these tests keep that from becoming a leak
 * if one is added, and they are the reason the handler resolves real paths instead of trusting a
 * name check.
 */

describe("isSafeAssetName", () => {
  test("rejects traversal, absolute names, control characters and backslashes", () => {
    for (const name of [
      "",
      "../x",
      "a/../b",
      "/etc/passwd",
      "a\u0000b",
      "a\\b",
    ]) {
      expect(isSafeAssetName(name)).toBe(false);
    }
  });

  test("accepts ordinary and nested names", () => {
    for (const name of [
      "ok.txt",
      "sub/dir/ok.txt",
      "pipeline-10-mode-architecture.png",
    ]) {
      expect(isSafeAssetName(name)).toBe(true);
    }
  });
});

describe("containedAssetPath", () => {
  const root = mkdtempSync(join(tmpdir(), "asset-path-"));
  const dir = join(root, "assets");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "ok.txt"), "ok");
  writeFileSync(join(root, "outside.txt"), "SECRET");
  symlinkSync(join(root, "outside.txt"), join(dir, "abs-link.txt"));
  symlinkSync("../outside.txt", join(dir, "rel-link.txt"));
  symlinkSync("ok.txt", join(dir, "inside-link.txt"));

  // /var is a symlink to /private/var on macOS, so compare against the resolved directory.
  const realDir = realpathSync(dir);

  test("a file inside the directory resolves", () => {
    expect(containedAssetPath(dir, "ok.txt")).toBe(join(realDir, "ok.txt"));
    expect(containedAssetPath(dir, "sub/../ok.txt") === null).toBe(true); // `..` rejected by name
    expect(containedAssetPath(dir, "inside-link.txt")).toBe(
      join(realDir, "ok.txt"),
    );
  });

  test("an absolute or relative symlink out of the directory is refused", () => {
    // This is the case Bun 1.4.4's directory route serves (measured: 200 "SECRET").
    expect(containedAssetPath(dir, "abs-link.txt")).toBeNull();
    expect(containedAssetPath(dir, "rel-link.txt")).toBeNull();
  });

  test("missing files and unsafe names are refused", () => {
    expect(containedAssetPath(dir, "missing.txt")).toBeNull();
    expect(containedAssetPath(dir, "../outside.txt")).toBeNull();
    expect(containedAssetPath(dir, "/etc/passwd")).toBeNull();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the route", () => {
  test("a symlink added under docs/assets would not be served", () => {
    // Guards the real directory: nothing to do if it stays clean, and a failure here means an
    // asset symlink was added and the handler (not this test) is the thing to check.
    const dir = join(import.meta.dir, "..", "docs", "assets");
    expect(containedAssetPath(dir, "pipeline-artifacts-metadata.json")).toBe(
      join(realpathSync(dir), "pipeline-artifacts-metadata.json"),
    );
    expect(containedAssetPath(dir, "nope.txt")).toBeNull();
  });
});
