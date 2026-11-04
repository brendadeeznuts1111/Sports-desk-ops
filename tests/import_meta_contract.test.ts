/**
 * `import.meta` contract for Bun's ESM sources.
 *
 * Bun provides both the repo-standard `import.meta.dir`/`main` and the Node-compatible
 * `dirname`/`filename` aliases. Source files must not fall back to `__dirname`/`__filename`;
 * this ratchet catches that regression and pins the alias relationships the scripts rely on.
 */
import { describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dir, "..");
const FILE = fileURLToPath(import.meta.url);
const SOURCE_ROOTS = ["lib", "scripts", "services", "tests", "bin"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const NODE_PATH_GLOBALS = /\b__(?:dirname|filename)\b/;

function trackedSourceFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", ...SOURCE_ROOTS],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((path) =>
      SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)),
    );
}

describe("import.meta contract", () => {
  test("dir, file, filename, path and dirname agree with the file URL", () => {
    expect(import.meta.url.startsWith("file:")).toBe(true);
    expect(import.meta.file).toBe(basename(FILE));
    expect(import.meta.filename).toBe(FILE);
    expect(import.meta.path).toBe(FILE);
    expect(import.meta.dir).toBe(dirname(FILE));
    expect(import.meta.dirname).toBe(import.meta.dir);
    expect(import.meta.env).toBe(process.env);
    expect(typeof import.meta.require).toBe("function");
    expect(typeof import.meta.resolve).toBe("function");
    expect(import.meta.resolve("./import_meta_contract.test.ts")).toBe(
      new URL(import.meta.url).href,
    );
  });

  test("bun test exposes the env view without Vite keys on 1.4.4", () => {
    // The current docs say bun test adds MODE/DEV/PROD/SSR/BASE_URL. Bun 1.4.4 does not;
    // pin the observed shape so a runtime change surfaces here.
    for (const key of ["MODE", "DEV", "PROD", "SSR", "BASE_URL"] as const) {
      expect((import.meta.env as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  test("source files do not use Node's __dirname or __filename", async () => {
    const offenders: string[] = [];
    for (const path of trackedSourceFiles()) {
      if (path === "tests/import_meta_contract.test.ts") continue;
      const text = await Bun.file(join(ROOT, path)).text();
      if (NODE_PATH_GLOBALS.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("glob and hot are absent at runtime on 1.4.4", () => {
    // The docs describe a bundler/HMR transform. Bun 1.4.4 neither exposes
    // import.meta.glob at runtime nor rewrites it in Bun.build/bun build; the built call still
    // throws "import.meta.glob is not a function". Pin the gap so an implementation change
    // surfaces here.
    expect(import.meta.glob).toBeUndefined();
    expect(import.meta.hot).toBeUndefined();
  });
});
