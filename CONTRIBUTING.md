# Contributing

Repository conventions, the verification loop and the gate list live in
[AGENTS.md](AGENTS.md) — read that first. This file covers the one workflow that is specific to
contributing around **Bun itself**: running an upstream pull request's build against this
repository.

## Testing an upstream Bun PR build

Upstream Bun publishes a release build as a GitHub Actions artifact on each pull request, and its
[CONTRIBUTING guide](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/CONTRIBUTING.md#download-release-build-from-pull-requests)
documents fetching it with the [`bun-pr`](https://www.npmjs.com/package/bun-pr) package:

```sh
bunx bun-pr <pr-number>
bunx bun-pr <branch-name>
bunx bun-pr "https://github.com/oven-sh/bun/pull/123456"
bunx bun-pr --asan <pr-number>   # Linux x64 only
```

That downloads the build and adds `bun-<pr-number>` to `$PATH` (in `~/.bun/bin`), so
`bun-123456 --version` runs it.

This repository wraps the same tool as a `dx` command, so a downloaded build can be exercised
against the desk's own gates instead of a scratch project:

```sh
./bin/dx pr 16420            # download and link bun-16420 into ~/.bun/bin
./bin/dx pr 16420 --verify   # smoke-test the desk gates with that binary
./bin/dx pr --list           # installed bun-* binaries
./bin/dx pr --clean 16420    # remove one; --clean all removes every PR binary
```

`dx pr` implements only `--verify`, `--list` and `--clean`. Every other flag is forwarded unchanged
to `bun-pr`, which owns it, so the build variants and debugger flags work through the wrapper too:

```sh
./bin/dx pr 16420 --asan       # AddressSanitizer release build (Linux x64)
./bin/dx pr 16420 --profile    # profiling build with symbol maps
./bin/dx pr 16420 --baseline   # baseline x86-64 build (no AVX2)
./bin/dx pr 16420 --musl       # musl libc build (Alpine / container)
./bin/dx pr 16420 --lldb       # launch the downloaded binary in LLDB
./bin/dx pr 16420 -x run verify:fast   # run a command with the downloaded binary
```

### What `--verify` runs

Three gates, in order, with the downloaded binary:

1. `bun check --no-script -p tsconfig.json`
2. `bun run scripts/run_check_spec_citations.ts`
3. `bun run verify:fast`

It answers "does this upstream build still pass the desk's gates?" — it is not a substitute for CI
on `main`, which is the full chain in [AGENTS.md](AGENTS.md).

### Prerequisites

- **`bun-pr` on `$PATH`.** `dx pr` invokes `~/.bun/bin/bun-pr` when it exists, and `bun-pr`
  otherwise, so `bun install -g bun-pr` (or one `bunx bun-pr` run that installs it) is enough.
- **`gh` authenticated.** The artifact lives on the pull request's workflow run and needs
  repository access.
- The build is written to `~/.bun/bin`, never into this checkout, so a PR build cannot change the
  repository's pinned runtime. The pin stays `1.4.4` until a PR that bumps it merges.

## Sending a change here

- Keep the fast loop: `bun run verify:fast` (format, typecheck, scoped lint, path-triggered gates
  and `test:changed`). The full chain before merge is listed in [AGENTS.md](AGENTS.md).
- A behaviour change arrives with its regression test in the same pull request. A test that fails
  against the old code is the evidence the fix was needed.
- A change that regenerates a derived artifact — the shape catalogue, its runbook, the Bun docs
  baseline — commits the regenerated file alongside the source. Otherwise the next run's gate fails
  on the generated diff rather than on the change.
- One concern per pull request. A fix, a doc correction and a new command are three reviewable
  units, not one.
