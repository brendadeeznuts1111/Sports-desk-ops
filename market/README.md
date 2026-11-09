# Plugin market index (format 1)

Upstream contract: one **HTTPS URL** → one `index.json` → Discover lists bundles; **install** still uses Plugins → Installed / `plugin_manager`.

## Default (this machine)

Leave **Index sources** empty. Install from checkout:

```sh
dsh-harness plugin --profile desktop add "${CODE_ROOT}/sportsdesk-ops/dsh-plugin-security"
# …repeat per bundle, or use the profile package.json link: entries you already maintain
```

## Indexed bundles (five)

| `name` (npm) | `source.path` |
|---|---|
| `dsh-plugin-sportsdesk-ops` | `dsh-plugin` |
| `dsh-plugin-sportsdesk-security` | `dsh-plugin-security` |
| `dsh-plugin-sportsdesk-desk-status` | `dsh-plugin-ui` |
| `dsh-plugin-sportsdesk-desk-panel` | `dsh-plugin-sidebar` |
| `dsh-plugin-watchlist-autobet` | `dsh-plugin-watchlist-autobet` |

Four rows use the `dsh-plugin-sportsdesk-*` prefix; watchlist keeps its historical npm name (`dsh-plugin-watchlist-autobet`) — intentional, not a path typo.

`dsh-ops` (`dsh-official-watch`) is **not** listed — private `brendadeeznuts1111/dsh-ops`; use `link:` on the web profile.

## `engines.dsh`

Use **`>=0.2.0-0 <0.3.0-0`**. Harness install checks call `semver.satisfies` with **`includePrerelease: true`** ([`plugin-compatibility.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/plugin-compatibility.ts)).

The `-0` on each bound means “include prereleases of that bound’s lineage.” It is **not** what makes **`0.2.2-rc.1`** match — with `includePrerelease: true`, both plain and `-0` ranges accept that runtime today.

What `-0` changes (always with `includePrerelease: true`):

| Version | `>=0.2.0 <0.3.0` | `>=0.2.0-0 <0.3.0-0` |
|---|---|---|
| `0.2.0-rc.1` | false | **true** (admits prereleases of the lower bound) |
| `0.2.2-rc.1` | true | true |
| `0.3.0-rc.1` | **true** | **false** (rejects next-minor prereleases) |

`-0` is the semver idiom for “the whole **0.2.x** lineage including prereleases, and nothing from **0.3.x**.” The **upper** bound is the important guard: it stops a future **`0.3.0-rc.1`** harness from installing these bundles.

In ad-hoc scripts, still pass **`includePrerelease: true`** when comparing prerelease runtimes; without it, `semver.satisfies` can return false even when the range would match.

## Publish before pasting Index sources

Repo **`bw496915-cmyk/Sports-desk-ops` is public**, but raw `market/index.json` must exist **on the ref in the URL**. Until `market/` is **committed and pushed**, every raw URL returns **404** (same symptom as a private repo).

**Sequence:** `git add market/ && git commit` on your branch → push → verify **branch** URL → merge to `main` (or keep a commit-pinned URL).

Unauthenticated check on the branch **before** merge (example):

```sh
curl -sI "https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/fix/p0-status-correctness-and-monitoring/market/index.json" | head -1
```

After merge to `main`:

```sh
curl -sI "https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/main/market/index.json" | head -1
```

**Index sources** (branch-tracking):

```text
https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/main/market/index.json
```

**Commit-pinned index** — use a **git tag** on the index commit so squash-merge does not GC the object (branch-only SHAs 404 eventually):

Cut a **new** tag on every index bump (`market-index-2`, `market-index-3`, …). **Never move a published index tag** — immutability is the point; moving a tag can leave raw.githubusercontent serving a stale body briefly. Point **Discover** at the latest tag URL, not a branch-only SHA (squash-merge can GC those objects). Raw SHA URLs are fine for **pre-merge** curl checks only.

Current Discover URL:

```text
https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/market-index-2/market/index.json
```

GitHub raw may cache for a few minutes after push. Body is usually served as `text/plain`; Discover parses JSON from the body.

## Squash-merge and plugin `source.commit` pins

Each row pins bundle source to a git commit (today `4f847435…`). If that commit exists **only** on a feature branch and the PR is **squash-merged**, the original commits can become unreachable and `git fetch <sha>` for installs breaks — even though `raw.githubusercontent.com/<sha>/…` may still work briefly.

Before merge:

```sh
git merge-base --is-ancestor 4f84743536a4de78a8ff81e09e00a8228ae09be6 origin/main && echo safe || echo orphan-risk
```

- **safe** — pin is already on `main`; any merge strategy is fine.
- **orphan-risk** — use a real merge commit, **or** tag the pin (`git tag market-pin-1 4f84743536a4de78a8ff81e09e00a8228ae09be6 && git push origin market-pin-1`), **or** re-pin `source.commit` to the post-merge `main` SHA and bump `publishTimestamp`.

Tagging is cheap insurance for SHA-pinned Discover URLs and for DSH git installs.

## Bump procedure

1. `git diff --stat <commit>..HEAD -- <path>` empty per plugin, or re-pin `source.commit`.
2. Update `version`, `publishTimestamp`, and `source.commit` for changed rows.
3. Commit, push, curl the branch (or SHA) raw URL for **200**, then merge; run `bun test tests/market_index.test.ts` (set `MARKET_INDEX_HARNESS` or `DSH_HARNESS_ROOT`).

## CI / local validation (two steps)

Validation runs the **exact published validator that install uses** — same package (`@deepseek-ai/dsh-plugin-market-index`), same version (`0.2.2-rc.1` exact in `package.json` devDependencies, no caret), same `includePrerelease: true` semver path as harness install checks. Do not “simplify” this back to a harness source clone without reinstalling the monorepo.

| Step | What | Guarantees | Failure means |
|---|---|---|---|
| **Validate market index** | `bun install` → `bun test tests/market_index.test.ts` using npm `@deepseek-ai/dsh-plugin-market-index@0.2.2-rc.1` | `index.json` is valid for the harness you ship | Index format, pins, or `engines.dsh` wrong |
| **Audit validator pin** (CI only) | Shallow clone `deepseek-harness` at `HARNESS_VALIDATOR_SHA`, set `MARKET_INDEX_HARNESS` | The pinned SHA is real and matches the shipped release (root `package.json` version; internal `plugin-market-index` version may diverge in future harness releases) | Pin drifted or SHA unreachable |

GitHub Actions uses **`fetch-depth: 0`** on this repo so `git cat-file -e <pin>^{commit}` still works after `main` advances past older index pins.

Local (validation only — no audit unless you set `MARKET_INDEX_HARNESS` + `HARNESS_VALIDATOR_SHA`):

```sh
bun install --frozen-lockfile
bun run test:market-index
```

`bun run test:market-index` sets `REQUIRE_MARKET_INDEX=1` so a missing validator install is **red**, not skipped. The full suite omits that flag and skips when `node_modules` is absent (`describe.skipIf`).

CI job names: **Audit harness validator pin** → **Validate market index** (`bun run test:market-index`).

Asserts: `parseMarketIndex`, reachable commits, `path/package.json` names, `dist-tags.latest`, every plugin’s `engines.dsh` matches the canonical range read from `market/index.json` (drift messages name plugin, version, and both ranges), vs **`0.2.2-rc.1`** / `0.2.2`, plus boundary rows on that range (`0.2.0-rc.1` in, `0.3.0-rc.1` out).
