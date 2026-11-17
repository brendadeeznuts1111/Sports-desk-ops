# Decision: does empty-wagers copy differ by provenance kind? (#275)

Status: **awaiting decision**. Nothing implemented.

## What is already true

`describeEmptyWagers` in `packages/ui/src/panels/LiveWagersTabPanel.tsx` renders one sentence for
every successful-but-empty feed:

```ts
switch (provenance.kind) {
  case "pending":
    return `Waiting for GET ${endpoint}…`;
  case "unavailable":
    return `Unavailable — ${endpoint}: ${provenance.label}`;
  default:
    return `${provenance.label} returned no wagers (${endpoint}).`;
}
```

The declared kinds are `live`, `capture`, `fixture`, `fallback`, `showcase`, `pending`,
`unavailable` — so five of seven collapse into the same sentence.

The original ticket (#222) closed as obsolete because the lint rule behind it was removed from the
type-aware config. That removal did not answer the question, which is why this one exists.

## The constraint

`provenance.label` is the only signal distinguishing a live feed from a fixture in the empty state.
A reader who skims the sentence learns "no wagers" without learning "and this is not real data."

That matters because the empty state is the one place a reader has nothing else to look at. A panel
full of wagers shows its content; a panel with none shows only the sentence.

The repo already treats this distinction as load-bearing elsewhere: `docs/` separates captured from
synthetic, and the CI notifier distinguishes `unknown` from empty rather than reporting a blank as
zero. A UI that renders fixture and live identically is the odd one out.

## Options

### A. Distinct copy per kind

```
Fixture data — no matching wagers
Captured run — no matching wagers
Live feed — no matching wagers
```

- **Claims:** the panel can be read without knowing the provenance vocabulary.
- **Cost:** five new user-facing strings to review, and a maintenance rule (a new kind needs copy).
- **Risk:** wording can overstate certainty — "captured run" implies a specific capture when the
  provenance may only say one existed.

### B. One sentence, provable label

Keep the single message, require that `provenance.label` names the source, and assert that in a test.

- **Claims:** nothing new; it makes the existing signal contractual.
- **Cost:** lowest — one test.
- **Risk:** trusts the label, which is set upstream and could drift to something like "data" without
  this test noticing what "data" means.

### C. Leave as-is

- **Claims:** the label is sufficient signal.
- **Cost:** zero.
- **Risk:** the distinction stays implicit, which is how it reads today.

## Recommendation

**A**, because the empty state is the only place the distinction can be made at all, and the desk's
audience includes people who read the panel without knowing the provenance vocabulary.

If the wording review is unwanted now, **B** is a genuine partial: it costs one test and converts an
implicit assumption into a checked one, without inventing copy.

## Acceptance criteria, whichever is chosen

- No successful-but-empty state renders without naming its provenance kind, either in the sentence
  or in a label the test pins.
- A new provenance kind added later cannot silently fall into the generic sentence — either the
  switch is exhaustive or a test enumerates the known kinds.
- The `pending` and `unavailable` states keep their distinct copy; they are not "empty", they are
  "not yet" and "failed".

## Not in scope

Reviving `switch-exhaustiveness-check`. The rule was removed from the type-aware config deliberately
(#222); this decision stands on the reader's experience, not on a gate. If the rule returns, option A
already satisfies it.
