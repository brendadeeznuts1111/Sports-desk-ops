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
  existsSync,
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
  test("symlinks a link: directory into node_modules", () => {
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

  test("resolves link: relative to a workspace package.json, not the repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-link-ws-"));
    try {
      const sharedDir = join(dir, "shared");
      const appDir = join(dir, "packages", "app");
      mkdirSync(sharedDir, { recursive: true });
      mkdirSync(appDir, { recursive: true });

      writeFileSync(
        join(sharedDir, "package.json"),
        JSON.stringify({
          name: "ws-shared",
          version: "1.0.0",
          main: "index.js",
        }),
      );
      writeFileSync(
        join(sharedDir, "index.js"),
        'module.exports = "WS_SHARED_OK";\n',
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "link-ws-root",
          version: "0.0.0",
          private: true,
          workspaces: ["packages/*"],
        }),
      );
      writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify({
          name: "@link-probe/app",
          version: "1.0.0",
          dependencies: { "ws-shared": "link:../../shared" },
        }),
      );

      const env = {
        ...process.env,
        HOME: join(dir, ".home"),
        NO_COLOR: "1",
      };
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
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(install.exitCode, install.stderr.toString()).toBe(0);

      const linked = existsSync(join(appDir, "node_modules", "ws-shared"))
        ? join(appDir, "node_modules", "ws-shared")
        : join(dir, "node_modules", "ws-shared");
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(realpathSync(linked)).toBe(realpathSync(sharedDir));

      const evaluated = Bun.spawnSync(
        [process.execPath, "-e", "console.log(require('ws-shared'))"],
        { cwd: appDir, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(evaluated.exitCode, evaluated.stderr.toString()).toBe(0);
      expect(evaluated.stdout.toString().trim()).toBe("WS_SHARED_OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
