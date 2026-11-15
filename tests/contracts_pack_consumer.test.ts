import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The npm publish artifact is the packed tarball, not the workspace source. This
 * installs that tarball into a throwaway project and imports it the way a consumer
 * would: Bun resolves the "bun" condition (src), Node resolves "default" (dist).
 * Measured 2026-11-14: Node refuses the TypeScript source
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the dist leg is the only reason
 * a Node consumer can use this package at all.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const PKG = path.join(ROOT, "packages/contracts");

function run(cmd: string[], cwd: string) {
  return Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
}

describe("packed tarball consumers", () => {
  test("installs and imports under Bun and Node", () => {
    const work = mkdtempSync(path.join(tmpdir(), "contracts-consumer-"));
    try {
      const packDir = path.join(work, "pack");
      mkdirSync(packDir);
      const pack = run(["bun", "pm", "pack", "--destination", packDir], PKG);
      expect(pack.exitCode).toBe(0);
      const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
      expect(tgz).toBeDefined();

      // The build must run from prepack: dist/ is gitignored and absent in a clean
      // checkout, so a tarball without it would break every Node consumer.
      const listing = run(["tar", "-tzf", path.join(packDir, tgz!)], work);
      expect(listing.exitCode).toBe(0);
      expect(listing.stdout.toString()).toContain("package/dist/index.js");

      const consumer = path.join(work, "consumer");
      mkdirSync(consumer);
      writeFileSync(
        path.join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }),
      );
      const add = run(
        ["bun", "add", `file:${path.join(packDir, tgz!)}`],
        consumer,
      );
      expect(add.exitCode).toBe(0);

      const bunCheck = run(
        [
          "bun",
          "-e",
          'import { FEATURES } from "@sportsdesk-ops/contracts/features"; import * as c from "@sportsdesk-ops/contracts"; if (Object.keys(c).length === 0 || FEATURES.length === 0) throw new Error("empty exports"); console.log("bun-ok");',
        ],
        consumer,
      );
      expect(bunCheck.exitCode).toBe(0);
      expect(bunCheck.stdout.toString()).toContain("bun-ok");

      if (Bun.which("node")) {
        const nodeCheck = run(
          [
            "node",
            "-e",
            'import("@sportsdesk-ops/contracts").then(async (m) => { const f = await import("@sportsdesk-ops/contracts/features"); if (Object.keys(m).length === 0 || f.FEATURES.length === 0) throw new Error("empty exports"); console.log("node-ok"); })',
          ],
          consumer,
        );
        expect(nodeCheck.exitCode).toBe(0);
        expect(nodeCheck.stdout.toString()).toContain("node-ok");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
