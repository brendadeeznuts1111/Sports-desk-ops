/**
 * @file tests/bun_upstream_reference.test.ts
 * @description Keeps the "Bun.XML / bun x / package catalogs" section of
 * `docs/bun-upstream-reference.md` tied to the code it cites.
 *
 * The section makes three kinds of claim: `Bun.XML` call sites, `bun x` bin
 * mappings, and `catalog:` resolution. Each one is checked against the tree, so a
 * rename or a new `.yarnrc.yml` turns the prose stale instead of silently rotting.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readBunReleaseBehaviors } from "../lib/bun_release_behaviors.ts";

const ROOT = join(import.meta.dir, "..");

const WORKSPACE_DIRS = [
  "packages/api",
  "packages/backend",
  "packages/contracts",
  "packages/sportsdesk-ops",
  "packages/ui",
] as const;

const DEPENDENCY_GROUPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function read(relativePath: string): Promise<string> {
  return Bun.file(join(ROOT, relativePath)).text();
}

async function readJson<T>(relativePath: string): Promise<T> {
  return (await Bun.file(join(ROOT, relativePath)).json()) as T;
}

describe("Bun upstream reference: XML, bun x and catalogs", () => {
  test("documents every measured release behavior and cites the 1.4.4 release note", async () => {
    const doc = await read("docs/bun-upstream-reference.md");
    const behaviors = await readBunReleaseBehaviors(ROOT);
    expect(behaviors.length).toBeGreaterThan(0);
    for (const behavior of behaviors) {
      expect(doc, behavior.id).toContain(behavior.docSection);
    }
    expect(doc).toContain("## `Bun.XML`, `bun x` and package catalogs");
    expect(doc).toContain(
      "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4",
    );
    expect(doc).toContain(
      "https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/runtime/xml.mdx",
    );
    expect(doc).toContain("bun.com/blog/bun-v1.4.4");
    expect(doc).toContain("ERR_DOD_CSR_CONSERVATION_BREACH");
    expect(doc).toContain("tests/bun_x_cli_help.test.ts");
    expect(doc).toContain(
      "https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/docs/runtime/semver.mdx",
    );
    for (const flag of [
      "--immutable",
      "--save-catalog",
      "--shamefully-hoist",
      "--no-package-lock",
      "--frozen-lockfil",
    ]) {
      expect(doc).toContain(flag);
    }
  });

  test("CI installs use only flags this Bun build understands", async () => {
    const help = Bun.spawnSync([process.execPath, "install", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const nativeFlags = new Set(
      [...help.stdout.toString().matchAll(/--[a-z][a-z-]*/g)].map(
        (match) => match[0],
      ),
    );
    expect(nativeFlags.has("--frozen-lockfile")).toBe(true);
    expect(nativeFlags.has("--no-env-file")).toBe(true);

    const workflows = join(ROOT, ".github", "workflows");
    let checkedInvocations = 0;
    for (const file of new Bun.Glob("*.{yml,yaml}").scanSync({
      cwd: workflows,
      onlyFiles: true,
    })) {
      const text = await Bun.file(join(workflows, file)).text();
      for (const invocation of text.matchAll(/\bbun\s+install\b([^\n]*)/g)) {
        checkedInvocations += 1;
        for (const flag of (invocation[1] ?? "").matchAll(
          /(?:^|\s)(--[a-z][a-z-]*)/g,
        )) {
          expect(nativeFlags.has(flag[1] ?? "")).toBe(true);
        }
      }
    }
    expect(checkedInvocations).toBeGreaterThan(0);
  });

  test("the cited Bun.XML call sites still exist", async () => {
    expect(await read("src/lib/xml_ingest_preflight.ts")).toContain(
      "Bun.XML.parse",
    );

    const xmlCli = await read("packages/sportsdesk-ops/src/bin/xml-parse.ts");
    expect(xmlCli).toContain('import { XML } from "bun"');
    expect(xmlCli).toContain("XML.stringify");
    expect(xmlCli).toContain("ERR_DOD_CSR_CONSERVATION_BREACH");

    expect(await read("services/sportsdesk_webview_server.ts")).toContain(
      '"/api/parse-xml"',
    );
    expect(await read("scripts/generate_openapi.ts")).toContain(
      "Bun.XML.parse",
    );
  });

  test("the bun x rows resolve to declared bins with existing targets", async () => {
    const pkg = await readJson<{ bin?: Record<string, string> }>(
      "packages/sportsdesk-ops/package.json",
    );
    const expected = {
      "xml-parse": "./bin/xml-parse.ts",
      "sportsdesk-catalog": "./bin/sportsdesk-catalog.ts",
    } as const;
    for (const [bin, target] of Object.entries(expected)) {
      expect(pkg.bin?.[bin]).toBe(target);
      expect(
        await Bun.file(join(ROOT, "packages/sportsdesk-ops", target)).exists(),
      ).toBe(true);
    }

    const readme = await read("cli/README.md");
    expect(readme).toContain("`bun x xml-parse`");
    expect(readme).toContain("`bun x sportsdesk-catalog`");
  });

  test("every workspace catalog: reference resolves in the root catalog", async () => {
    const rootPkg = await readJson<{ catalog?: Record<string, string> }>(
      "package.json",
    );
    const catalog = rootPkg.catalog ?? {};
    let references = 0;

    for (const dir of WORKSPACE_DIRS) {
      const manifest = await readJson<
        Partial<
          Record<(typeof DEPENDENCY_GROUPS)[number], Record<string, string>>
        >
      >(`${dir}/package.json`);
      for (const group of DEPENDENCY_GROUPS) {
        for (const [name, range] of Object.entries(manifest[group] ?? {})) {
          if (range !== "catalog:") continue;
          references += 1;
          expect(typeof catalog[name]).toBe("string");
        }
      }
    }

    expect(references).toBeGreaterThan(0);
    for (const name of Object.keys(catalog)) {
      expect(catalog[name]?.length).toBeGreaterThan(0);
    }
  });

  test("the Yarn-migration catalog path is still inactive in this tree", async () => {
    for (const file of [".yarnrc.yml", "yarn.lock"]) {
      expect(await Bun.file(join(ROOT, file)).exists()).toBe(false);
    }
  });

  test("the docs baseline still marks XML documented", async () => {
    const baseline = await readJson<{
      shapes?: Record<string, { documented?: boolean }>;
    }>("tests/bun_docs_surface_baseline.json");
    expect(baseline.shapes?.XML?.documented).toBe(true);
  });

  test("documents named bun exports s3, $, and sql with verified repo paths", async () => {
    const behaviors = await readBunReleaseBehaviors(ROOT);
    const ids = new Set(behaviors.map((behavior) => behavior.id));
    for (const id of [
      "bun-s3-globals",
      "bun-shell-globals",
      "bun-sql-globals",
    ]) {
      expect(ids.has(id)).toBe(true);
    }

    const doc = await read("docs/bun-upstream-reference.md");
    expect(doc).toContain("## Named `bun` exports: `s3`, `$`, and `sql`");

    const citedFiles = [
      "lib/r2_s3_client.ts",
      "lib/db.ts",
      "bin/sql-query.ts",
      "lib/f402_credentials_policy.ts",
      "scripts/compute_dump_lag.ts",
      "tests/bun_s3client_contract.test.ts",
      "tests/bun_shell_contract.test.ts",
      "tests/bun_sql_contract.test.ts",
    ] as const;

    for (const path of citedFiles) {
      expect(doc).toContain(path);
      expect(await Bun.file(join(ROOT, path)).exists()).toBe(true);
    }
  });
});
