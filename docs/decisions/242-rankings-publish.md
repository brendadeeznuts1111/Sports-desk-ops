# Decision: what may be published from the rankings artifact (#242)

Status: **awaiting decision**. Nothing here is implemented beyond the regenerate and the
provenance work; the publish step is blocked on the choice below.

## What is already true

- The artifact is regenerated from the summary-book population (#234, #269) and both files exist
  locally: `scratch/f402-customer-decision-rankings.{json,md}`.
- Provenance now carries capture facts, an explicit `scope: "unknown"` for the graded exports, and a
  `populationRestriction` block recording 70,869 → 57,633 rows and 2,181 dropped customers (#270).
- The published headline is **44.7×** over 2,096 non-CCC events, pairs **12**, verdict `SUPPORTED`.
- The 5.3× difference between 44.7× and the old 53.7× is the population, not a bug. Any sentence
  that quotes a lift without its population is wrong once both exist.

## The constraint that makes this a decision

`allCustomerRows` is **6,228 rows** whose first fields are:

```
customerId, playerLogin, agentId, skin, suspectedBot, suspectedBotType, …
```

The existing publish path — `services/sportsdesk_r2_sync.ts` — targets the `sportsdesk-ops-reports`
bucket, optionally served from `R2_PUBLIC_URL`. The in-repo precedent for publishing to it,
`scripts/publish_wagers_snapshot.ts`, carries a guard that **rejects exactly these fields**:

```js
const FORBIDDEN =
  /^(login|customerid|customer|agent|agentid|agentlogin|ticket|…|ipaddress|userid)$/i;
```

So the artifact cannot be published through the existing pipeline without either failing that guard
or, if bypassed, publishing 6,228 customer logins and per-customer betting metrics to a publicly
readable bucket. Neither is acceptable; only one is loud.

## Options

### A. Private destination

Publish the full artifact to a non-public bucket with signed or pre-authenticated access.

- **Publishes:** everything, including the customer roster.
- **Needs:** a bucket, an access mechanism, and a client path that is not `r2:sync`.
- **Consequence for the report:** unchanged content, new distribution risk surface. Access control
  becomes the thing that can fail, and it fails silently.
- **Cost:** highest of the three.

### B. Redacted / aggregate artifact for public consumption

Drop `customerId`, `playerLogin`, `agentId`; publish distributional results, the headline with its
population, the digest and the population restriction.

- **Publishes:** the answer, not the roster.
- **Needs:** a projection step (allowlist the fields that may leave) plus a guard asserting no
  forbidden key reaches the payload.
- **Consequence for the report:** the headline is publishable and the "report no longer lies" claim
  holds for anyone outside the desk. Per-customer findings stay local.
- **Cost:** lowest; uses the existing pipeline honestly rather than carving a private one.
- **Risk:** an allowlist that is too generous silently leaks again. Mitigation: fail closed, and
  assert the frozen set in a test.

### C. Do not publish; distribute by hand

Regenerated locally, digest recorded, no channel.

- **Publishes:** nothing.
- **Consequence:** only consumers who already have repo access see the corrected numbers. Everyone
  reading a copy elsewhere keeps the pre-#234 version, which is the exact problem #242 was filed for.

## Recommendation

**B.** The artifact is a report about the book, read for its headline by people who do not need the
roster. B keeps the existing `r2:sync` path honest instead of adding a private one whose access
control can fail quietly, and it makes the corrected headline reachable — which is the point of the
issue.

Take A only if a named consumer genuinely needs per-customer rows; take C only if no one outside the
repo reads it.

## Acceptance criteria for whichever is chosen

- The publish step **refuses** an artifact without `populationRestriction`, so a pre-#234 number can
  never be republished.
- The payload is checked against a forbidden-key list and fails closed, with the offending keys
  named.
- The published document states the lift **with its population** (44.7× / 2,096 events / 12 pairs)
  and carries the digest.
- A dry run prints key, byte size and digest without uploading.

## Blocked in this environment

No R2 credentials are present (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_R2_API_TOKEN`, `R2_BUCKET_NAME` all unset), so even option B is dry-run-only here.
