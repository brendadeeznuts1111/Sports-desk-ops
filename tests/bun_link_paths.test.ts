/**
 * @file tests/bun_link_paths.test.ts
 * @description `link:./dir` must create a real symlink in `node_modules`, not a registry fetch.
 *
 * Re-measures the 1.4.4 release note ("link: supports paths"): the path is relative to the
 * `package.json` that declares it and `bun link` is not required first. The install uses a
 * temporary cache so the test never touches the user's Bun cache or the network.
 */

import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: link-paths

describe("bun link: paths", () => {
  test("link:./dir symlinks the directory into node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-link-"));
    try {
      const linkedDir = join(dir, "vendor", "linked");
      mkdirSync(linkedDir, { recursive: true });
      writeFileSync(
        join(linkedDir, "package.json"),
        JSON.stringify({ name: "linked", version: "1.0.0", main: "index.js" }),
      );
      writeFileSync(join(linkedDir, "index.js"), "module.exports = 1;\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "link-probe",
          version: "0.0.0",
          private: true,
          dependencies: { linked: "link:./vendor/linked" },
        }),
      );

      const install = Bun.spawnSync(
        [
          process.execPath,
          "install",
          "--no-env-file",
          "--ignore-scripts",
          "--no-summary",
          "--cache-dir",
          join(dir, ".cache"),
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(install.exitCode).toBe(0);

      const linked = join(dir, "node_modules", "linked");
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(realpathSync(linked)).toBe(realpathSync(linkedDir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
