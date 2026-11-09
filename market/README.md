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

**Commit-pinned index** (recommended for operator Discover — reproducible; bump with releases):

```text
https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/<40-char-sha>/market/index.json
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

## CI / local validator

GitHub Actions uses **`actions/checkout@v4` with `fetch-depth: 0`** so `git cat-file -e <pin>^{commit}` still works after `main` advances past older index pins (shallow `fetch-depth: 1` would fail on the next bump, not because the pin is wrong).

```sh
export DSH_HARNESS_ROOT="${DSH_HARNESS_ROOT:-$HOME/code/deepseek-harness-web}"
bun test tests/market_index.test.ts
```

CI checks out **`deepseek-harness` at `HARNESS_VALIDATOR_REF`** (`dsh-v0.2.2-rc.1` in `.github/workflows/ci.yml`) and sets `MARKET_INDEX_HARNESS=.ci/deepseek-harness`. The full test suite skips this file when no harness checkout is on disk (`describe.skipIf`).

Asserts: `parseMarketIndex`, reachable commits, `path/package.json` names, `dist-tags.latest`, uniform `engines.dsh` from the index vs **`0.2.2-rc.1`** / `0.2.2`, plus boundary rows read from that same range (`0.2.0-rc.1` in, `0.3.0-rc.1` out).
