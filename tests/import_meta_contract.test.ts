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

  test("resolve is synchronous, honors a string parent, and does not check existence", () => {
    const parentUrl = new URL("file:///tmp/a/b/c.ts");
    const expected = "file:///tmp/a/b/x.ts";

    expect(typeof import.meta.resolve("./package.json")).toBe("string");
    expect(import.meta.resolve("node:fs")).toBe("node:fs");
    expect(import.meta.resolve("bun:test")).toBe("bun:test");
    expect(import.meta.resolve("./x.ts", parentUrl.href)).toBe(expected);
    // Bun 1.4.4 ignores the documented URL overload and resolves against this module.
    // Pin the observed gap; a fix should fail this line and update the contract.
    expect(import.meta.resolve("./x.ts", parentUrl)).toBe(
      new URL("./x.ts", import.meta.url).href,
    );
    expect(import.meta.resolve("./does-not-exist-contract")).toBe(
      new URL("./does-not-exist-contract", import.meta.url).href,
    );
  });

  test("resolve follows the documented (specifier, parent?) string contract", () => {
    // Bun returns a `file:` URL string (not a URL object), resolves relative specifiers against
    // the module, keeps built-in schemes, and accepts a parent directory or file URL. Resolution
    // is textual: it does not check that the target exists.
    const moduleUrl = new URL(import.meta.url).href;
    expect(import.meta.resolve("./import_meta_contract.test.ts")).toBe(
      moduleUrl,
    );
    expect(import.meta.resolve("./nested/fixture.ts")).toBe(
      new URL("./nested/fixture.ts", import.meta.url).href,
    );
    expect(import.meta.resolve("../package.json")).toBe(
      new URL("../package.json", import.meta.url).href,
    );
    expect(import.meta.resolve("node:path")).toBe("node:path");
    expect(import.meta.resolve("bun:test")).toBe("bun:test");

    // A bare specifier goes through node_modules and resolves to a file URL.
    expect(import.meta.resolve("oxlint").startsWith("file:")).toBe(true);

    // The parent argument is a *module* path or URL: `./x` anchors at its dirname. Passing a
    // directory as a plain path therefore resolves one level up (it is read as a file name);
    // a trailing slash is what anchors at the directory itself.
    expect(fileURLToPath(import.meta.resolve("./x.ts", import.meta.url))).toBe(
      join(import.meta.dir, "x.ts"),
    );
    expect(fileURLToPath(import.meta.resolve("./x.ts", import.meta.dir))).toBe(
      join(dirname(import.meta.dir), "x.ts"),
    );
    const nestedDir = join(import.meta.dir, "nested");
    expect(fileURLToPath(import.meta.resolve("./x.ts", `${nestedDir}/`))).toBe(
      join(nestedDir, "x.ts"),
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
    // throws "import.meta.glob is not a function". The documented options
    // (Bun.ImportMetaGlobOptions: base/eager/exhaustive/import/query) are also absent from
    // bun-types 1.4.4, so there is no type to compile against yet. Pin the gap so an
    // implementation change surfaces here.
    // `glob` is not on the 1.4.4 ImportMeta type; read it as an untyped runtime property.
    expect(
      (import.meta as ImportMeta & { glob?: unknown }).glob,
    ).toBeUndefined();
    expect(import.meta.hot).toBeUndefined();
  });
});
