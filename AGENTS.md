# AGENTS.md — sportsdesk-ops

Operator tooling for the Fantasy402 sports desk: ingestion, settlement, combo/CLV analytics, the R2
portal and the VPS service. Bun **1.4.4** (`packageManager` and `engines` in `package.json`).

## Entrypoint and the gate chain

`./bin/dx` is the operator entrypoint (`README.md`, "Always use `./bin/dx`"). `./bin/dx deploy`
stages and publishes to R2 and Cloudflare Pages; `./bin/dx ship` deploys, then pushes `main`. The
VPS service ships through `scripts/deploy/deploy_to_vps.sh`.

`.github/workflows/ci.yml` is the gate list. Replay it locally before claiming a change works:

```sh
bun run ci:local               # every `run` step of ci.yml, in order; stops at the first failure
bun run ci:local --keep-going  # all steps, then the list of failures
bun run ci:local --list        # print the steps without running them
```

GitHub Actions cannot start on this private repo (startup_failure, 0 jobs), so a green badge does
not exist; `ci:local` _is_ the CI run. It checks the working tree, so uncommitted files from other
work count against it — to judge only your change, run it in a clean `git worktree` at `HEAD`.
The `policy:check` step runs the Bun-native ratchet from the `~/platform` checkout
(`~/platform/policy/ratchet.ts`); without that checkout it fails — say so, do not drop the step.

The CI test step is `bun test tests/ --parallel`. Colocated `*.test.ts` under `lib/` and `scripts/`
run only under `bun run test` (all discovered tests), so run that too before pushing. It runs files
across every core, each in a fresh global, and keeps `.bun-test-timings.json` (gitignored) so the
slowest files start first; `bun run test:serial` is the one-process run, and
`bun run test:changed` runs only the files git says your changes affect.

After a Bun upgrade, `bun run probe:bun` diffs the runtime against `tests/bun_baseline.json`; the
one-liner pitfalls it records are explained in `docs/bun-eval-pitfalls.md`.

## Write Bun-native code

Existing code is not precedent. `~/platform/policy/baseline.json` freezes the old Node-style
sites; a new one fails `bun run policy:check`. The full rule table is the user rule
`~/.cursor/rules/bun-native-policy.mdc`.

- `Bun.env.NAME`, not `process.env`; declare the name in `types/env.d.ts`.
- `Bun.file(path).text()` / `.json()` / `.bytes()` and `Bun.write`, not `readFileSync` /
  `writeFileSync`.
- `Bun.spawn` / `Bun.spawnSync` / `Bun.$`, not `node:child_process`; `Bun.sleep`, not a
  hand-rolled `setTimeout` promise.
- `import.meta.dir` / `import.meta.main`, not `fileURLToPath(import.meta.url)` or argv checks.
- No `typeof Bun` guards or fallback branches in Bun-only code: call the API.
- No `as any` and no hand-rolled `isRecord` / `asRecord` guards. Type external data `unknown`
  and parse it once at the boundary with a `zod` schema.
- `Bun.Image` ([docs](https://bun.com/docs/runtime/image),
  [error codes](https://bun.com/reference/globals/bun/Image/ErrorCode)):
  - `metadata()` reads only the header. To prove untrusted bytes decode, await a terminal
    (`lib/logo_image.ts` `inspectLogo`).
  - Untrusted input gets an explicit `maxPixels`; the default allows a 1 GiB decode.
  - Never pass a request-derived string to `new Bun.Image(path)`: it reads that file.
  - Branch on `imageErrorCode(err)` from `lib/image_errors.ts` (also reads `err.cause`), and
    rethrow every code you do not handle. Wrap with `{ cause }` so the code survives.
  - `rotate()` takes whole multiples of 90; `new Response(img)` encodes synchronously, so
    await `.blob()` in a handler.
  - Resized bytes differ between macOS and Linux unless `Bun.Image.backend = "bun"`; set it
    before hashing or locking a resized image.

## Layout

`ROOT_LAYOUT.md` owns the directory table. Two things it does not say: tests are colocated in
`lib/` and `scripts/` as well as `tests/`, and the runbooks live in `docs/runbooks/`.

## Hard rules

### ⚠️ SECURITY WARNING (Fantasy402 session)

Never paste **Bearer JWTs**, live cookies, or portal passwords into chat, commits, or scripts.
Revoke any token that was exposed. Live manager API calls must use **`createF402ReplayTransport()`**
(`lib/f402_replay_transport.ts`: WebView profile / session file / replay proxy); the policy text is
`lib/f402_agent_policy.ts` and the operator guide `docs/evidence/agent-graph-operator.md`. Agent
graph CLI: **`bun run graph:agent`** (no `--token` flags).

- **Production is read-only unless the task is explicitly a deploy.** Probe with `./bin/dx`, never
  mutate live data to make a number look right.
- **Evidence labelling:** any claim in docs or commits states what was measured and when. The docs
  gates exist because fabricated contracts shipped before.
- **Token/secret work** goes through the documented SSOT path: `.1password/environments.toml`
  (written by `code-project sync-environments --apply`) mounts `.env`. Fix the wiring; never
  hand-write secrets into the repo.
- **`verification/manager-boot-oracle/pinned/` is byte-pinned vendor code.** The oracle diffs it;
  never edit or reformat it to satisfy a linter. Exclude it from the tool instead.
- **Install policy is machine-owned** (`~/.bunfig.toml`: isolated linker, frozen lockfile, 3-day
  release age); `tests/bun_config_policy.test.ts` keeps install keys out of the project bunfig.
  The frozen lockfile makes plain `bun add`/`remove`/`update` exit 1, so change dependencies with
  `bun-deps add <pkg>` (machine command; `bun run deps` at the root is the same). Run it in the
  package that should own the dependency: inside a workspace it edits that `package.json`, and
  `--catalog[=<name>]` records the version in the root catalog. After a hand edit to a catalog,
  `bun-deps install`. A frozen install passes even when `bun.lock` is behind on workspace
  versions or patches, so after `bun pm version` in a workspace run `bun-deps install`, and commit
  patches with `bun-deps patch --commit <dir>` (plain `bun patch --commit` skips the lock).
  `bun run pm:doctor` checks the whole setup on this machine, including lock drift and the
  `@tennis-hq` registry and token that publishing needs. There is no catalog yet: the workspace
  packages in `packages/` have no dependencies of their own.
- `Scratch/` and `dist/` are gitignored. The source scanners list files from git
  (`lib/source_files.ts`), so an ignored file never fails a gate; do not commit either directory.

## Doc ownership

`README.md` = orientation · `ROOT_LAYOUT.md` = layout · `docs/runbooks/` = operational procedure ·
`docs/` = long-form. Move procedure into `docs/runbooks/` rather than growing the root.

Bun upstream docs (voice pin, `docs/snippets` nav/CLI partials, PM/runtime page map, sportsdesk
hooks): **[docs/bun-upstream-reference.md](docs/bun-upstream-reference.md)**. Runtime stays on Bun
**1.4.4** + `docs/bun-eval-pitfalls.md`; evidence labels override upstream tone when they conflict.
