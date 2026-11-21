import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_DIR = join(ROOT, "packages", "contracts");
const EXCLUDED = /(^|[/\\])(dist|node_modules)([/\\]|$)/;

const temps: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "contracts-pack-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("contracts pack shape", () => {
  test("prepack builds a dist/ into a clean package copy before packing", async () => {
    const temp = await makeTempDir();
    const copy = join(temp, "contracts");
    await cp(PACKAGE_DIR, copy, {
      recursive: true,
      filter: (source) => !EXCLUDED.test(source),
    });

    // The copied package declares `catalog:` devDependencies; give the temp
    // workspace the same root catalog so `bun run build` resolves them.
    const rootPackage = (await Bun.file(join(ROOT, "package.json")).json()) as {
      catalog?: Record<string, string>;
    };
    await writeFile(
      join(temp, "package.json"),
      JSON.stringify({
        name: "contracts-pack-fixture",
        private: true,
        workspaces: ["contracts"],
        catalog: rootPackage.catalog ?? {},
      }),
    );

    const pack = Bun.spawnSync(
      [process.execPath, "pm", "pack", "--destination", temp, "--quiet"],
      { cwd: copy, stdout: "pipe", stderr: "pipe" },
    );
    if (pack.exitCode !== 0) {
      throw new Error(
        "bun pm pack failed: " + (await new Response(pack.stderr).text()),
      );
    }

    const tarball = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    if (tarball === undefined) return;

    const listing = Bun.spawnSync(["tar", "-tzf", join(temp, tarball)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const entries = await new Response(listing.stdout).text();
    expect(listing.exitCode).toBe(0);
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/src/index.ts");
    expect(entries).toContain("package/package.json");
  }, 20_000);

  test("project bunfig does not suppress pack lifecycle", async () => {
    const text = await Bun.file(join(ROOT, "bunfig.toml")).text();
    expect(text).not.toMatch(/^\s*ignoreScripts\s*=\s*true\s*$/m);
  });
});
