# Executive summary — defense measurement, 2026-11-03

**Read this page, not the pack.** The pack is evidence; this is the decision surface.

## Bottom line

The client-side security work in flight is well-built but **aimed at one of six actors**. It cannot
protect against the two actors with the most authority (a subordinate agent tampering with
identity fields, and an insider with database/support access), and the only audit path the client
has for money operations is a claim the client itself writes. Before spending more on client
controls, two questions must be answered by people outside engineering:

1. **Does the server authorize on the Bearer's claims, or on client-supplied identity?**
2. **What reconciles the ledger — and does it exist?**

## What was actually measured

- The client repo has **no reconciliation invariant** for `updateDistribution`, `deleteWager`,
  `getSettledFigure`, `adjustBalance`.
- The only audit path for `updateDistribution` is a **client-issued `Log/write` after AJAX success**:
  non-atomic, forgeable, omittable. A malicious client skips it; a crashed tab loses it; a retry
  double-writes it. **This is a claim, not a ledger entry.**
- Whether the **server** has a reconciliation or trust boundary is **unknown** — no test was run,
  because no test account or authorization exists. The pack labels this _not executed, by design_.
- Detection exists for **asset swaps** (pin gate), not for authority tampering, financial actions,
  account takeover, or insider access.

## The pause, and its cost

**Recommendation:** pause client-side security work pending the Bearer verdict.

- **What is paused:** WebKit injection path, external-view canary, further seam/pin expansion.
- **Override (2026-11-04):** the five sink migrations are **unpaused as hygiene work** — escaping is
  correct regardless of the Bearer verdict; priority may change when item 2 returns. `searchComponent`
  lands first.
- **Cost:** `searchComponent` XSS stays live until the verdict returns.
- **Accepted by:** desk security owner (operator role).
- **Expires:** **2026-12-03** (30 days). Tracked on issue
  [#17](https://github.com/bw496915-cmyk/Sports-desk-ops/issues/17); if the verdict is not funded by
  then, the acceptance must be re-opened deliberately — not extended by nobody noticing.

## Three decisions, with owners and hours

| #   | Decision                                                              | Owner                           | Ask                                                                       | Time         |
| --- | --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ------------ |
| 1   | Provision a low-privilege test account and name the tenant/data scope | **Business owner**              | One account, disposable data, named environment                           | ~1 hour      |
| 2   | Authorize tamper testing                                              | **Compliance/legal + operator** | Written scope; server-team OK is not the approval                         | ~1 hour      |
| 3   | Answer the Bearer question by test                                    | **Server team lead**            | Six requests against one session (five read-only + one optional mutation) | **~2 hours** |

If those three hours exist, item 2 can return within a week. If they do not, the pack's job is to
make that visible: the client controls remain, the exposure remains, and no further client
engineering will change which actors can reach the money.

## What happens if we don't do this

- Subordinate-agent tampering and insider financial changes have **no detection and no stopping
  control** in the evidence.
- `searchComponent` XSS remains live while we build controls for the wrong actor.
- The roadmap cannot be re-ordered honestly; every client item keeps its current priority by default.

## When the verdict returns

- **Bearer (claim-derived):** the pause lifts, client work resumes, and `searchComponent` lands first
  — it is then genuinely the highest-value remaining XSS fix. WebKit and the canary follow.
- **Client-supplied:** the roadmap changes shape. The next task is a **server-authz ticket**, not
  another client control, and the pack's "raise" list becomes the whole roadmap.

## Evidence

[docs/analysis/defense-measurement-2026-11-03/README.md](./README.md) — adversary model, authz test
design and six-request minimum, financial audit with money tiers, attack-exercise protocol, detection
gaps, provisional roadmap. Items 2 and 4 are explicitly unexecuted; do not cite them as results.
