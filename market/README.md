# Plugin market index (format 1)

Upstream contract: one **HTTPS URL** → one `index.json` → Discover lists bundles; **install** still uses Plugins → Installed / `plugin_manager`.

**Harness references (read before inventing fields):**

| Doc                                                                                                                                                                | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [User guide: Plugin indexes](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)                                         | Turn on Discover, HTTPS URL rules, trust model                                                    |
| [Agent Note: index format](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md) | Required fields, `author`, declared `category`, git `source`, `engines.dsh` + `includePrerelease` |
| [Agent Note: Discover](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md)         | Reader service, UI, install path                                                                  |
| [`@deepseek-ai/dsh-plugin-market`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/boot/plugin-market)                                        | `cacheTtlMs` default 10m, `refresh: true`, fetch limits                                           |

Machine layout: **`dsh-ops/notes/SPORTSDESK-MARKET.md`** (profiles, experimental bundle, validation).

## Copy style (Discover metadata)

**Title** — Title Case, 2–4 words. Acronyms uppercase (`UI`, `API`, `F402`); product fragments like `GSLive` as published. No trailing period.

**Description** — Sentence case, ends with a period, about 8–16 words. Structure: what it does · data it touches · behavior (`read-only`, `live`, `automated`). No filler adjectives.

**Publisher** — Format 1 field is **`author`**, not `publisher`. Use **`Sportsdesk Ops`** on every plugin row (Discover maps this to the publisher line). Never omit.

**Tags** — 2–6 lowercase kebab-case strings in `metadata.keywords`; lead with the word an operator would type in Discover search. Do not put `dsh-plugin` in keywords (renderer supplies bundle type).

**Labels** — Declare ids under index `metadata.labels` (`stable`, `beta`, `read-only`, `internal`), then attach 1–2 per plugin in `metadata.labels`. No `color` field in format 1 (title only).

**Category** — Declare ids under index `metadata.categories`, then set `metadata.category` on each plugin (`operations`, `security`, `ui`, `automation`). List order in `plugins[]` follows category: Operations → Security → UI → Automation.

**Version** — semver; `dist-tags.latest` must match a `versions[]` row.

Icons: optional `icon` URL when you have real assets; otherwise skip (generic placeholder is fine).

## Default (this machine)

Leave **Index sources** empty. Install from checkout:

```sh
dsh-harness plugin --profile desktop add "${CODE_ROOT}/sportsdesk-ops/dsh-plugin-security"
# …repeat per bundle, or use the profile package.json link: entries you already maintain
```

## Indexed bundles (five)

| `name` (npm)                        | `source.path`                  |
| ----------------------------------- | ------------------------------ |
| `dsh-plugin-sportsdesk-ops`         | `dsh-plugin`                   |
| `dsh-plugin-sportsdesk-security`    | `dsh-plugin-security`          |
| `dsh-plugin-sportsdesk-desk-status` | `dsh-plugin-ui`                |
| `dsh-plugin-sportsdesk-desk-panel`  | `dsh-plugin-sidebar`           |
| `dsh-plugin-watchlist-autobet`      | `dsh-plugin-watchlist-autobet` |

Four rows use the `dsh-plugin-sportsdesk-*` prefix; watchlist keeps its historical npm name (`dsh-plugin-watchlist-autobet`) — intentional, not a path typo.

`dsh-ops` (`dsh-official-watch`) is **not** listed — private `brendadeeznuts1111/dsh-ops`; use `link:` on the web profile.

## `engines.dsh`

Use **`>=0.2.0-0 <0.3.0-0`**. Harness install checks call `semver.satisfies` with **`includePrerelease: true`** ([`plugin-compatibility.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/plugin-compatibility.ts)).

The `-0` on each bound means “include prereleases of that bound’s lineage.” It is **not** what makes **`0.2.2-rc.1`** match — with `includePrerelease: true`, both plain and `-0` ranges accept that runtime today.

What `-0` changes (always with `includePrerelease: true`):

| Version      | `>=0.2.0 <0.3.0` | `>=0.2.0-0 <0.3.0-0`                             |
| ------------ | ---------------- | ------------------------------------------------ |
| `0.2.0-rc.1` | false            | **true** (admits prereleases of the lower bound) |
| `0.2.2-rc.1` | true             | true                                             |
| `0.3.0-rc.1` | **true**         | **false** (rejects next-minor prereleases)       |

`-0` is the semver idiom for “the whole **0.2.x** lineage including prereleases, and nothing from **0.3.x**.” The **upper** bound is the important guard: it stops a future **`0.3.0-rc.1`** harness from installing these bundles.

In ad-hoc scripts, still pass **`includePrerelease: true`** when comparing prerelease runtimes; without it, `semver.satisfies` can return false even when the range would match.

## Which URL Discover should use (catalog vs lockfile)

| Artifact                   | Role                                      | Immutability                                                 |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `market/index.json`        | **Catalog** — browse metadata in Discover | Moving target is fine; operators want “what’s available now” |
| `versions[].source.commit` | **Lockfile** — exact install payload      | Must stay pinned; CI checks `git cat-file`                   |

**Recommended (Option A):** set Discover **once** to `main`, gate merges with `bun run test:market-index`, cut `market-index-N` tags only for **audit** (“what was live at time T”), not as the live URL.

```text
https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/main/market/index.json
```

Until `market/` is merged to `main`, that URL returns **404** — use a tag or branch URL pre-merge, then switch Discover to `main` after merge.

**Tag-pinned URL (Option C)** — no manual updates only if the catalog rarely changes; every metadata bump needs a new tag **and** a Discover URL edit. Use when you deliberately want the catalog URL itself frozen (not required for install safety — `source.commit` already is).

```text
https://raw.githubusercontent.com/bw496915-cmyk/Sports-desk-ops/market-index-3/market/index.json
```

Never **move** a published `market-index-N` tag; cut `market-index-(N+1)` instead.

### Branch protection (Option A)

After CI exposes **Validate market index** on `main`, require it on merges:

```sh
gh api repos/bw496915-cmyk/Sports-desk-ops/branches/main/protection \
  --method PUT \
  -f required_status_checks[strict]=true \
  -f required_status_checks[checks][][context]='verify' \
  -F enforce_admins=false \
  -F required_pull_request_reviews[required_approving_review_count]=0 \
  -F restrictions=null
```

Adjust `context` to match the job name GitHub reports (repo → Actions → a green `main` run → check name). `sportsdesk-ops-ci` / job `verify` is the workflow to watch.

### Discover cache check (three layers)

| Layer                      | TTL / behavior                                                                                      | What operators do                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **raw.githubusercontent**  | `cache-control: max-age=300` (~5 min)                                                               | `curl` after push may lag                                              |
| **Harness `pluginMarket`** | Default **`cacheTtlMs: 600000` (10 min)** per index URL in memory; concurrent reads share one fetch | Discover toolbar **Refresh** passes `refresh: true` and bypasses cache |
| **Profile settings**       | Index **URL list** persisted (`settings.update` on profile entry); not the JSON body                | Change URL only when switching sources                                 |

Upstream: `@deepseek-ai/dsh-plugin-market` `search(url, { refresh: true })` refetches; failed reads keep the last good listing until Retry. `plugin-market/changed` (e.g. index URL list edit) invalidates removed sources. Detail/README reads use the same TTL unless the entry page Retry sets `refresh`.

**Option A still works:** moving `main` does not require a new Discover URL — after CDN + up to 10 min (or **Refresh**), cards show the new metadata. Install specs still come from the row's `source.commit`, unchanged until you bump the index pin.

### Install path (why catalog immutability is optional)

Discover **Install** calls `marketInstallTarget(name, version)` → for git:

`git+https://github.com/.../Sports-desk-ops.git#<40-hex-commit>&path:/dsh-plugin-ui`

Harness **`plugin_manager`** clones that **commit**, not the index URL. Compatibility uses `engines.dsh` vs runtime with `includePrerelease: true` (`evaluatePluginCompatibility`). The index is only how operators **find** the pin; changing catalog text does not change installed bytes.

## Publish checklist

1. Branch → `bun run test:market-index` green.
2. Merge to `main` (with protection when enabled).
3. `curl -sI …/main/market/index.json` → **200**.
4. Discover: **`main` URL** (one-time), or tag URL until step 2 is done.
5. Optional audit: `git tag market-index-N <merge-commit> && git push origin market-index-N` (do not retag old `market-index-*`).

GitHub raw may cache for a few minutes after push. Body is usually served as `text/plain`; Discover parses JSON from the body.

## Squash-merge and plugin `source.commit` pins

Each row pins bundle source to a git commit (today `4f847435…`). If that commit exists **only** on a feature branch and the PR is **squash-merged**, the original commits can become unreachable and `git fetch <sha>` for installs breaks — even though `raw.githubusercontent.com/<sha>/…` may still work briefly.

**Never squash-merge a PR that introduces or moves `source.commit` pins unless one of these is already true:**

1. Every pinned SHA is an **ancestor of `origin/main`** (`git merge-base --is-ancestor <sha> origin/main`), or
2. You pushed a **`market-pin-N` tag** on each pin SHA **before** merge (`git tag market-pin-N <sha> && git push origin market-pin-N`), or
3. You re-pin every row to the **post-merge `main` commit** (and bump `version` / `publishTimestamp`) in the same PR.

Do **not** delete published `market-pin-*` tags. Git installs use `git+<url>#<commit>`; tags are the lifeboat when squash-merge drops branch commits.

Before merge:

```sh
git merge-base --is-ancestor 4f84743536a4de78a8ff81e09e00a8228ae09be6 origin/main && echo safe || echo orphan-risk
```

- **safe** — pin is already on `main`; any merge strategy is fine.
- **orphan-risk** — tag the pin (**`market-pin-1`** today), merge, or re-pin to squash commit on `main`.

`market-index-N` tags protect the **catalog JSON** for audit; `market-pin-N` tags protect **installable bundle source** SHAs.

## Bump procedure

1. `git diff --stat <commit>..HEAD -- <path>` empty per plugin, or re-pin `source.commit`.
2. Update `version`, `publishTimestamp`, and `source.commit` for changed rows.
3. Commit, push, curl the branch (or SHA) raw URL for **200**, then merge; run `bun test tests/market_index.test.ts` (set `MARKET_INDEX_HARNESS` or `DSH_HARNESS_ROOT`).

## CI / local validation (two steps)

Validation runs the **exact published validator that install uses** — same package (`@deepseek-ai/dsh-plugin-market-index`), same version (`0.2.2-rc.1` exact in `package.json` devDependencies, no caret), same `includePrerelease: true` semver path as harness install checks. Do not “simplify” this back to a harness source clone without reinstalling the monorepo.

| Step                              | What                                                                                                              | Guarantees                                                                                                                                                          | Failure means                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Validate market index**         | `bun install` → `bun test tests/market_index.test.ts` using npm `@deepseek-ai/dsh-plugin-market-index@0.2.2-rc.1` | `index.json` is valid for the harness you ship                                                                                                                      | Index format, pins, or `engines.dsh` wrong |
| **Audit validator pin** (CI only) | Shallow clone `deepseek-harness` at `HARNESS_VALIDATOR_SHA`, set `MARKET_INDEX_HARNESS`                           | The pinned SHA is real and matches the shipped release (root `package.json` version; internal `plugin-market-index` version may diverge in future harness releases) | Pin drifted or SHA unreachable             |

GitHub Actions uses **`fetch-depth: 0`** on this repo so `git cat-file -e <pin>^{commit}` still works after `main` advances past older index pins.

Local (validation only — no audit unless you set `MARKET_INDEX_HARNESS` + `HARNESS_VALIDATOR_SHA`):

```sh
bun install --frozen-lockfile
bun run test:market-index
```

`bun run test:market-index` sets `REQUIRE_MARKET_INDEX=1` so a missing validator install is **red**, not skipped. The full suite omits that flag and skips when `node_modules` is absent (`describe.skipIf`).

CI: job **`market-index`** (`bun run test:market-index`) is the **required** status on `main` for catalog changes. Job **`verify`** is the full repo gate (may be red on unrelated debt).

**Git install pins:** `market/index.json` `source.commit` is the installable tree. After squash
merges, tag **`market-pin-N`** on that commit before bumping the pin in the index so the SHA stays
fetchable. **`repoPath`** is required in bundle config for market-only git installs (see
`market/PLUGIN-AUDIT.md`).

Asserts: `parseMarketIndex`, reachable commits, `path/package.json` names, `dist-tags.latest`, every plugin’s `engines.dsh` matches the canonical range read from `market/index.json` (drift messages name plugin, version, and both ranges), vs **`0.2.2-rc.1`** / `0.2.2`, plus boundary rows on that range (`0.2.0-rc.1` in, `0.3.0-rc.1` out).
