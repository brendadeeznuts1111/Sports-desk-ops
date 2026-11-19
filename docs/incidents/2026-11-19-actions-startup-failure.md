# Incident: GitHub Actions jobs fail before reporting runner steps

**Date:** 2026-11-19 UTC  
**Status:** Open — provider/account investigation required  
**Primary owner:** GitHub account operator (`brendadeeznuts1111`)  
**Provider escalation:** GitHub Support  
**Repository:** `brendadeeznuts1111/Sports-desk-ops`  
**Pinned comparison point:** `main` at `c122796e5a3849bf646cdb209172194c24288163`

## Evidence, not assumptions

| Repository | Example run | Reported result | Observation |
| --- | --- | --- | --- |
| `brendadeeznuts1111/Sports-desk-ops` | [44558696791](https://github.com/brendadeeznuts1111/Sports-desk-ops/actions/runs/44558696791) | `failure` | `verify-changed` and `market-index` have no recorded steps. Job logs are unavailable (`BlobNotFound`). |
| `brendadeeznuts1111/bookdeskops` | [44337687476](https://github.com/brendadeeznuts1111/bookdeskops/actions/runs/44337687476) | `startup_failure` | Separate repository, same owner. |
| `brendadeeznuts1111/silver-tulip-slate-terra` | [44551182587](https://github.com/brendadeeznuts1111/silver-tulip-slate-terra/actions/runs/44551182587) | `startup_failure` | Separate repository, same owner. |
| `bw496915-cmyk/Sports-desk-ops` (control) | [44441102131](https://github.com/bw496915-cmyk/Sports-desk-ops/actions/runs/44441102131) | `success` | Different account and a different repository revision. This is not a same-SHA workflow parity test. |

### Controlled retry

- On 2026-11-19, job `135681695670` (`verify-changed`, run `44558696791`) was retried once through the GitHub API.
- Run attempt **2** again completed in `failure`; replacement job `135700313540` reported `steps: null` and `logs_url: null`.
- A repeated retry without changed evidence is **not** a valid diagnostic method; stop repeated reruns.
- Other SportsDesk PRs (proxy, benchmark, runtime upgrade, docs) had the same immediate failure pattern in unrelated branches.

These facts strongly favor a common pre-step execution problem, but do **not** establish which subsystem failed. Possible causes include account-level Actions restrictions, repository permissions, runner provisioning, and platform-side policy. We have **not** verified a billing error or a live GitHub-wide outage. Never report these jobs as source-code-test failures.

## Ownership and scoped workstreams

| Lane | Owner / target | Deliverable | Gate |
| --- | --- | --- | --- |
| A — CI execution (P0) | Account operator + GitHub Support | Verify account/repository Actions settings and investigate failed job IDs | A hosted job executes `Set up job` and publishes step logs |
| B — Proxy correctness (P0) | [PR #4](https://github.com/brendadeeznuts1111/Sports-desk-ops/pull/4), stacked on #3 | Preserve typed config/URL/tunnel errors through manager, portal, replay; test timeout and TLS boundaries | Targeted Bun 1.4.4 tests, including combined stack, pass |
| C — Runtime (P1) | [PR #10](https://github.com/brendadeeznuts1111/Sports-desk-ops/pull/10) | Same-commit 1.4.4 vs 1.4.5 behavior comparison | Reproducible native tests + hosted gates |
| D — Performance (P2) | [PR #9](https://github.com/brendadeeznuts1111/Sports-desk-ops/pull/9) | Semantic parity + isolated two-process latency evidence | Paired runs with exact OS, Bun, fixture, exit codes |
| E — Development instructions (P1) | [PR #11](https://github.com/brendadeeznuts1111/Sports-desk-ops/pull/11) | Evidence-first review rules and PR gate provenance | Docs checks + independent review |

These are **workstream assignments by ownership role and PR**, not claims that separate human teammates or autonomous agents have accepted tasks. The fork has GitHub Issues disabled, so the issue-like checklist is tracked in this draft PR and the existing PRs.

## Immediate account/operator action

1. Open [SportsDesk → Settings → Actions → General](https://github.com/brendadeeznuts1111/Sports-desk-ops/settings/actions) and confirm Actions is enabled and the applicable allowed-actions policy permits the workflow's referenced actions.
2. Check the GitHub account's billing/Actions usage and any repository or account restriction notices. Standard GitHub-hosted runners in public repositories are ordinarily free; do not presume that a billing limit caused this incident.
3. If the page says Actions is disabled by GitHub for the repository or account, **do not repeatedly toggle permissions**. GitHub's documentation says that may be a separate GitHub-controlled disabled state; contact Support.
4. Submit [GitHub Support](https://support.github.com/contact) with the packet below and request account/runner-side telemetry for the exact job IDs. Include screenshots of any account banner or restrictions.
5. Once provider access is restored, rerun **one** PR with pinned Bun and collect a complete job log. Only then proceed to code-level CI triage.

References: [Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), [GitHub Actions support](https://docs.github.com/en/actions/how-tos/get-support), [workflow log documentation](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs).

### GitHub Support packet (ready to submit)

**Subject:** GitHub Actions jobs fail before runner steps across three repositories under `brendadeeznuts1111`

**Message:** We observe repeated `startup_failure` in `brendadeeznuts1111/bookdeskops` and `brendadeeznuts1111/silver-tulip-slate-terra`, plus immediate `failure` with no recorded steps and `BlobNotFound` logs in `brendadeeznuts1111/Sports-desk-ops`. Runs: 44337687476, 44551182587, 44558696791. The latter's `verify-changed` job 135681695670 was rerun once (attempt 2, replacement job 135700313540) and again had no steps/log URL. Different repository/owner `bw496915-cmyk/Sports-desk-ops` ran CI successfully on run 44441102131. Please check whether Actions execution is disabled or restricted for the account/repositories and inspect pre-runner provisioning/permission telemetry. We cannot isolate a failing workflow command because none executed visibly. Please provide the precise remediation and let us know when a minimal hosted job can execute.

## Definition of done and holds

- [x] Reproduced the failure pattern across three repositories under the same account.
- [x] Identified a successful control run under a different account.
- [x] Retried one job once and recorded the failed replacement job.
- [ ] Account Actions settings and restriction banners inspected by account operator.
- [ ] GitHub Support response/telemetry collected if no settings cause is evident.
- [ ] At least one hosted job executes and records a setup step.
- [ ] Bun 1.4.4 test results obtained from the intended Linux environment.
- [ ] Only then re-evaluate held code PRs for merge.

**No deployment, no credentials, no production Fantasy402 mutation, and no speculative modification of the existing CI workflows.**
