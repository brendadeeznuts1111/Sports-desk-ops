/**
 * @file scripts/build_dashboard.ts
 * @description Enhanced Production & Target Builder for SportsDesk Dashboard using native Bun HTML bundling.
 *
 * Compiles `src/dashboard/index.html` (including CSS Houdini tokens from `tokens.generated.css`,
 * `dashboard.css`, and React 18 TypeScript entrypoints) with compile-time `bun:bundle` feature flags
 * (`prod` | `dev` | `test`) and emits `build-manifest.json` without external bundlers.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BUILD_FEATURES,
  type BuildTarget,
  type Feature,
} from "../types/features.ts";
import { runBunBuild } from "./build.ts";

export interface DashboardBuildOptions {
  readonly target?: BuildTarget | undefined;
  readonly outdir?: string | undefined;
  readonly minify?: boolean | undefined;
}

export interface DashboardArtifactSummary {
  readonly fileName: string;
  readonly kind: string;
  readonly bytes: number;
  readonly zstdBytes?: number;
  readonly gzipBytes?: number;
  readonly contentHash?: string | null;
  readonly sha256: string;
}

export interface DashboardBuildManifest {
  readonly schemaVersion: 1;
  readonly builtAt: string;
  readonly target: BuildTarget;
  readonly enabledFeatures: readonly Feature[];
  readonly minify: boolean;
  readonly elapsedMs: number;
  readonly entrypoint: string;
  readonly artifacts: readonly DashboardArtifactSummary[];
}

const DEFAULT_OUT_DIR = resolve(process.cwd(), "dist/dashboard");
const DASHBOARD_HTML_ENTRY = resolve(process.cwd(), "src/dashboard/index.html");

function isValidTarget(raw: string | undefined): raw is BuildTarget {
  return raw === "prod" || raw === "dev" || raw === "test";
}

export async function buildEnhancedDashboard(
  options: DashboardBuildOptions = {},
): Promise<DashboardBuildManifest> {
  const target: BuildTarget = options.target ?? "prod";
  const outdir = options.outdir ?? DEFAULT_OUT_DIR;
  const minify = options.minify ?? target === "prod";
  const enabledFeatures = [...BUILD_FEATURES[target]];

  mkdirSync(outdir, { recursive: true });

  const start = performance.now();
  const result = await runBunBuild({
    entrypoints: [DASHBOARD_HTML_ENTRY],
    outdir,
    target: "browser",
    features: enabledFeatures,
    minify,
    sourcemap: target === "prod" ? "external" : "inline",
  });

  if (!result.success) {
    const details = result.logs.map((l) => l.message).join("; ");
    throw new Error(
      `[build_dashboard] Bun.build failed for ${DASHBOARD_HTML_ENTRY} (target=${target}): ${details}`,
    );
  }

  const artifacts: DashboardArtifactSummary[] = await Promise.all(
    result.outputs.map(async (output): Promise<DashboardArtifactSummary> => {
      const buf = new Uint8Array(await output.arrayBuffer());
      const sha256 = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
      const fileName = output.path.split("/").pop() ?? output.path;
      const compressible =
        buf.byteLength >= 1024 &&
        (fileName.endsWith(".js") ||
          fileName.endsWith(".css") ||
          fileName.endsWith(".html"));

      let zstdBytes: number | undefined;
      let gzipBytes: number | undefined;
      if (compressible) {
        const zst = Bun.zstdCompressSync(buf);
        const gz = Bun.gzipSync(buf);
        zstdBytes = zst.byteLength;
        gzipBytes = gz.byteLength;
        await Promise.all([
          Bun.write(`${output.path}.zst`, zst),
          Bun.write(`${output.path}.gz`, gz),
        ]);
      }

      return {
        fileName,
        kind: output.kind,
        bytes: output.size,
        ...(zstdBytes === undefined ? {} : { zstdBytes }),
        ...(gzipBytes === undefined ? {} : { gzipBytes }),
        contentHash: output.hash,
        sha256,
      };
    }),
  );

  const elapsedMs = Number((performance.now() - start).toFixed(2));
  const manifest: DashboardBuildManifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    target,
    enabledFeatures,
    minify,
    elapsedMs,
    entrypoint: "src/dashboard/index.html",
    artifacts,
  };

  await Bun.write(
    resolve(outdir, "build-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return manifest;
}

/**
 * Computes an in-memory DCE bundle comparison across `prod`, `dev`, and `test` targets.
 */
export async function computeDashboardDceMatrix(): Promise<
  readonly {
    readonly target: BuildTarget;
    readonly features: readonly Feature[];
    readonly totalJsBytes: number;
    readonly totalCssBytes: number;
    readonly hasDebugSentinel: boolean;
    readonly hasExperimentalSentinel: boolean;
    readonly hasProdSentinel: boolean;
  }[]
> {
  const targets: readonly BuildTarget[] = ["prod", "dev", "test"];
  return Promise.all(
    targets.map(async (t) => {
      const feats = [...BUILD_FEATURES[t]];
      const build = await runBunBuild({
        entrypoints: [DASHBOARD_HTML_ENTRY],
        target: "browser",
        features: feats,
        minify: t === "prod",
      });
      if (!build.success) {
        throw new Error(
          `[build_dashboard] DCE matrix build failed for target=${t}`,
        );
      }

      let totalJsBytes = 0;
      let totalCssBytes = 0;
      const jsChunks: string[] = [];

      await Promise.all(
        build.outputs.map(async (out) => {
          if (out.path.endsWith(".js")) {
            totalJsBytes += out.size;
            jsChunks.push(await out.text());
          } else if (out.path.endsWith(".css")) {
            totalCssBytes += out.size;
          }
        }),
      );
      const jsCombined = jsChunks.join("");

      return {
        target: t,
        features: feats,
        totalJsBytes,
        totalCssBytes,
        hasDebugSentinel: jsCombined.includes("[DCE_DEBUG_TRACE_ACTIVE]"),
        hasExperimentalSentinel: jsCombined.includes(
          "[DCE_EXPERIMENTAL_MATRIX_ACTIVE]",
        ),
        hasProdSentinel: jsCombined.includes("[DCE_PROD_TARGET_ACTIVE]"),
      };
    }),
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string", default: "prod" },
      outdir: { type: "string" },
      "no-minify": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const rawTarget = typeof values.target === "string" ? values.target : "prod";
  if (!isValidTarget(rawTarget)) {
    console.error(
      `❌ Invalid --target="${rawTarget}" (expected prod | dev | test)`,
    );
    process.exit(1);
  }

  const outdir =
    typeof values.outdir === "string"
      ? resolve(process.cwd(), values.outdir)
      : DEFAULT_OUT_DIR;
  const minify = values["no-minify"] ? false : rawTarget === "prod";

  const manifest = await buildEnhancedDashboard({
    target: rawTarget,
    outdir,
    minify,
  });

  if (values.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(
      `\n✅ Enhanced dashboard build (${manifest.target}) completed in ${manifest.elapsedMs}ms:`,
    );
    console.log(
      `   🚩 bun:bundle features: [${manifest.enabledFeatures.join(", ")}]`,
    );
    for (const artifact of manifest.artifacts) {
      const sizeKb = (artifact.bytes / 1024).toFixed(1);
      console.log(
        `   📦 ${artifact.fileName} (${artifact.kind}, ${sizeKb} KB)`,
      );
    }
    console.log(`   📄 ${resolve(outdir, "build-manifest.json")}\n`);
  }
}
