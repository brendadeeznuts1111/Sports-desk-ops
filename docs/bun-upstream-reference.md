# Bun docs (upstream)

**Runtime SSOT:** [bun-v1.4.4](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4) (`38afee6c`, 2026-10-22). Matches `package.json`, `tests/bun_baseline.json`, `bun run probe:bun` after upgrades.

**Not runtime SSOT:** [bun.com/docs](https://bun.com/docs) and [bun.com/guides](https://bun.com/guides). Pinned trees on `main` after 1.4.4: voice [`6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing), site snippets [`6a380492`](https://github.com/oven-sh/bun/tree/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets) (`guides.jsx`, `cli/*.mdx` flag blocks). Use those for upstream doc PRs; verify behavior on 1.4.4. Evidence labels in this repo win over upstream prose.

| You are changing… | Start here |
| ----------------- | ---------- |
| sportsdesk-ops | `AGENTS.md`, `bun run ci:local` |
| bun.com MDX | [contributing#voice](https://bun.com/docs/project/contributing#voice) |
| Bun (Rust/C++/JSC) | [CONTRIBUTING.md](https://github.com/oven-sh/bun?tab=contributing-ov-file) |
| PM layout here | `AGENTS.md` install policy, `lib/pm_policy.ts`, [workspaces](https://bun.com/docs/pm/workspaces) |

Eval one-liners: [`bun-eval-pitfalls.md`](./bun-eval-pitfalls.md). PM sanity: `bun run pm:doctor`, `bun test tests/bun_config_policy.test.ts`.
