# Bun upstream documentation pins

How this repo points at [oven-sh/bun](https://github.com/oven-sh/bun) docs without confusing **writing
style**, **site navigation**, or **runtime behavior**.

| Layer | Git pin | Use for |
| ----- | ------- | ------- |
| **Runtime** | `bun-v1.4.4` (`38afee6c8`) | Gates, `probe:bun`, `tests/bun_baseline.json`, `packageManager` / `engines` |
| **Voice** | [`6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing) | Prose when editing upstream MDX or mirroring Bun tone ([live voice](https://bun.com/docs/project/contributing#voice)) |
| **Nav + CLI flags** | [`6a380492`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets) | Guides index and CLI snippet partials ([live guides](https://bun.com/guides)) |

Pins above **main** are not behavior SSOT. Evidence labels and capture-backed claims in
sportsdesk-ops override upstream tone when they conflict. One-liner eval rules:
[`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md).

## `docs/snippets/` @ `6a380492`

Mintlify building blocks; full articles live elsewhere.

| Path | Role |
| ---- | ---- |
| [`guides.jsx`](https://github.com/oven-sh/bun/blob/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets/guides.jsx) | React nav: every `/guides/*` title and href |
| [`cli/`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets/cli) | MDX partials imported by CLI reference pages (`import X from "/snippets/cli/…"`) |

### CLI snippet files → live reference

| Snippet | Published page (typical) | sportsdesk-ops |
| ------- | ------------------------ | -------------- |
| `install.mdx` | [/pm/cli/install](https://bun.com/docs/pm/cli/install) | `bun-deps install`, frozen lockfile, `pm:doctor` |
| `add.mdx` | [/pm/cli/add](https://bun.com/docs/pm/cli/add) | `bun run deps` / `bun-deps add`, `--catalog` |
| `remove.mdx` | [/pm/cli/remove](https://bun.com/docs/pm/cli/remove) | via `bun-deps` when lock frozen |
| `update.mdx` | [/pm/cli/update](https://bun.com/docs/pm/cli/update) | lock drift; re-install with `bun-deps` |
| `patch.mdx` | [/pm/cli/patch](https://bun.com/docs/pm/cli/patch) | `bun-deps patch --commit` (AGENTS.md) |
| `outdated.mdx` | [/pm/cli/outdated](https://bun.com/docs/pm/cli/outdated) | manual dependency review |
| `publish.mdx` | [/pm/cli/publish](https://bun.com/docs/pm/cli/publish) | `@tennis-hq` registry, `.npmrc` |
| `link.mdx` | [/pm/cli/link](https://bun.com/docs/pm/cli/link) | — |
| `run.mdx` | [/runtime/run](https://bun.com/docs/runtime/run) | `package.json` scripts, `--filter`, `--parallel` |
| `test.mdx` | [/test](https://bun.com/docs/test) | `bun test --parallel`, CI `tests/` |
| `format.mdx` | [/format](https://bun.com/docs/format) | `format:check`, `bunfig.toml` `[fmt]` |
| `lint.mdx` | [/lint](https://bun.com/docs/lint) | `lint:check`, `.oxlintrc.json` |
| `build.mdx` | [/bundler](https://bun.com/docs/bundler) | — |
| `compile.mdx` | [/bundler/executables](https://bun.com/docs/bundler/executables) | — |
| `bunx.mdx` | [/pm/bunx](https://bun.com/docs/pm/bunx) | — |
| `init.mdx` | [/runtime/templating/init](https://bun.com/docs/runtime/templating/init) | — |

## Long-form docs (unpinned; use live site + 1.4.4 for behavior)

Prefer these `/docs/pm/*` pages for package-manager depth (not duplicated in `guides.jsx` alone):

| Topic | URL | Repo hook |
| ----- | --- | --------- |
| Workspaces | [/pm/workspaces](https://bun.com/docs/pm/workspaces) | `packages/*`, `lib/pm_policy.ts` |
| Catalogs | [/pm/catalogs](https://bun.com/docs/pm/catalogs) | not adopted yet (AGENTS.md) |
| Lifecycle / trusted | [/pm/lifecycle](https://bun.com/docs/pm/lifecycle) | `trustedDependencies: []` |
| Lockfile | [/pm/lockfile](https://bun.com/docs/pm/lockfile) | `bun.lock`, `tests/bun_config_policy.test.ts` |
| Isolated installs | [/pm/isolated-installs](https://bun.com/docs/pm/isolated-installs) | global `linker = isolated`, `pm:doctor` |
| `--filter` | [/pm/filter](https://bun.com/docs/pm/filter) | `schema:*` workspace scripts |
| bunfig | [/runtime/bunfig](https://bun.com/docs/runtime/bunfig) | project `[fmt]` / `[run]`; install keys in `~/.bunfig.toml` |
| Typecheck | [/runtime/check](https://bun.com/docs/runtime/check) | `typecheck` → `bun check --no-script` |
| Test parallel | [/test/parallel](https://bun.com/docs/test/parallel) | `test`, `test:changed`, `.bun-test-timings.json` |

## Guides index highlights (from `guides.jsx`)

Walkthroughs under [/guides/install/*](https://bun.com/guides/install/workspaces) that match this
repo: [workspaces](https://bun.com/guides/install/workspaces), [trusted dependency](https://bun.com/guides/install/trusted), [custom registry](https://bun.com/guides/install/custom-registry), [registry scope](https://bun.com/guides/install/registry-scope), [CI install](https://bun.com/guides/install/cicd); [migrate oxlint](https://bun.com/guides/lint/migrate-from-oxlint) / [migrate Prettier](https://bun.com/guides/format/migrate-from-prettier); [run tests](https://bun.com/guides/test/run-tests).

## Local verification

```sh
bun run pm:doctor
bun test tests/bun_config_policy.test.ts tests/pm_policy_workspaces.test.ts
bun run probe:bun   # after a Bun upgrade
```
