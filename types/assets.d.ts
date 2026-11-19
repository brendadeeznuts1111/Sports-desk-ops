/**
 * @file types/assets.d.ts
 * @description Ambient module declarations for Bun native HTML & CSS bundler imports.
 */

declare module "*.html" {
  import type { HTMLBundle } from "bun";
  const bundle: HTMLBundle;
  export default bundle;
}

declare module "*.css" {
  const href: string;
  export default href;
}

/**
 * Bun's file loader returns a path string for any unrecognised asset.
 *
 * `bun run` resolves to the file's absolute path on disk (Bun verifies it exists); `bun build`
 * copies the file into `outdir` per `naming.asset` and rewrites the import to a path relative to
 * the output, optionally prefixed by `publicPath`. Both are a string.
 */
declare module "*.svg" {
  const path: string;
  export default path;
}
