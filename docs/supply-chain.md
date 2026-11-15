# Supply chain: runtime pin, lockfile, SBOM, hermetic build, step envelopes

Everything here starts from raw material (Oven's release binary and signed checksums, the
resolved `bun.lock`, and recorded tool steps), not from release notes. Every number below
came from a command run on 2026-11-15 on the agent box (Linux x86_64). Where something was
only designed and not run, it says **not verified**.

The verifiers are deliberately **Bun-free** (POSIX `sh`, `python3`, `gpg`, `openssl`,
`cosign`, `cyclonedx-cli`, Nix): a tool that checks the runtime should not run on it.

## 1. Runtime pin (raw release material)

| Item                                     | Value                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release                                  | `bun-v1.4.4`, revision `38afee6c8` (matches `.bun-version`)                                                                                                                                                                                           |
| Signed checksums                         | `SHASUMS256.txt.asc`, OpenPGP clearsigned (SHA512, EdDSA), made 2026-10-22 21:44:49 UTC                                                                                                                                                               |
| Signer                                   | `F3DCC08A8572C0749B3E18888EAB4D40A7B22B59` "Robobun &lt;robobun@oven.sh&gt;"                                                                                                                                                                          |
| Key sources (both give that fingerprint) | keys.openpgp.org `vks/v1/by-fingerprint/…`; the key block inlined in `oven-sh/bun` `dockerhub/debian/Dockerfile` (committed as `toolchain/keys/bun-release-signing.asc`). The two exports serialize different packets but carry the same primary key. |
| linux-x64 zip                            | `bf8ccbfb…cb395c` == signed checksum                                                                                                                                                                                                                  |
| linux-x64 binary                         | `10702245…7ac235`                                                                                                                                                                                                                                     |

Checks that ran (`toolchain/fetch-and-verify-bun.sh` re-runs all of them):

- `gpg --assert-signer F3DC…2B59 --verify` → good signature, exit 0. With the fingerprint in
  the pin replaced by zeros → exit 1 (negative control).
- All 5 platform zips (linux-x64, linux-x64-baseline, linux-aarch64, darwin-aarch64,
  darwin-x64) match the signed `SHASUMS256.txt`; extracted binary hashes are in
  `toolchain/bun.pin.json`. In 1.4.4 the linux-x64 and linux-x64-baseline binaries are
  byte-identical (`cmp`), although the zips differ.
- **Installed bun vs release: MATCH.** `/usr/local/bin/bun` is a 726-byte pnpm shim; the
  binary it execs (`…/bun@1.4.4/node_modules/bun/bin/bun.exe`) hashes `10702245…7ac235`, the
  same as the binary extracted from the verified zip.
- Third source: the npm tarball `@oven/bun-linux-x64@1.4.4` matches its registry `sha512`
  integrity, and its `package/bin/bun` is also `10702245…7ac235`. GitHub release, npm and the
  installed copy agree.

### Boot-time re-verification

`toolchain/verify-bun.sh` hashes the bun binary that `command -v bun` resolves to (following
npm/pnpm cmd-shims) and compares it with the pin. It never runs the binary it checks. Exit 0
match, 1 mismatch, 2 cannot resolve (fail closed).

`bin/dx` runs it when `DX_VERIFY_RUNTIME=1`: once before dx does anything, and again after
dx rewrites `PATH`, because that rewrite can change which `bun` runs. Mismatch → exit 70.
Off by default, so nothing existing changes.

Tested: pass (exit 0), fake pin (exit 1), jq-less fallback via python3, no bun on PATH
(exit 2), shim follow, unrecognised wrapper (exit 2). See `tests/toolchain_verify_bun.test.ts`.

**Finding on the agent box.** With `DX_VERIFY_RUNTIME=1`, `./bin/dx help` stops with exit
70: dx's PATH rewrite puts `$HOME/.bun/bin` ahead of `/usr/local/bin`, and on this box
`~/.bun/bin/bun` is `1.4.5-canary.1+ed4363334` (sha256 `f4830704…`, written 2026-11-15
03:44 CST). `./bin/dx exec -- bun --revision` confirms it. Without the guard, dx was silently
running the canary instead of the pinned 1.4.4. That is exactly the silent runtime swap this
guard exists to catch.

## 2. bun.lock graph

`python3 scripts/supply-chain/lock_graph.py bun.lock [--spot-check N]`

|                                                     |                                                        |
| --------------------------------------------------- | ------------------------------------------------------ |
| lockfileVersion                                     | 2                                                      |
| workspaces                                          | 8                                                      |
| packages                                            | 194 = 187 npm + 7 workspace                            |
| direct / transitive (npm)                           | 17 / 170                                               |
| nested (version-conflict) keys                      | 7, e.g. `cytoscape-elk/elkjs`, `diffusion/@types/node` |
| integrity                                           | 187/187 present, all `sha512`, 0 missing               |
| git / tarball / file / non-default registry sources | 0                                                      |
| platform-specific (os/cpu)                          | 25 (oxlint and tsgolint native bindings)               |
| overrides                                           | `got` 11.8.5, `ws` 5.2.5                               |

- **Registry spot-check:** 10 tarballs (an evenly spaced sample by key) downloaded from
  registry.npmjs.org and re-hashed: **10/10 match** the lockfile `sha512`.
- **Install reproducibility:** two clean `bun install --frozen-lockfile` runs of HEAD (fresh
  temp copies, separate empty caches, 151 MB each actually downloaded) give identical content
  manifests for all 5 `node_modules` trees (root `9f284b14…e8f7e6`, 10,418 entries). The
  repo's own `node_modules` matches too. `bun.lock` was unchanged. Bun reported "161
  packages installed"; the other lock entries are mostly the platform bindings for other
  OSes.

## 3. SBOM (CycloneDX 1.6)

`sh scripts/supply-chain/sbom_pipeline.sh`. Generator: `scripts/supply-chain/sbom_from_bunlock.py`.

- 192 components: 184 unique npm packages (187 lock keys; three nested keys repeat
  `content-type@2.1.0`), 7 workspaces, and **Bun itself** (`pkg:github/oven-sh/bun@bun-v1.4.4`,
  SHA-256 of the pinned binary, plus every platform's zip and binary hash as properties).
  185 components carry hashes. 290 dependency edges. Scope: 143 required, 41 optional (dev-only).
- Deterministic: fixed timestamp and a UUIDv5 serial, so two generations are byte-identical
  (`06a7e78a…ba866a` at this commit).
- **Validated by two tools other than the generator:** `cyclonedx-cli` 0.33.1 → "BOM
  validated successfully"; python-jsonschema 4.25.1 against the official 1.6 schema (hashes
  pinned in the script) → VALID. A deliberately broken copy (bad hash alg, bad scope) is
  rejected by both.
- **Cross-check with syft 1.57.1** (independent generator): syft lists 145 packages
  (it drops dev dependencies). 142 agree with our required set. The 4 differences:
  `@deepseek-ai/cordis`, `cosmokit` and `@standard-schema/spec` are reachable only through a
  devDependency's peer dependency, and `undici-types@8.9.0` is reached via the nested key
  `diffusion/@types/node`, which syft does not resolve. syft records hashes for 1 component;
  ours has 185.
- **DEMO signature**: `cosign` v3.1.4 `sign-blob` with a local throwaway key pair,
  using a signing config that lists no Fulcio/Rekor/TSA services, inside `unshare -rn` (no
  network). The bundle has 0 tlog entries. Verified offline by `cosign verify-blob` **and
  separately by `openssl dgst -sha256 -verify`** over the raw ECDSA signature. The bundle's
  digest equals sha256(SBOM). A one-byte change is rejected by both. Keys, the bundle and
  the SBOM stay in `/workspace/supply-chain/` and are not committed. **This proves the
  plumbing works, not where the SBOM came from.**
- **Production (designed, not run):** keyless signing in CI with GitHub OIDC
  (`id-token: write`). Fulcio issues a short-lived cert for the workflow identity and Rekor
  records the signature publicly. Verifiers pin `--certificate-identity` (the workflow path @
  `refs/heads/main`) and `--certificate-oidc-issuer https://token.actions.githubusercontent.com`.
  This publishes the repository/workflow identity to a public log, so it needs explicit
  sign-off. Drafted in `docs/ci-drafts/supply-chain-verify.yml`, job `sign`.

## 4. Hermetic build (Nix)

Feasible on this box. Determinate Nix 3.24.2 (Nix 2.35.3) installed with
`--init none`, daemon started by hand, sandbox on. Bazel was not attempted: it would need
rules_js plus a Bun toolchain rule, and Nix already pins by hash natively.

A JS repo has no compile step, so the reproduced artifacts are:

| Output          | What                                                                                                                                           | Result                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.#bun`         | `fetchurl` by the pinned zip sha256. Asserts the extracted binary == the pinned upstream sha256 (`10702245…`), then autoPatchelf for Nix glibc | built, `--rebuild` bit-identical. Patched binary `edfe05db…` (differs from upstream by design), runs as `1.4.4+38afee6c8`                                                            |
| `.#nodeModules` | fixed-output derivation: `bun install --frozen-lockfile` from bun.lock + package.json files (+ the workspace bin link targets)                 | NAR `sha256-064DfXmd…Lbc=` pinned in flake.nix. `--rebuild` matches. Root tree manifest `9f284b14…` = **the same bytes as the host's clean installs** (all 5 trees)                  |
| `.#regression`  | `toolchain/steps/regression-suite.step.json` in the Nix sandbox (no network) with `.#bun`                                                      | 191 pass / 0 fail. `--rebuild` bit-identical. Normalized result `2c2b7c51…7b99a` = **the same hash as the host envelope**, from a different builder and a differently patched binary |

To make the sandbox run green: `procps` (dx monitor calls `ps`) and a throwaway `git init`
(one test enumerates tracked files) are added inside the build. nixpkgs is pinned to
`nixos-26.05` rev `f1e5c356…` in `flake.lock`. `diffoscope` was not run: Nix's `--rebuild`
comparison found no differences, so there was nothing to diff.

## 5. Agent-step envelopes

**agent-rerun exists**: github.com/p-vbordei/agent-rerun (npm `agent-rerun` 0.1.1, plus
Python and Rust ports), spec v0.1. It pins one **LLM** step (model, sampling, system
prompt/messages hashes, expected transcript hash or embedding) using RFC 8785 JCS, SHA-256
and optional Ed25519, with byte/semantic/structural tolerance. Our steps are tool runs, so
`schema/tool-step-envelope.schema.json` borrows its mechanics (canonical JSON → SHA-256 →
optional Ed25519, a declared tolerance) but uses tool-step fields. It is **not**
agent-rerun-compatible, and agent-rerun's own verifier was not run on these.

An envelope pins:

- the repo commit and a digest of every tracked file (`toolchain/envelopes/` excluded);
- named input files and `node_modules` trees by content hash;
- the exact argv and the complete env (nothing inherited);
- the network policy, enforced with `unshare -rn`: `none`, or `loopback` (lo up, so local
  `Bun.serve` fixtures work and nothing leaves the box), or `host`;
- the runtime pin;
- the expected exit code and the sha256 of normalized output. The normalized text is
  committed next to the envelope, so a mismatch shows up as a readable diff.

`scripts/supply-chain/rerun.py capture | verify | verify-all`

Normalization removes per-run timings (`[1.2ms]`, "Finished in …", thread counts) and ANSI
codes. It sorts bun test result lines, because file order is not a contract. For the
verify-bun output it masks the binary path and hash and keeps the verdict. Everything else
is compared byte for byte.

Captured from real runs at this commit (`toolchain/envelopes/`):

| Envelope              | Expected                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `regression-suite`    | 191 pass / 0 fail / 893 expects across 13 files. Covers the dx CLI and run control, F402 session file write/validate/refresh, session login CLI (live login gated off), replay transport, bet-ticker JSONL/delta/ingest, client seams, module attributes, and the pin verifier |
| `lint-check`          | `bun run lint:check`: 0 warnings / 0 errors on both oxlint passes (1557 files/100 rules; 1526 files/8 rules)                                                                                                                                                                   |
| `dx-help`             | `./bin/dx help`, which embeds the live `bun run --help` catalog (100 flags on 1.4.4)                                                                                                                                                                                           |
| `verify-bun-fake-pin` | negative control, exit 1                                                                                                                                                                                                                                                       |
| `sbom`                | SBOM sha256 `06a7e78a…`                                                                                                                                                                                                                                                        |
| `install-repro`       | the 5 node_modules digests and "bun.lock unchanged"                                                                                                                                                                                                                            |

Left out on purpose:

- The earlier "92 investigate/session tests", the `dx investigate --offline` replay and the
  boolean-prop canary lint all live on the held local branches, which contain real customer
  data. They are not on `origin/main`, so they are not envelopes here.
- Envelopes store paths and hashes only. Normalized outputs are test names and counts.

## 6. Independent evidence: what proves this without trusting us

| Evidence                                                                                           | What it rules out                                | Status                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Oven's OpenPGP signature on SHASUMS256 (root of trust), key fetched from 2 sources                 | a tampered release asset or checksum file        | **demonstrated locally**, re-runnable by anyone with `toolchain/fetch-and-verify-bun.sh`  |
| npm `@oven/bun-linux-x64` tarball (registry integrity) hashes to the same binary                   | a single compromised distribution channel        | **demonstrated locally**                                                                  |
| Registry tarballs re-hashed against `bun.lock` integrity                                           | a lockfile that lies about its contents          | **demonstrated** (10/10); CI draft does 20                                                |
| Two clean installs + a Nix FOD rebuild on a different builder agree                                | non-reproducible dependency installs             | **demonstrated locally** (host ×2 + Nix sandbox ×2)                                       |
| `nix build --rebuild` (Nix compares the 2nd build bit for bit)                                     | nondeterministic build/test outputs              | **demonstrated locally** for `.#bun`, `.#nodeModules`, `.#regression`                     |
| SBOM checked by tools other than the generator (cyclonedx-cli, jsonschema) and diffed against syft | a malformed or incomplete SBOM                   | **demonstrated locally**                                                                  |
| SBOM signature checked by cosign **and** openssl                                                   | a verifier bug accepting a bad signature         | **demonstrated** with a DEMO key; real provenance needs keyless CI signing (**not run**)  |
| Cross-runtime replay (same envelopes, 1.4.4 vs 1.4.5-canary)                                       | a Bun bump silently changing tool behavior       | **demonstrated locally**, see `docs/runtime-upgrade.md`                                   |
| Host envelope == Nix sandbox result                                                                | a host-specific or environment-specific pass     | **demonstrated locally** (`2c2b7c51…` from both)                                          |
| A second CI pipeline on machines we don't control re-deriving every hash                           | everything above having been run only on our box | **designed, not run**: `docs/ci-drafts/supply-chain-verify.yml` (not enabled, not pushed) |
| A third party rebuilding with `nix build --rebuild` / diffoscope on their machine                  | collusion between our box and our CI             | **needs external infrastructure**                                                         |
| Keyless Sigstore signature checked against the Rekor log                                           | unsigned or wrongly-attributed SBOMs             | **needs sign-off** (public identity), not run                                             |

Everything marked "demonstrated locally" ran on one box. That is real evidence the
mechanics work, but it is not independence. Independence starts when someone else runs
the CI draft or the Nix rebuild.

## Caveats

- `cyclonedx-cli` 0.33.1 was downloaded from its GitHub release without a published
  checksum to check against. Its hash is recorded (`bfc8b253…`) and the CI draft pins it.
  cosign 3.1.4 and syft 1.57.1 matched their published checksums.
- The Nix-built bun is ELF-patched, so its hash differs from upstream. The upstream hash is
  asserted inside the derivation before patching.
- `rerun.py` uses `unshare -rn` (Linux user and network namespaces). macOS has no
  equivalent here, and GitHub's Ubuntu 24.04 runners may restrict unprivileged user
  namespaces. The CI draft's replay step is **not verified** on a hosted runner.
- The node_modules digests are platform-specific: the platform bindings differ per OS.
- Nix was installed on the shared agent box with `--init none`. The daemon does not survive
  a reboot unless started again (`sudo nix-daemon &`).
