/**
 * @file types/features.ts
 * @description Canonical SSOT for compile-time bun:bundle feature flags and build targets.
 */

export const FEATURES = [
  "DEBUG",
  "PROD",
  "TEST",
  "ANALYTICS",
  "EXPERIMENTAL",
] as const;

export type Feature = (typeof FEATURES)[number];

export type BuildTarget = "dev" | "prod" | "test";

const PROD_EXCLUDE = new Set<Feature>(["DEBUG", "TEST", "EXPERIMENTAL"]);
const TEST_EXCLUDE = new Set<Feature>(["EXPERIMENTAL", "PROD"]);

export const BUILD_FEATURES: Record<BuildTarget, readonly Feature[]> = {
  dev: FEATURES.filter((f) => f !== "PROD"),
  prod: FEATURES.filter((f) => !PROD_EXCLUDE.has(f)),
  test: FEATURES.filter((f) => !TEST_EXCLUDE.has(f)),
} as const;

export const DESCRIPTIONS: Record<Feature, string> = {
  DEBUG: "Verbose logging and dev-only assertions.",
  PROD: "Production-only code paths.",
  TEST: "Test-harness hooks; stripped in prod.",
  ANALYTICS: "Telemetry emission.",
  EXPERIMENTAL: "Unstable features behind opt-in.",
};
