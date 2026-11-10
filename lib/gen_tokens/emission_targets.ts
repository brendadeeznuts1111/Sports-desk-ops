/**
 * Domain model: every gen:tokens output and how the zero-drift gate resets/verifies it.
 */
export type EmissionReset = "git-checkout-head" | "rm-before-gen";

export type EmissionMode = "splice-from-committed" | "full-from-toml";

export type GenTokenEmissionTarget = {
  /** Repo-relative path from workspace root. */
  repoPath: string;
  mode: EmissionMode;
  /** How the gate prepares disk before `bun run gen:tokens`. */
  reset: EmissionReset;
};

/** Single registry — gate and generator must agree on these paths. */
export const GEN_TOKEN_EMISSION_TARGETS: readonly GenTokenEmissionTarget[] = [
  {
    repoPath: "design/domain-branded-types.ts",
    mode: "full-from-toml",
    reset: "rm-before-gen",
  },
  {
    repoPath: "src/dashboard/tokens.generated.css",
    mode: "full-from-toml",
    reset: "rm-before-gen",
  },
  {
    repoPath: "static/customer-churn-simulation-dashboard.html",
    mode: "splice-from-committed",
    reset: "git-checkout-head",
  },
  {
    repoPath: "static/telegram-miniapp-dashboard.html",
    mode: "splice-from-committed",
    reset: "git-checkout-head",
  },
] as const;

export const GEN_TOKEN_EMISSION_PATHS: readonly string[] =
  GEN_TOKEN_EMISSION_TARGETS.map((t) => t.repoPath);

/** Written by generate_tokens.ts; gate requires every target path listed. */
export const GEN_TOKEN_EMISSION_MANIFEST = "scratch/gen-tokens-emitted.json";

export type GenTokenEmissionRecord = {
  repoPath: string;
  sha256: string;
};

export type GenTokenEmissionManifest = {
  /** Set when `gen:tokens` runs under `gen:tokens:gate`. */
  gateRunId?: string;
  emitted: GenTokenEmissionRecord[];
};
