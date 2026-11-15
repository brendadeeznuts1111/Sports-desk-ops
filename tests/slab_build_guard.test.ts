import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slabConfigGuard } from "../scripts/build_plugins/slab_config_guard.ts";

/**
 * The guard must fail the build (not the browser) when the frontend slab config
 * allows unsafe slabs, and must not change anything when the config is valid.
 * Bun 1.4.4 has no `exports`-from-onLoad support, so the plugin returns the
 * original TOML text with the default loader; these cases pin both the failure
 * and the pass-through, including tree-shaking of an unimported top-level key.
 */

const ENTRY =
  'import { meta } from "./packages/ui/src/config/slab.frontend.toml";\nconsole.log(JSON.stringify(meta));';

function project(configToml: string) {
  const root = mkdtempSync(join(tmpdir(), "slab-guard-"));
  const dir = join(root, "packages/ui/src/config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slab.frontend.toml"), configToml);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  return root;
}

async function build(root: string) {
  return await Bun.build({
    entrypoints: [join(root, "entry.ts")],
    outdir: join(root, "out"),
    target: "browser",
    plugins: [slabConfigGuard],
  });
}

describe("slab config build guard", () => {
  test("valid config builds and drops the unimported unsafe table", async () => {
    const root = project(
      '[meta]\nschema = "sportsdesk-slab-frontend/v1"\n\n[unsafe]\nallowed = false\n',
    );
    try {
      const result = await build(root);
      expect(result.success).toBe(true);
      const js = await Bun.file(join(root, "out/entry.js")).text();
      expect(js).toContain("sportsdesk-slab-frontend/v1");
      expect(js).not.toContain("allowed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("unsafe.allowed = true fails the build with a named reason", async () => {
    const root = project(
      '[meta]\nschema = "sportsdesk-slab-frontend/v1"\n\n[unsafe]\nallowed = true\n',
    );
    try {
      // A throwing onLoad rejects Bun.build with an AggregateError whose own
      // message is "Bundle failed"; the plugin's reason is in .errors. Measured
      // 2026-11-14 in Bun 1.4.4.
      const error = (await build(root).catch(
        (e: unknown) => e,
      )) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      const details = [...(error.errors ?? [])]
        .map((e) => (e as Error).message)
        .join("; ");
      expect(details).toContain("slab-config-guard");
      expect(details).toContain("unsafe.allowed = false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a config without an unsafe table passes through untouched", async () => {
    const root = project('[meta]\nschema = "sportsdesk-slab-frontend/v1"\n');
    try {
      const result = await build(root);
      expect(result.success).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
