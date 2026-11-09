/**
 * Plugin market index.json — format, git pins, and engines.dsh vs prerelease harness.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INDEX_PATH = join(ROOT, "market/index.json");
const INDEX_URL =
  "https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/main/market/index.json";

const HARNESS_ROOT =
  Bun.env.MARKET_INDEX_HARNESS ??
  Bun.env.DSH_HARNESS_ROOT ??
  Bun.env.DSH_HARNESS_WEB_ROOT ??
  join(Bun.env.HOME ?? "", "code/deepseek-harness-web");

const PUBLISHED_PARSER_PKG = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-plugin-market-index/package.json",
);
const PUBLISHED_PARSER_ENTRY = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js",
);

const HARNESS_RUNTIME = "0.2.2-rc.1";
const RUNTIME_CANDIDATES = [HARNESS_RUNTIME, "0.2.2"] as const;

const EXPECTED_PATHS: Record<string, string> = {
  "dsh-plugin-sportsdesk-ops": "dsh-plugin",
  "dsh-plugin-sportsdesk-security": "dsh-plugin-security",
  "dsh-plugin-sportsdesk-desk-status": "dsh-plugin-ui",
  "dsh-plugin-sportsdesk-desk-panel": "dsh-plugin-sidebar",
  "dsh-plugin-watchlist-autobet": "dsh-plugin-watchlist-autobet",
};

const REPO_WEB = "https://github.com/bw496915-cmyk/Sports-desk-ops";

async function indexGitPin(): Promise<string> {
  const raw = await loadRawIndex();
  const commit = raw.plugins[0]?.versions[0]?.source?.commit;
  expect(commit, "index.json: plugins[0].versions[0].source.commit").toBeDefined();
  return commit!;
}

/** Leading keyword = primary Discover search term for that card. */
const SEARCH_LEADING_KEYWORD: Record<string, string> = {
  "dsh-plugin-sportsdesk-ops": "status",
  "dsh-plugin-sportsdesk-security": "security",
  "dsh-plugin-sportsdesk-desk-status": "status",
  "dsh-plugin-sportsdesk-desk-panel": "sidebar",
  "dsh-plugin-watchlist-autobet": "autobet",
};

type RawIndex = {
  description?: { en?: string };
  metadata?: {
    categories?: Record<string, unknown>;
    labels?: Record<string, unknown>;
  };
  plugins: Array<{
    name: string;
    title?: { en?: string };
    author?: string;
    description?: { en?: string };
    homepage?: string;
    repository?: { url?: string; directory?: string };
    metadata?: {
      category?: string;
      keywords?: string[];
      labels?: string[];
    };
    "dist-tags"?: { latest?: string };
    versions: Array<{
      version: string;
      engines?: { dsh?: string };
      source?: { commit?: string };
    }>;
  }>;
};

async function loadRawIndex(): Promise<RawIndex> {
  return (await Bun.file(INDEX_PATH).json()) as RawIndex;
}

/** Canonical range = first row; every plugin version must match (not per-plugin ranges). */
function enginesRangeFromIndex(raw: RawIndex): string {
  const first = raw.plugins[0]?.versions[0]?.engines?.dsh;
  expect(first, "index.json: first engines.dsh").toBeDefined();
  return first!;
}

type ParsedMarketIndex = {
  plugins: Array<{
    name: string;
    versions: Array<{
      version: string;
      engines?: { dsh?: string };
      source?: { commit: string; path?: string };
    }>;
  }>;
};

type SemverLike = {
  satisfies: (
    version: string,
    range: string,
    options?: { includePrerelease?: boolean },
  ) => boolean;
};

async function harnessCheckoutValid(): Promise<boolean> {
  if (!Bun.env.MARKET_INDEX_HARNESS) return true;

  const rootPkgPath = join(HARNESS_ROOT, "package.json");
  const marketPkgPath = join(
    HARNESS_ROOT,
    "packages/util/plugin-market-index/package.json",
  );
  if (!existsSync(rootPkgPath) || !existsSync(marketPkgPath)) return false;

  const rootPkg = (await Bun.file(rootPkgPath).json()) as {
    version?: string;
  };
  const marketPkg = (await Bun.file(marketPkgPath).json()) as {
    version?: string;
  };
  // Root version is authoritative; internal package version may diverge in future harness releases.
  if (rootPkg.version !== HARNESS_RUNTIME) {
    return false;
  }
  if (marketPkg.version && marketPkg.version !== HARNESS_RUNTIME) {
    return false;
  }

  const expectedHead = Bun.env.HARNESS_VALIDATOR_SHA;
  if (!expectedHead) return true;

  const head = Bun.spawnSync(["git", "-C", HARNESS_ROOT, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (head.exitCode !== 0) return false;
  return head.stdout.toString().trim() === expectedHead;
}

async function publishedValidatorReady(): Promise<boolean> {
  if (
    !existsSync(PUBLISHED_PARSER_ENTRY) ||
    !existsSync(PUBLISHED_PARSER_PKG)
  ) {
    return false;
  }
  const pkg = (await Bun.file(PUBLISHED_PARSER_PKG).json()) as {
    version?: string;
  };
  return pkg.version === HARNESS_RUNTIME;
}

function marketIndexTestsReady(): boolean {
  if (
    !existsSync(PUBLISHED_PARSER_ENTRY) ||
    !existsSync(PUBLISHED_PARSER_PKG)
  ) {
    return false;
  }
  if (!Bun.env.MARKET_INDEX_HARNESS) return true;
  const rootPkgPath = join(HARNESS_ROOT, "package.json");
  const marketPkgPath = join(
    HARNESS_ROOT,
    "packages/util/plugin-market-index/package.json",
  );
  return existsSync(rootPkgPath) && existsSync(marketPkgPath);
}

async function loadParser() {
  if (!existsSync(PUBLISHED_PARSER_ENTRY)) {
    throw new Error(
      `Missing ${PUBLISHED_PARSER_ENTRY}; run bun install (devDependency @deepseek-ai/dsh-plugin-market-index)`,
    );
  }
  const mod = await import("@deepseek-ai/dsh-plugin-market-index");
  return mod as unknown as {
    parseMarketIndex: (raw: unknown, url: string) => ParsedMarketIndex;
  };
}

function loadSemver(): SemverLike {
  const req = createRequire(join(ROOT, "package.json"));
  return req("semver") as SemverLike;
}

const REQUIRE_MARKET_INDEX = Bun.env.REQUIRE_MARKET_INDEX === "1";

test("published validator installed (REQUIRE_MARKET_INDEX)", async () => {
  if (!REQUIRE_MARKET_INDEX) return;
  expect(await publishedValidatorReady()).toBe(true);
});

describe.skipIf(!marketIndexTestsReady() && !REQUIRE_MARKET_INDEX)(
  "market/index.json",
  () => {
    test("harness validator checkout matches pin when MARKET_INDEX_HARNESS is set", async () => {
      if (!Bun.env.MARKET_INDEX_HARNESS) return;
      expect(await harnessCheckoutValid()).toBe(true);
    });

    test("parseMarketIndex accepts the document", async () => {
      const { parseMarketIndex } = await loadParser();
      const raw = await loadRawIndex();
      const doc = parseMarketIndex(raw, INDEX_URL);
      expect(doc.plugins).toHaveLength(Object.keys(EXPECTED_PATHS).length);
    });

    test("every plugin has author and localized description for Discover", async () => {
      const raw = await loadRawIndex();
      for (const plugin of raw.plugins) {
        expect(plugin.author, `${plugin.name}: author`).toBe("Sportsdesk Ops");
        const desc = plugin.description?.en;
        expect(desc, `${plugin.name}: description.en`).toBeDefined();
        expect(
          desc!.length,
          `${plugin.name}: description length`,
        ).toBeGreaterThanOrEqual(40);
        expect(
          desc!.length,
          `${plugin.name}: description length`,
        ).toBeLessThanOrEqual(200);
        expect(desc!.endsWith("."), `${plugin.name}: description period`).toBe(
          true,
        );
      }
    });

    test("catalog meta: root copy, keywords, labels, categories, homepages", async () => {
      const pin = await indexGitPin();
      const raw = await loadRawIndex();
      expect(raw.description?.en?.length ?? 0).toBeGreaterThan(20);
      const declaredLabels = Object.keys(raw.metadata?.labels ?? {});
      expect(declaredLabels.length).toBeGreaterThanOrEqual(4);
      const declaredCategories = Object.keys(raw.metadata?.categories ?? {});
      for (const [id, decl] of Object.entries(raw.metadata?.categories ?? {})) {
        const title = (decl as { title?: { en?: string } }).title?.en;
        expect(title, `metadata.categories.${id}.title.en`).toBeTruthy();
      }
      for (const [id, decl] of Object.entries(raw.metadata?.labels ?? {})) {
        const title = (decl as { title?: { en?: string } }).title?.en;
        expect(title, `metadata.labels.${id}.title.en`).toBeTruthy();
      }
      for (const plugin of raw.plugins) {
        expect(
          (plugin.title?.en?.length ?? 0) > 0,
          `${plugin.name}: title.en`,
        ).toBe(true);
        const keywords = plugin.metadata?.keywords ?? [];
        expect(
          keywords.length,
          `${plugin.name}: keywords`,
        ).toBeGreaterThanOrEqual(2);
        expect(keywords.length, `${plugin.name}: keywords`).toBeLessThanOrEqual(
          6,
        );
        expect(
          keywords.every((k) => k === k.toLowerCase() && !k.includes(" ")),
          `${plugin.name}: keyword shape`,
        ).toBe(true);
        const lead = SEARCH_LEADING_KEYWORD[plugin.name];
        expect(lead, `${plugin.name}: search keyword map`).toBeDefined();
        expect(keywords[0], `${plugin.name}: leading keyword`).toBe(lead);
        const usedLabels = plugin.metadata?.labels ?? [];
        expect(
          usedLabels.length,
          `${plugin.name}: labels`,
        ).toBeGreaterThanOrEqual(1);
        for (const label of usedLabels) {
          expect(declaredLabels, `${plugin.name}: label ${label}`).toContain(
            label,
          );
          expect(label, `${plugin.name}: dsh-plugin label`).not.toBe(
            "dsh-plugin",
          );
        }
        const category = plugin.metadata?.category;
        expect(category, `${plugin.name}: category`).toBeDefined();
        expect(
          declaredCategories,
          `${plugin.name}: category declared`,
        ).toContain(category!);
        const bundlePath = EXPECTED_PATHS[plugin.name]!;
        expect(plugin.homepage, `${plugin.name}: homepage`).toBe(
          `${REPO_WEB}/tree/${pin}/${bundlePath}`,
        );
        const repo = plugin.repository;
        expect(repo?.url, `${plugin.name}: repository.url`).toBe(REPO_WEB);
        expect(repo?.directory, `${plugin.name}: repository.directory`).toBe(
          bundlePath,
        );
      }
    });

    test("dist-tags.latest matches a versions[] row per plugin", async () => {
      const raw = await loadRawIndex();
      for (const plugin of raw.plugins) {
        const latest = plugin["dist-tags"]?.latest;
        expect(latest, `${plugin.name}: dist-tags.latest`).toBeDefined();
        expect(
          plugin.versions.some((v) => v.version === latest),
          `${plugin.name}: latest tag missing from versions[]`,
        ).toBe(true);
      }
    });

    test("every indexed bundle matches name, path, and commit in git", async () => {
      const { parseMarketIndex } = await loadParser();
      const raw = await loadRawIndex();
      const doc = parseMarketIndex(raw, INDEX_URL);

      for (const plugin of doc.plugins) {
        const bundlePath = EXPECTED_PATHS[plugin.name];
        expect(
          bundlePath,
          `unexpected plugin name ${plugin.name}`,
        ).toBeDefined();
        const rawPlugin = raw.plugins.find((p) => p.name === plugin.name)!;
        const latest = rawPlugin["dist-tags"]!.latest!;
        const row = plugin.versions.find(
          (ver: ParsedMarketIndex["plugins"][number]["versions"][number]) =>
            ver.version === latest,
        );
        expect(
          row,
          `${plugin.name}: no version row for ${latest}`,
        ).toBeDefined();
        const { commit, path: srcPath } = row!.source ?? {
          commit: "",
          path: ".",
        };
        expect(commit, `${plugin.name}: source.commit`).not.toBe("");
        expect(srcPath ?? ".", `${plugin.name} path`).toBe(bundlePath!);

        const tree = Bun.spawnSync(
          ["git", "cat-file", "-e", `${commit}^{commit}`],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        );
        expect(tree.exitCode, `commit ${commit} missing in repo`).toBe(0);

        const pathCheck = Bun.spawnSync(
          ["git", "cat-file", "-e", `${commit}:${bundlePath!}/package.json`],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        );
        expect(
          pathCheck.exitCode,
          `${commit}:${bundlePath!}/package.json`,
        ).toBe(0);

        const pkgText = Bun.spawnSync(
          ["git", "show", `${commit}:${bundlePath!}/package.json`],
          { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
        );
        expect(pkgText.exitCode).toBe(0);
        const pkg = JSON.parse(pkgText.stdout.toString()) as { name?: string };
        expect(pkg.name).toBe(plugin.name);
      }
    });

    test("engines.dsh satisfies harness install check (includePrerelease)", async () => {
      const semver = loadSemver();
      const { parseMarketIndex } = await loadParser();
      const raw = await loadRawIndex();
      const doc = parseMarketIndex(raw, INDEX_URL);
      const canonicalRange = enginesRangeFromIndex(raw);

      for (const plugin of doc.plugins) {
        for (const ver of plugin.versions) {
          const range = ver.engines?.dsh;
          expect(range, `${plugin.name}: engines.dsh`).toBeDefined();
          expect(
            range === canonicalRange,
            `${plugin.name}@${ver.version} engines.dsh "${range}" != canonical "${canonicalRange}"`,
          ).toBe(true);
        }
      }

      const opts = { includePrerelease: true } as const;
      expect(
        semver.satisfies(HARNESS_RUNTIME, canonicalRange, opts),
        `${HARNESS_RUNTIME} vs index engines.dsh`,
      ).toBe(true);

      for (const runtime of RUNTIME_CANDIDATES) {
        for (const plugin of doc.plugins) {
          for (const ver of plugin.versions) {
            const range = ver.engines?.dsh;
            expect(range, `${plugin.name}: engines.dsh`).toBeDefined();
            expect(
              semver.satisfies(runtime, range!, opts),
              `${plugin.name}@${ver.version} vs ${runtime}`,
            ).toBe(true);
          }
        }
      }

      expect(
        semver.satisfies("0.2.0-rc.1", canonicalRange, opts),
        "lower-bound prereleases in 0.2.x lineage",
      ).toBe(true);
      expect(
        semver.satisfies("0.3.0-rc.1", canonicalRange, opts),
        "reject next-minor prereleases",
      ).toBe(false);
    });
  },
);
