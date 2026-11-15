# Bun upgrades are tested migrations

A Bun bump changes the substrate every agent tool runs on. This is the gate that turns it
into a tested migration instead of a silent swap. Tooling: `toolchain/bun.pin.json`,
`toolchain/verify-bun.sh`, `toolchain/envelopes/*`, `scripts/supply-chain/runtime_upgrade.sh`.

## The path: pin N → candidate N+1

1. **Baseline (pin N).** `verify-bun.sh` must accept the runtime, and every envelope must
   replay byte-identically on it. A red baseline cannot judge a candidate.
2. **Candidate replay.** Replay the same envelopes on the candidate binary:
   - the regression suite (dx CLI, F402 session file I/O, replay transport, bet-ticker
     pipeline, pin verifier), offline and loopback-only;
   - `lint:check`;
   - `dx help`, which carries the live `bun run --help` surface;
   - the verifier's negative control;
   - SBOM determinism;
   - a clean frozen install compared tree for tree.
3. **Verdict.** PROMOTE-ELIGIBLE only if every envelope matches, or the only differences
   are in envelopes a human reviewed and passed with `--accept <id>`. Anything else blocks.
   The normalized diffs are saved under `--out`.
4. **Promote (manual, separate PR).** The candidate must be a signed stable release. Run
   `toolchain/fetch-and-verify-bun.sh` against the new tag to re-derive the pin, bump
   `.bun-version`, re-capture the envelopes on the new pin, rerun the gate, and run
   `nix build .#regression --rebuild` (the FOD hash must be updated if install bytes changed).

```sh
sh scripts/supply-chain/runtime_upgrade.sh --candidate /path/to/new/bun --out /tmp/upgrade
sh scripts/supply-chain/runtime_upgrade.sh --candidate /path/to/new/bun --accept dx-help   # after review
```

The script never edits the pin, `.bun-version` or CI.

## Measured: 1.4.4 → 1.4.5-canary.1 (2026-11-15)

Candidate `/tmp/bun-canary/bun-linux-x64/bun`, `1.4.5-canary.1+ed4363334`, sha256
`f4830704…7cb7`. It is a canary, so it has no signed stable release and its provenance is
**not verified**.

| Envelope            | Pinned 1.4.4  | Canary                                                     |
| ------------------- | ------------- | ---------------------------------------------------------- |
| regression-suite    | PASS 191/0    | **MATCH** (191/0, identical normalized output)             |
| lint-check          | PASS          | **MATCH**                                                  |
| install-repro       | PASS          | **MATCH**: the canary installs byte-identical node_modules |
| sbom                | PASS          | MATCH (runtime-independent)                                |
| verify-bun-fake-pin | PASS (exit 1) | MATCH                                                      |
| dx-help             | PASS          | **DIFF**                                                   |

The `dx-help` diff is real: `bun run --help` goes from 100 to 102 flags (transpiler 21 → 23).
The canary adds `--aot` and `--aot-allow-code-from-disk` and rewords `--use-openssl-ca`.
The verdict was **BLOCK** (blocking: dx-help). With `--accept dx-help` it is
**PROMOTE-ELIGIBLE**, which is the mechanism working as designed: a new CLI surface needs a
person to look at it.

Not in the gate: the canary's native `bun lint`. On 1.4.4, `bun lint` falls through to the
package script (`oxlint --fix`, which rewrites files), so it can't be an envelope that runs
on both. Add it as a candidate-only check once the pin itself has the native linter.
