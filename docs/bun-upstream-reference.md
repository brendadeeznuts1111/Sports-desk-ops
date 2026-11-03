# Bun upstream reference (by kind)

How sportsdesk-ops points at [oven-sh/bun](https://github.com/oven-sh/bun) without mixing **runtime
behavior**, **prose style**, **site machinery**, and **this repo’s gates**.

Evidence labels and capture-backed claims here override upstream tone. Eval one-liners:
[`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md). This repo’s gates: `AGENTS.md`, `bun run ci:local`.

## Index by kind

| Kind | Artifact | Pin | Behavior SSOT? |
| ---- | -------- | --- | -------------- |
| [Runtime](#kind-runtime) | Released binary + tag | [`bun-v1.4.4`](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) | **Yes** (1.4.4 / `38afee6c`) |
| [Style](#kind-style) | Docs voice rules | [`6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing) | No |
| [Snippet](#kind-snippet) | Mintlify partials / nav | [`6a380492`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets) | No — verify flags on **1.4.4** |
| [Reference](#kind-reference) | `/docs/*` manuals | Live [bun.com/docs](https://bun.com/docs) | Check against **1.4.4** |
| [Guide](#kind-guide) | `/guides/*` walkthroughs | Index in [`guides.jsx`](#kind-snippet) | Check against **1.4.4** |
| [Contributor](#kind-contributor) | How to PR upstream | `main` [`CONTRIBUTING.md`](https://github.com/oven-sh/bun?tab=contributing-ov-file) | N/A (engine build) |

Commits **`6cdb3835`** and **`6a380492`** are on **`main` after** the 1.4.4 tag — use them for
writing and navigation only.

---

## Kind: runtime

| Item | Link |
| ---- | ---- |
| Release tag | [github.com/…/releases/tag/bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) |
| Commit | [`38afee6c84fcf48c0edb2466aa4b27d287a59c30`](https://github.com/oven-sh/bun/commit/38afee6c84fcf48c0edb2466aa4b27d287a59c30) (2026-10-22) |
| Changelog narrative | [bun.com/blog](https://bun.com/blog) |

**sportsdesk-ops:** `package.json` `packageManager` / `engines`, `@types/bun@1.4.4`, `tests/bun_baseline.json`, `bun run probe:bun` after upgrades.

---

## Kind: style

Prose when editing upstream MDX or mirroring Bun tone (active voice, present tense, second person; no
“easy” / “simple” / “just”).

| Item | Link |
| ---- | ---- |
| Voice (pinned tree) | [`docs/project/contributing.mdx` @ `6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing) |
| Voice (live) | [bun.com/docs/project/contributing#voice](https://bun.com/docs/project/contributing#voice) |

---

## Kind: snippet

Reusable **docs-site** pieces at [`docs/snippets/`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets) @ **`6a380492`**. Full articles live elsewhere.

| Snippet | Role |
| ------- | ---- |
| [`guides.jsx`](https://github.com/oven-sh/bun/blob/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets/guides.jsx) | Nav catalog: every `/guides/*` title + href → [bun.com/guides](https://bun.com/guides) |
| [`cli/*.mdx`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets/cli) | Flag lists included by CLI reference pages (`import … from "/snippets/cli/…"`) |

### CLI snippets by kind

| Kind | Files | Live hub | sportsdesk-ops |
| ---- | ----- | -------- | -------------- |
| Package manager | `install`, `add`, `remove`, `update`, `patch`, `outdated`, `publish`, `link` | [/pm/cli/install](https://bun.com/docs/pm/cli/install) | `bun-deps`, frozen lock, `pm:doctor`, `.npmrc` |
| Runtime CLI | `run`, `test`, `init` | [/runtime/run](https://bun.com/docs/runtime/run), [/test](https://bun.com/docs/test) | `package.json` scripts, `--filter`, `bun test --parallel` |
| Tooling | `format`, `lint` | [/format](https://bun.com/docs/format), [/lint](https://bun.com/docs/lint) | `format:check`, `lint:check`, `bunfig` `[fmt]` |
| Bundler | `build`, `compile`, `bunx` | [/bundler](https://bun.com/docs/bundler) | — |

---

## Kind: reference

Long-form **`/docs/*`** (unpinned; prefer live URLs + **1.4.4** for behavior).

| Kind | Topics | sportsdesk-ops |
| ---- | ------ | -------------- |
| Package manager | [workspaces](https://bun.com/docs/pm/workspaces), [catalogs](https://bun.com/docs/pm/catalogs), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs), [filter](https://bun.com/docs/pm/filter) | `lib/pm_policy.ts`, `tests/bun_config_policy.test.ts`, `packages/*` |
| Runtime | [bunfig](https://bun.com/docs/runtime/bunfig), [check](https://bun.com/docs/runtime/check) | project `[fmt]`/`[run]`; install in `~/.bunfig.toml`; `typecheck` |
| Test | [parallel](https://bun.com/docs/test/parallel) | `.bun-test-timings.json`, CI `tests/` |

---

## Kind: guide

Short **walkthroughs** at `/guides/*` (bodies in MDX; index in [`guides.jsx`](#kind-snippet)).

| Kind | Examples |
| ---- | -------- |
| Install | [workspaces](https://bun.com/guides/install/workspaces), [trusted](https://bun.com/guides/install/trusted), [custom registry](https://bun.com/guides/install/custom-registry), [registry scope](https://bun.com/guides/install/registry-scope), [CI install](https://bun.com/guides/install/cicd) |
| Lint / format | [migrate oxlint](https://bun.com/guides/lint/migrate-from-oxlint), [migrate Prettier](https://bun.com/guides/format/migrate-from-prettier) |
| Test | [run tests](https://bun.com/guides/test/run-tests) |

---

## Kind: contributor

Who you are contributing **to** determines the doc set.

| Audience | Doc | Kind |
| -------- | --- | ---- |
| **sportsdesk-ops** | `AGENTS.md`, `ci:local` | This repo |
| **Bun engine** (Rust/C++/JSC) | [GitHub Contributing tab](https://github.com/oven-sh/bun?tab=contributing-ov-file) → [`CONTRIBUTING.md`](https://github.com/oven-sh/bun/blob/main/CONTRIBUTING.md) | Runtime build (`bun bd`, LLVM 23, WebKit, `bun-pr`, BuildKite) |
| **bun.com MDX** | [`docs/project/contributing.mdx`](https://bun.com/docs/project/contributing) | Style + same build appendix; [voice](https://bun.com/docs/project/contributing#voice) |
| **bun.com (short)** | [`docs/README.md#contributing`](https://github.com/oven-sh/bun/tree/main/docs#contributing) | Pointer to voice + PRs |

---

## Local verification

```sh
bun run pm:doctor
bun test tests/bun_config_policy.test.ts tests/pm_policy_workspaces.test.ts
bun run probe:bun   # after a Bun upgrade
```
