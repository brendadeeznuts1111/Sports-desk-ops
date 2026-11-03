# Bun docs (upstream)

When to trust oven-sh/bun docs vs this repo. Evidence labels here beat upstream prose.

## Runtime (behavior SSOT)

| What | Where |
| ---- | ----- |
| Release | [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (2026-10-22) |
| Commit | `38afee6c84fcf48c0edb2466aa4b27d287a59c30` |
| This repo | `package.json` `packageManager` / `engines`, `@types/bun@1.4.4` |
| After upgrade | `bun run probe:bun` vs `tests/bun_baseline.json` |

## Live docs (check behavior on 1.4.4)

- Reference: [bun.com/docs](https://bun.com/docs)
- Walkthroughs: [bun.com/guides](https://bun.com/guides)
- PM topics that match this repo: [workspaces](https://bun.com/docs/pm/workspaces), [lifecycle](https://bun.com/docs/pm/lifecycle), [lockfile](https://bun.com/docs/pm/lockfile), [isolated installs](https://bun.com/docs/pm/isolated-installs)

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
