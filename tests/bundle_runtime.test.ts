import { feature } from "bun:bundle";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_FEATURES } from "../types/features.ts";

async function withProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bun-bundle-test-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await Bun.write(join(dir, name), contents);
    }
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bun:bundle runtime and bundler behavior", () => {
  test("feature flag reflects absence of CLI flag by default", () => {
    // Under regular test runner (no --feature=DEBUG flag passed), flag is false
    const isDebug = feature("DEBUG") ? true : false;
    expect(isDebug).toBe(false);
  });

  test("Bun.spawn with --feature=DEBUG activates the flag at runtime", async () => {
    // NOTE: Subprocess execution is required to test flag activation, as feature
    // flags are evaluated at transpile/startup time and cannot be toggled mid-process.
    await withProject(
      {
        "entry.ts": `
import { feature } from "bun:bundle";
if (feature("DEBUG")) {
  console.log("FEATURE_ACTIVE");
} else {
  console.log("FEATURE_INACTIVE");
}
`,
      },
      async (dir) => {
        const file = join(dir, "entry.ts");

        // Run without flag
        const runDefault = Bun.spawnSync([process.execPath, "run", file]);
        expect(runDefault.exitCode).toBe(0);
        expect(runDefault.stdout.toString().trim()).toBe("FEATURE_INACTIVE");

        // Run with --feature=DEBUG before run subcommand
        const runDebug = Bun.spawnSync([
          process.execPath,
          "--feature=DEBUG",
          "run",
          file,
        ]);
        expect(runDebug.exitCode).toBe(0);
        expect(runDebug.stdout.toString().trim()).toBe("FEATURE_ACTIVE");

        // Run with --feature=DEBUG directly on file
        const runDebugDirect = Bun.spawnSync([
          process.execPath,
          "--feature=DEBUG",
          file,
        ]);
        expect(runDebugDirect.exitCode).toBe(0);
        expect(runDebugDirect.stdout.toString().trim()).toBe("FEATURE_ACTIVE");
      },
    );
  });

  test("Bun.spawn with multiple feature flags enables only specified flags", async () => {
    await withProject(
      {
        "entry.ts": `
import { feature } from "bun:bundle";
const d = feature("DEBUG") ? "DEBUG_ON" : "DEBUG_OFF";
const p = feature("PROD") ? "PROD_ON" : "PROD_OFF";
const t = feature("TEST") ? "TEST_ON" : "TEST_OFF";
console.log([d, p, t].join(","));
`,
      },
      async (dir) => {
        const file = join(dir, "entry.ts");

        // Enable DEBUG and TEST, leave PROD omitted (false otherwise)
        const runMulti = Bun.spawnSync([
          process.execPath,
          "--feature=DEBUG",
          "--feature=TEST",
          "run",
          file,
        ]);
        expect(runMulti.exitCode).toBe(0);
        expect(runMulti.stdout.toString().trim()).toBe(
          "DEBUG_ON,PROD_OFF,TEST_ON",
        );
      },
    );
  });

  test("Bun.build performs dead-code elimination and removes bun:bundle import", async () => {
    await withProject(
      {
        "entry.ts": `
import { feature } from "bun:bundle";

export function getPayload() {
  if (feature("DEBUG")) {
    return "DEBUG_PAYLOAD_SECRET";
  } else {
    return "PRODUCTION_PAYLOAD_SAFE";
  }
}
`,
      },
      async (dir) => {
        const entry = join(dir, "entry.ts");

        // Build without features: DEBUG branch stripped
        const buildProd = await Bun.build({
          entrypoints: [entry],
          target: "bun",
          minify: true,
        });
        expect(buildProd.success).toBe(true);
        const prodText = await buildProd.outputs[0]!.text();
        expect(prodText).toContain("PRODUCTION_PAYLOAD_SAFE");
        expect(prodText).not.toContain("DEBUG_PAYLOAD_SECRET");
        expect(prodText).not.toContain("bun:bundle");

        // Build with features: ["DEBUG"]: production branch stripped
        const buildDebug = await Bun.build({
          entrypoints: [entry],
          target: "bun",
          minify: true,
          features: ["DEBUG"],
        });
        expect(buildDebug.success).toBe(true);
        const debugText = await buildDebug.outputs[0]!.text();
        expect(debugText).toContain("DEBUG_PAYLOAD_SECRET");
        expect(debugText).not.toContain("PRODUCTION_PAYLOAD_SAFE");
        expect(debugText).not.toContain("bun:bundle");
      },
    );
  });

  test("BUILD_FEATURES.prod excludes debug, test and experimental flags", async () => {
    expect(BUILD_FEATURES.prod).toContain("PROD");
    expect(BUILD_FEATURES.prod).not.toContain("DEBUG");
    expect(BUILD_FEATURES.prod).not.toContain("TEST");
    expect(BUILD_FEATURES.prod).not.toContain("EXPERIMENTAL");

    await withProject(
      {
        "entry.ts": `
import { feature } from "bun:bundle";
if (feature("PROD")) {
  console.log("PROD_PAYLOAD");
}
if (feature("DEBUG")) {
  console.log("DEBUG_LEAK");
}
`,
      },
      async (dir) => {
        const build = await Bun.build({
          entrypoints: [join(dir, "entry.ts")],
          target: "bun",
          minify: true,
          features: [...BUILD_FEATURES.prod],
        });
        expect(build.success).toBe(true);
        const text = await build.outputs[0]!.text();
        expect(text).toContain("PROD_PAYLOAD");
        expect(text).not.toContain("DEBUG_LEAK");
      },
    );
  });
});
