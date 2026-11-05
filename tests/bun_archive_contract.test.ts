import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `Bun.Archive.extract()` accepts `../` and absolute member names, but it does not write
 * outside the destination: it strips the traversal and keeps the member under the target
 * directory. That containment is security-relevant for any archive we verify rather than
 * generated ourselves, so pin it rather than assume zip-slip protection.
 *
 * `.files()` still returns the raw member names, which is why callers must not treat a
 * `files()` key as a path.
 */
describe("Bun.Archive containment", () => {
  test("extract keeps traversal and absolute members inside the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-archive-"));
    const absoluteTarget = join(
      tmpdir(),
      `bun-archive-absolute-${process.pid}-${Date.now()}.txt`,
    );
    const members = {
      "../escape.txt": "one",
      "../../escape2.txt": "two",
      [absoluteTarget]: "three",
      "safe/../../escape3.txt": "four",
      "safe/ok.txt": "five",
    };
    try {
      const bytes = await new Bun.Archive(members).bytes();
      const extractDir = join(dir, "out");
      mkdirSync(extractDir, { recursive: true });
      await new Bun.Archive(bytes).extract(extractDir);

      // Nothing landed outside the extraction root.
      expect(await Bun.file(join(dir, "escape.txt")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "..", "escape2.txt")).exists()).toBe(
        false,
      );
      expect(await Bun.file(absoluteTarget).exists()).toBe(false);

      // Members are remapped under the destination, traversal stripped.
      expect(await Bun.file(join(extractDir, "escape.txt")).text()).toBe("one");
      expect(await Bun.file(join(extractDir, "escape2.txt")).text()).toBe(
        "two",
      );
      expect(await Bun.file(join(extractDir, "escape3.txt")).text()).toBe(
        "four",
      );
      expect(await Bun.file(join(extractDir, "safe", "ok.txt")).text()).toBe(
        "five",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(absoluteTarget, { force: true });
    }
  });

  test("files() preserves the raw member names", async () => {
    const bytes = await new Bun.Archive({
      "../escape.txt": "one",
      "safe/ok.txt": "two",
    }).bytes();
    const files = await new Bun.Archive(bytes).files();
    expect([...files.keys()].sort()).toEqual(["../escape.txt", "safe/ok.txt"]);
  });
});
