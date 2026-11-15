/**
 * @file scripts/build_plugins/slab_config_guard.ts
 * @description Build-time guard for the frontend slab TOML config.
 *
 * The browser bundle must never inherit `unsafe.allowed = true` from the server
 * slab policy. `packages/ui/src/config/slab.ts` also throws at module load, but
 * that is a runtime failure in the browser; this plugin moves the same assertion
 * to the build.
 *
 * Bun 1.4.4 supports pre-parsed `exports` from `onLoad` ONLY with the companion
 * `loader: "object"` discriminator (measured 2026-11-14; without it the build
 * fails with "onLoad plugins must return an object with \"contents\" as a string
 * or Uint8Array"). This guard still returns the original text with the `toml`
 * loader because that preserves the built-in loader's export shape: the default
 * export is the whole config plus a named export per top-level key. The object
 * form exposes only the keys handed to it and no default export, so switching
 * would silently drop `import cfg from "…toml"` consumers. Validation is what the
 * guard is for, and it happens either way; tree-shaking is identical (measured:
 * importing one top-level key drops the others on both paths).
 *
 * Scope note: this is a BUILD-time plugin. The same text+toml shape under the
 * runtime `Bun.plugin` produced a module with no exports in a 2026-11-14 probe,
 * while the object form worked there. The guard does not rely on the runtime path.
 */
import type { BunPlugin } from "bun";

const FRONTEND_CONFIG = /packages\/ui\/src\/config\/[^/]+\.toml$/;

export const slabConfigGuard: BunPlugin = {
  name: "slab-config-guard",
  setup(build) {
    build.onLoad({ filter: FRONTEND_CONFIG }, async ({ path }) => {
      const text = await Bun.file(path).text();
      const config = Bun.TOML.parse(text) as Record<string, unknown>;
      const unsafe = config["unsafe"];
      if (unsafe !== undefined) {
        if (
          typeof unsafe !== "object" ||
          unsafe === null ||
          (unsafe as Record<string, unknown>)["allowed"] !== false
        ) {
          const name = path.split("/").pop() ?? path;
          throw new Error(
            `slab-config-guard: ${name} must set unsafe.allowed = false for the frontend bundle (found ${JSON.stringify((unsafe as Record<string, unknown>)?.["allowed"])})`,
          );
        }
      }
      return { contents: text, loader: "toml" };
    });
  },
};
