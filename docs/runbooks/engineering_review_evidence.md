# Evidence-first engineering review and handoff

This workflow supplements [AGENTS.md](../../AGENTS.md) and the
[signal-honesty ADR](../architecture/signal-honesty.md). Use it for reviews,
runtime upgrades, benchmarks, production investigations, and stacked PRs.
Its purpose is to keep findings testable rather than turning chat conclusions
into unverified implementation claims.

## 1. Anchor the work before interpreting it

Record the **working repository**, upstream repository (if a fork),
base branch/SHA, head branch/SHA, and the files actually inspected.
A PR stacked on another PR is not necessarily based on \`main\`.
Do not conflate a fork's PR number with an upstream PR of the same number.

Record \`.bun-version\`, \`packageManager\`, \`engines.bun\`, the CI-selected
runtime, and \`bun --version\` from the actual test environment.
When they disagree, call out drift and do not claim reproducible parity.

For API/tooling claims, prefer the pinned binary's \`--help\`, tagged upstream
source/tests, the repo's package scripts, and a minimal executable fixture.
Distinguish \`bun lint\` (a native command, if supported by that runtime)
from \`bun run lint\` (a package script). On this repository's pinned Bun 1.4.4,
\`bun fmt\` is native; linting is executed through Oxlint package scripts.
Do not silently substitute npm \`semver\` behavior for \`Bun.semver\`.

## 2. Keep an evidence ledger

For each consequential conclusion, attach a reproducible source and one of:

- **Observed:** command/test was actually run; include OS, Bun version,
  exact command, exit code, and the relevant diagnostic or measured value.
- **Inspected:** directly supported by pinned code, config, or workflow,
  but not exercised.
- **Inferred:** reasoned from inspected evidence; state assumptions.
- **Not run:** verification still pending; never label it passing.
- **Blocked:** name the blocker, e.g. a GitHub 403, missing binary,
  inaccessible logs, or a CI runner \`startup_failure\`.

Separate **failure to start a CI runner**, **test failure after runner start**,
**skipped checks**, **missing job logs**, and **permission failures**.
None of these may be relabeled as another category. A successful local test
does not prove the hosted workflow ran.

## 3. Review contracts by independent dimension

For every Bun fetch/server/API proposal, record separately:

- Callable/function and the actual input and return TypeScript types.
- URL representation (string, \`URL\`, Request, or structured object).
- URL **scheme** (e.g. \`https:\`, \`s3:\`) and supported transport/protocol.
- HTTP method, headers, request body, encoding, and defaults.
- DNS resolution, direct/proxy route, proxy credentials, and environment policy.
- TLS trust roots, certificate-name verification, SNI \`servername\`,
  protocol negotiation, and any custom TLS context.
- Error class/code, retryability, cancellation semantics, and public mapping.

Do not use “protocol”, “scheme”, “object”, or “property” interchangeably.
An HTTP-only benchmark does not test TLS, SNI, HTTP/2, or proxy behavior.
Preserve typed configuration, URL, and tunnel errors through wrapper layers:
an invalid proxy-header configuration must not become a generic network error.
Add a targeted regression for every fixed error boundary.

## 4. Interpret measurements narrowly

Before comparing performance, establish semantic parity and the workload's
source. Use the same commit, configs, OS, pinned binary, and input fixtures;
isolate client and server where relevant, warm both paths, and pair runs.
Report sample counts, p50/p95/p99, error rate, CPU, and the measurement method.
\`heapStats\` snapshots describe retained heap changes, not cumulative
allocations. Synthetic, Node-run, local, and production measurements must be
labeled separately. Never claim a user-visible >=50% improvement from an
R2-request reduction model or an unexecuted benchmark.

## 5. Control changes and closure

Keep unrelated dependency, runtime, TLS/proxy, cache, and production changes in
separate PRs unless their coupling is demonstrated. For stacked PRs, test both
the individual patch and the combined error/behavior contract.

Use \`bun run verify:fast\` during changes and the appropriate targeted suites;
run \`bun run ci:local\` for the full gate only when the environment supports it.
Do not claim either ran if the pinned Bun/runtime or checkout is unavailable.

A “go” to investigate or draft is not authorization to merge held PRs,
publish artifacts, deploy, or mutate live Fantasy402 accounts. Record the
requested side-effect scope and obtain an explicit deploy/merge instruction.

End each review with: **changed**, **tested (command + exit)**,
**not tested/blocked**, **remaining risk**, and **next owner/action**.
Keep private chat transcripts, credentials, session data, and raw captures
out of the public repository.

## 6. Titles that remain useful

Use \`<project> · <component> · <PR/issue or version> · <outcome>\`
for chat and handoff titles. Prefer \`Review\`, \`Blocked\`, \`Draft\`,
or \`Verified\` when they convey the actual status, not presumed closure.
