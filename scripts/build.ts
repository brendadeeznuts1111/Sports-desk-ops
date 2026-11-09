import path from "node:path";
import { BUILD_FEATURES } from "../types/features.ts";

/**
 * SportsDesk Target Bundler
 * Compiles application entrypoints with target-specific compile-time features.
 */
export interface TargetBuildConfig {
  target: "prod" | "dev" | "test";
  entrypoints: string[];
  outdir?: string;
  minify?: boolean;
}

export async function buildTarget(config: TargetBuildConfig) {
  const targetFeatures = BUILD_FEATURES[config.target];
  console.log(
    `[Bun.build] Target "${config.target}" enabled features: ${targetFeatures.join(", ") || "(none)"}`,
  );

  const buildOptions: Parameters<typeof Bun.build>[0] = {
    entrypoints: config.entrypoints,
    features: [...targetFeatures],
    minify: config.minify ?? config.target === "prod",
  };
  if (config.outdir !== undefined) {
    buildOptions.outdir = config.outdir;
  }

  return await Bun.build(buildOptions);
}

// CLI direct execution: bun run scripts/build.ts [prod|dev|test] [entrypoint]
if (import.meta.main) {
  const target = (process.argv[2] as "prod" | "dev" | "test") || "prod";
  const defaultEntry = path.join(
    import.meta.dir,
    "../examples/feature_flags/risk_engine.ts",
  );
  const entrypoint = process.argv[3] || defaultEntry;

  const result = await buildTarget({
    target,
    entrypoints: [entrypoint],
  });

  if (!result.success) {
    console.error("Build failed:", result.logs);
    process.exit(1);
  }

  const output = result.outputs[0];
  if (output) {
    const code = await output.text();
    console.log(
      `\nBuild succeeded (${Buffer.byteLength(code, "utf8")} bytes):`,
    );
    console.log(code.trim());
  }
}
