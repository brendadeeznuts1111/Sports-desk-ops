/**
 * @file types/bundle.d.ts
 * @description Compile-time feature flags for bun:bundle dead-code elimination.
 *
 * Augments Bun's `Registry` interface so that `feature()` from "bun:bundle"
 * is strictly typed against known compile-time flags.
 *
 * NOTE: Bun 1.4+ transpiler enforces that `feature()` can only be used
 * directly inside an `if` statement condition or ternary expression:
 *
 *   if (feature("DEBUG")) { ... }
 *   const enabled = feature("DEBUG") ? true : false;
 *
 * Passing `feature()` to functions or assigning it directly to a variable
 * will fail at parse/transpile time (`error: feature() from "bun:bundle" can
 * only be used directly in an if statement or ternary condition`).
 */

import type { Feature } from "./features.ts";

declare module "bun:bundle" {
  interface Registry {
    features: Feature;
  }
}
