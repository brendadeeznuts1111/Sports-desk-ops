/**
 * Plugin market index.json — format, git pins, and engines.dsh vs prerelease harness.
 */
import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const INDEX_PATH = join(ROOT, "market/index.json")
const INDEX_URL = "https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/main/market/index.json"

const HARNESS_ROOT =
  process.env.MARKET_INDEX_HARNESS ??
  process.env.DSH_HARNESS_ROOT ??
  process.env.DSH_HARNESS_WEB_ROOT ??
  join(process.env.HOME ?? "", "code/deepseek-harness-web")

const MARKET_INDEX_PKG = join(
  HARNESS_ROOT,
  "packages/util/plugin-market-index/src/index.ts",
)

const HARNESS_RUNTIME = "0.2.2-rc.1"
const RUNTIME_CANDIDATES = [HARNESS_RUNTIME, "0.2.2"] as const

const EXPECTED_PATHS: Record<string, string> = {
  "dsh-plugin-sportsdesk-ops": "dsh-plugin",
  "dsh-plugin-sportsdesk-security": "dsh-plugin-security",
  "dsh-plugin-sportsdesk-desk-status": "dsh-plugin-ui",
  "dsh-plugin-sportsdesk-desk-panel": "dsh-plugin-sidebar",
  "dsh-plugin-watchlist-autobet": "dsh-plugin-watchlist-autobet",
}

type RawIndex = {
  plugins: Array<{
    name: string
    "dist-tags"?: { latest?: string }
    versions: Array<{
      version: string
      engines?: { dsh?: string }
    }>
  }>
}

function enginesRangeFromIndex(raw: RawIndex): string {
  const first = raw.plugins[0]?.versions[0]?.engines?.dsh
  expect(first, "index.json: first engines.dsh").toBeDefined()
  return first!
}

type ParsedMarketIndex = {
  plugins: Array<{
    name: string
    versions: Array<{
      version: string
      engines?: { dsh?: string }
      source?: { commit: string; path?: string }
    }>
  }>
}

type SemverLike = {
  satisfies: (
    version: string,
    range: string,
    options?: { includePrerelease?: boolean },
  ) => boolean
}

async function loadParser(): Promise<{
  parseMarketIndex: (raw: unknown, url: string) => ParsedMarketIndex
}> {
  if (!existsSync(MARKET_INDEX_PKG)) {
    throw new Error(
      `Missing ${MARKET_INDEX_PKG}; set MARKET_INDEX_HARNESS or DSH_HARNESS_ROOT to a deepseek-harness checkout`,
    )
  }
  return import(MARKET_INDEX_PKG)
}

function loadSemver(): SemverLike {
  const req = createRequire(MARKET_INDEX_PKG)
  return req("semver") as SemverLike
}

const harnessReady = existsSync(MARKET_INDEX_PKG)

describe.skipIf(!harnessReady)("market/index.json", () => {
  test("parseMarketIndex accepts the document", async () => {
    const { parseMarketIndex } = await loadParser()
    const raw = JSON.parse(await Bun.file(INDEX_PATH).text())
    const doc = parseMarketIndex(raw, INDEX_URL)
    expect(doc.plugins).toHaveLength(Object.keys(EXPECTED_PATHS).length)
  })

  test("dist-tags.latest matches a versions[] row per plugin", async () => {
    const raw = JSON.parse(await Bun.file(INDEX_PATH).text()) as RawIndex
    for (const plugin of raw.plugins) {
      const latest = plugin["dist-tags"]?.latest
      expect(latest, `${plugin.name}: dist-tags.latest`).toBeDefined()
      expect(
        plugin.versions.some((v) => v.version === latest),
        `${plugin.name}: latest tag missing from versions[]`,
      ).toBe(true)
    }
  })

  test("every indexed bundle matches name, path, and commit in git", async () => {
    const { parseMarketIndex } = await loadParser()
    const raw = JSON.parse(await Bun.file(INDEX_PATH).text())
    const doc = parseMarketIndex(raw, INDEX_URL)

    for (const plugin of doc.plugins) {
      const bundlePath = EXPECTED_PATHS[plugin.name]
      expect(bundlePath, `unexpected plugin name ${plugin.name}`).toBeDefined()
      const rawPlugin = (
        JSON.parse(await Bun.file(INDEX_PATH).text()) as RawIndex
      ).plugins.find((p) => p.name === plugin.name)!
      const latest = rawPlugin["dist-tags"]!.latest!
      const row = plugin.versions.find(
        (ver: ParsedMarketIndex["plugins"][number]["versions"][number]) =>
          ver.version === latest,
      )
      expect(row, `${plugin.name}: no version row for ${latest}`).toBeDefined()
      const { commit, path: srcPath } = row!.source ?? { commit: "", path: "." }
      expect(commit, `${plugin.name}: source.commit`).not.toBe("")
      expect(srcPath ?? ".", `${plugin.name} path`).toBe(bundlePath!)

      const tree = Bun.spawnSync(
        ["git", "cat-file", "-e", `${commit}^{commit}`],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      )
      expect(tree.exitCode, `commit ${commit} missing in repo`).toBe(0)

      const pathCheck = Bun.spawnSync(
        ["git", "cat-file", "-e", `${commit}:${bundlePath!}/package.json`],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      )
      expect(pathCheck.exitCode, `${commit}:${bundlePath!}/package.json`).toBe(0)

      const pkgText = Bun.spawnSync(
        ["git", "show", `${commit}:${bundlePath!}/package.json`],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      )
      expect(pkgText.exitCode).toBe(0)
      const pkg = JSON.parse(pkgText.stdout.toString()) as { name?: string }
      expect(pkg.name).toBe(plugin.name)
    }
  })

  test("engines.dsh satisfies harness install check (includePrerelease)", async () => {
    const semver = loadSemver()
    const { parseMarketIndex } = await loadParser()
    const raw = JSON.parse(await Bun.file(INDEX_PATH).text()) as RawIndex
    const doc = parseMarketIndex(raw, INDEX_URL)
    const canonicalRange = enginesRangeFromIndex(raw)

    for (const plugin of doc.plugins) {
      for (const ver of plugin.versions) {
        const range = ver.engines?.dsh
        expect(range, `${plugin.name}: engines.dsh`).toBeDefined()
        expect(range!, `${plugin.name}: engines.dsh drift`).toBe(canonicalRange)
      }
    }

    const opts = { includePrerelease: true } as const
    expect(
      semver.satisfies(HARNESS_RUNTIME, canonicalRange, opts),
      `${HARNESS_RUNTIME} vs index engines.dsh`,
    ).toBe(true)

    for (const runtime of RUNTIME_CANDIDATES) {
      for (const plugin of doc.plugins) {
        for (const ver of plugin.versions) {
          const range = ver.engines?.dsh
          expect(range, `${plugin.name}: engines.dsh`).toBeDefined()
          expect(
            semver.satisfies(runtime, range!, opts),
            `${plugin.name}@${ver.version} vs ${runtime}`,
          ).toBe(true)
        }
      }
    }

    expect(
      semver.satisfies("0.2.0-rc.1", canonicalRange, opts),
      "lower-bound prereleases in 0.2.x lineage",
    ).toBe(true)
    expect(
      semver.satisfies("0.3.0-rc.1", canonicalRange, opts),
      "reject next-minor prereleases",
    ).toBe(false)
  })
})
