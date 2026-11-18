/**
 * @file lib/image_limits.ts
 * @description Single source for the pixel cap shared by `Bun.Image` call sites.
 */

/** Longest edge accepted by `resize()` (`Bun.Image` rejects larger values). */
export const MAX_IMAGE_EDGE = 16_384;

/** Default `maxPixels` guard: `16384 × 16384`. */
export const DEFAULT_MAX_PIXELS = MAX_IMAGE_EDGE * MAX_IMAGE_EDGE;
