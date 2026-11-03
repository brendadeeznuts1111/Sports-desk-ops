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

Upstream: [pm/cli/install](https://bun.com/docs/pm/cli/install). **Operational SSOT for this repo** (machine bunfig, `bun-deps`, lock traps, walkthroughs, test matrix, doctor catalog): **[runbooks/bun-pm-policy.md](./runbooks/bun-pm-policy.md)**.

Summary only:

| Upstream | sportsdesk-ops |
| -------- | -------------- |
| Reproducible install via `--frozen-lockfile` / `bun ci` | CI + README: `bun install --frozen-lockfile` |
| Dependency lifecycle via `trustedDependencies` | Root list pinned to **`[]`** (no default allow list) |
| Project + global `bunfig.toml` merge | **`[install]` machine keys only in global dotfiles** — not in repo `bunfig.toml` |
| Lockfile text `bun.lock` | Committed; `pm:doctor` + policy tests stricter than frozen alone |

Changing deps on a maintainer machine: **`bun-deps`** / `bun run deps` / `./bin/dx deps` (see runbook). Verify: `bun run pm:doctor`, `bun test tests/bun_config_policy.test.ts`.

<!-- Detailed PM sections live in runbooks/bun-pm-policy.md; do not duplicate here. -->


## Project `bunfig.toml` (non-PM)

Install-related keys stay out of the repo copy ([runbook → machine keys](./runbooks/bun-pm-policy.md)). This repo **does** set `[run] noOrphans = true` (parent-death cleanup for spawned processes including headless WebView). Fmt ignore patterns are tool-owned; see file header comments.

## Live docs (check behavior on 1.4.4)

- Reference: [bun.com/docs](https://bun.com/docs)
- Walkthroughs: [bun.com/guides](https://bun.com/guides)
- PM topics that match this repo: [install](https://bun.com/docs/pm/cli/install), [add](https://bun.com/docs/pm/cli/add), [remove](https://bun.com/docs/pm/cli/remove), [workspaces](https://bun.com/docs/pm/workspaces), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs), [patch](https://bun.com/docs/pm/cli/patch)

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
| Install policy in this repo | [runbooks/bun-pm-policy.md](./runbooks/bun-pm-policy.md), `AGENTS.md`, `bun run pm:doctor` |

## Related in this repo

- **Package manager policy (full):** [`runbooks/bun-pm-policy.md`](./runbooks/bun-pm-policy.md)
- Eval one-liners: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md)
- Server / WebView runtime shapes: [`runbooks/bun_server_runtime_shapes_runbook.md`](./runbooks/bun_server_runtime_shapes_runbook.md)

```sh
bun run pm:doctor
bun test tests/bun_config_policy.test.ts tests/pm_policy_workspaces.test.ts tests/dx_deps.test.ts
bun run probe:bun                      # after Bun upgrade
```
