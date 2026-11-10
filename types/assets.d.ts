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
