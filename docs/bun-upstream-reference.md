# Bun docs (upstream)

When to trust oven-sh/bun docs vs this repo. Evidence labels here beat upstream prose.

## Runtime (behavior SSOT)

| What | Where |
| ---- | ----- |
| Release | [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (2026-10-22) |
| Commit | `38afee6c84fcf48c0edb2466aa4b27d287a59c30` |
| This repo | `package.json` `packageManager` / `engines`, `@types/bun@1.4.4` |
| After upgrade | `bun run probe:bun` vs `tests/bun_baseline.json` |

## Type declarations

Two different things:

| Layer | What | This repo |
| ----- | ---- | --------- |
| Project types | `@types/bun` → `bun-types` on npm | `devDependencies` `@types/bun@1.4.4`; must match `Bun.version` (`bin/bun_surface --strict`) |
| Embedded in the Bun binary | `@types/node`, `undici-types`, plus types pulled in via `bun-types` (`expect-type`, `jest-mock`) | Used when you `bun build --compile --aot` without installing `@types/bun`; not a substitute for day-to-day `bun check` here |

Legal list and licenses: [project/license → type declarations](https://bun.com/docs/project/license#type-declarations). Prod dependency audit: regenerate root `licenses.json` per `.gitignore` comment (`bun pm licenses --prod --json`).

## JavaScriptCore (Bun engine builds only)

Bun is MIT. The runtime **statically links** JavaScriptCore/WebKit (LGPL-2), so distributors who modify that stack must offer a relink path. Fork: [github.com/oven-sh/WebKit](https://github.com/oven-sh/WebKit) (docs also spell the URL `oven-sh/webkit`; GitHub treats it as the same repo).

| Step | Command |
| ---- | ------- |
| Clone fork | `git clone https://github.com/oven-sh/WebKit vendor/WebKit` |
| Match Bun’s pin | `bun sync-webkit-source` (`WEBKIT_VERSION` in `scripts/build/deps/webkit.ts`) |
| Relink binary | `bun run build:local` |

Full context: [project/license → JavaScriptCore](https://bun.com/docs/project/license#javascriptcore). **sportsdesk-ops** consumes the official [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) binary; this section applies only if you patch Bun/JSC upstream.

## `bun install`

Reference: [pm/cli/install](https://bun.com/docs/pm/cli/install).

**Default behavior (upstream).** Installs `dependencies`, `devDependencies`, `optionalDependencies`, and peers; writes text `bun.lock`; runs the **root** `{pre|post}install` and `{pre|post}prepare` scripts. Dependency lifecycle scripts run only for names in `trustedDependencies` (Bun also has built-in postinstall shortcuts for some native packages — see [lifecycle](https://bun.com/docs/pm/lifecycle)).

**Config load order.** Bun merges `$XDG_CONFIG_HOME/.bunfig.toml` or `$HOME/.bunfig.toml` with `./bunfig.toml`; project keys override global **when both set the same key**. Here, `[install]` linker / store / cache / `frozenLockfile` / `minimumReleaseAge` are **machine-only** — see `lib/pm_policy.ts` and comments in `bunfig.toml`.

| Topic | Upstream | This repo |
| ----- | -------- | --------- |
| Reproducible install | `--frozen-lockfile`, `bun ci`, or pnpm `--immutable`; **not** enabled automatically in CI | `.github/workflows/ci.yml`, README: `bun install --frozen-lockfile`; `ci:local --install` |
| Lock vs manifest | Adds/removes/version bumps fail frozen and name the first drift; range-only edits, dependency group moves, workspace `version`/`bin`/`scripts`, `trustedDependencies`, and `patchedDependencies` can still pass | `pm:doctor` still flags workspace **version** and **patch** drift in `bun.lock`; run `bun-deps install` and commit the lock |
| Validate lock only | `bun install --frozen-lockfile --dry-run` (no `node_modules`, no root lifecycle) | Same flags when debugging CI install failures |
| Changing deps | `bun add` / `remove` / `update` | Global `install.frozenLockfile = true` → `bun-deps` / `bun run deps` (`AGENTS.md`) |
| Linker / supply chain | `hoisted` vs `isolated`; monorepos default toward isolated via lock `configVersion` | `pm:doctor` expects **isolated** linker on the machine config |
| Release age | `minimumReleaseAge` in bunfig or `--minimum-release-age` | Machine gate (typically 3 days); `pm:doctor` "release age gate" |
| Lockfile on disk | Commit `bun.lock`; Yarn/pnpm/`bun.lockb` migration when no `bun.lock` | Only `bun.lock` in git; foreign lockfiles fail policy tests |
| Trusted scripts | Opt-in list; pnpm migration can populate from `onlyBuiltDependencies` | `trustedDependencies: []` — no implicit upstream allow list (`tests/bun_config_policy.test.ts`) |

Workspaces, `--filter`, overrides, `packageExtensions`, offline/prefer-offline, and isolated layout: [workspaces](https://bun.com/docs/pm/workspaces), [filter](https://bun.com/docs/pm/filter), [overrides](https://bun.com/docs/pm/overrides), [isolated installs](https://bun.com/docs/pm/isolated-installs), [global cache](https://bun.com/docs/pm/global-cache).

## Live docs (check behavior on 1.4.4)

- Reference: [bun.com/docs](https://bun.com/docs)
- Walkthroughs: [bun.com/guides](https://bun.com/guides)
- PM topics that match this repo: [install](https://bun.com/docs/pm/cli/install), [workspaces](https://bun.com/docs/pm/workspaces), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs)

## Optional git pins (upstream doc PRs only)

Commits on `main` **after** 1.4.4. Navigation and voice, not runtime.

| Pin | Tree | Use |
| --- | ---- | --- |
| `6cdb3835` | [docs → contributing](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing) | MDX [voice](https://bun.com/docs/project/contributing#voice) |
| `6a380492` | [docs/snippets](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets) | `guides.jsx` (guide index), `cli/*.mdx` (CLI flag blocks) |

## Where to start

| You are changing… | Start here |
| ----------------- | ---------- |
| sportsdesk-ops | `AGENTS.md`, `bun run ci:local` |
| bun.com MDX | [contributing#voice](https://bun.com/docs/project/contributing#voice) |
| Bun engine (Rust/C++/JSC) | [CONTRIBUTING.md](https://github.com/oven-sh/bun?tab=contributing-ov-file) |
| Install policy in this repo | `AGENTS.md`, `lib/pm_policy.ts`, `bun run pm:doctor` |

## Related in this repo

- Eval one-liners: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md)

```sh
bun run pm:doctor
bun test tests/bun_config_policy.test.ts tests/pm_policy_workspaces.test.ts
```
