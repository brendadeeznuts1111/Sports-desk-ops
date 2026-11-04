# 6. Re-prioritized roadmap (provisional)

One page. Provisional because item 2's Bearer verdict — the input that can reorder everything —
could not be measured here. Items 1, 3 and 5 are enough to move two workstreams, though.

## What the measurements say

1. The controls in flight defend **one actor** (player XSS on a Chromium path) and **one supply-chain
   path** (asset swap). They do not defend the actors with the most authority: subordinate-agent
   tampering, stolen sessions, ATO, insider access (item 1).
2. The **financial gap outranks every XSS in flight**: no reconciliation invariant exists in this
   repo, and the financial mutations have no captured wire evidence; the only audit is a
   client-issued, forgeable `Log/write` after success (item 3).
3. The client is **not** an authorization boundary: it rewrites identity fields and permits a caller
   to preserve `agentOwner`; whether the server trusts the body is unmeasured (item 2).
4. Detection exists for assets, not for authority or money: only the pin gate has both detection and
   a playbook (item 5).

## Ordering

| #   | Workstream                                                                                      | Current state                                               | Verdict from items 1–5                                                                                                                                           | Action                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0   | **Inputs**: test account + proxy authorization; server question; business-owner ledger question | absent                                                      | Every measurement below is blocked without these                                                                                                                 | **Raise / unblock first**                                              |
| 1   | **Black-box authz matrix** (item 2)                                                             | designed, unexecuted                                        | Decides whether actor 2 is bounded; can invalidate the priority of every client control                                                                          | **Raise to top** — 2 days once inputs exist                            |
| 2   | **Financial ledger + reconciliation invariants** (item 3)                                       | no invariant found; client log only                         | Outranks XSS per the task's rule; also the only control against actor 6                                                                                          | **Raise to top, in parallel** — business owner + server work           |
| 3   | **`data-pass` / `Password` removal** (upstream)                                                 | not done                                                    | Removes a live credential exposure independent of authz; also shrinks ATO reuse                                                                                  | **Keep P0, upstream**                                                  |
| 4   | **SRI / pin gate** (existing)                                                                   | shipped, green                                              | The only production control with detection **and** a playbook; regression value                                                                                  | **Keep, maintain only** — no expansion                                 |
| 5   | **Sink migrations** (`searchComponent`, then four)                                              | seam escaper ready; `searchComponent` not migrated          | Real XSS risk, but the task explicitly forbids migrating before the Bearer answer; if item 2 says claim-derived, this is the main remaining authority-theft path | **Pause until item 2 verdict**, then resume at `searchComponent` first |
| 6   | **External-view guard canary + further seam hardening**                                         | guard landed dead by default; canary blocked on credentials | One Chrome-only module-load hole; not load-bearing for actors 2/4/5/6                                                                                            | **Pause** — leave the landed code dead; do not spend more cycles       |
| 7   | **WebKit injection path**                                                                       | scoped by census; not started                               | Depends on item 2 and a real backend census; premature before authz/financial work                                                                               | **Pause** — re-scope after items 1–2                                   |
| 8   | **Detection layer** (reject-rate, session lifecycle, financial alerts, agent-tree canary)       | design only                                                 | Directly addresses actors 2/3/5/6; needs server/vendor cooperation                                                                                               | **Raise with items 1–2**, not as client-only work                      |

## Recommendation: pause client-side security work pending item 2's Bearer verdict

This is one decision, not six. The seam, guard, pin gate and SRI work address **one of the six
actors** in the adversary model. The two highest-authority actors — subordinate-agent tampering
(actor 2) and the inside operator (actor 6) — have **no detection and no stopping control** in the
evidence. Continuing to build against the wrong actor spends effort that item 2 may reallocate.

**Paused until item 2 answers:** the WebKit injection path, the external-view canary, and further
seam or pin expansion. WebKit resumes once item 2 confirms the Bearer is load-bearing (client work
matters) or shows the server trusts client-supplied identity (client work is cosmetic and the
roadmap changes shape).

**Override 2026-11-04 — sink migrations are unpaused as hygiene work:** escaping `NameFirst`,
`Login`, `Password`, message bodies and history titles is correct regardless of the Bearer verdict;
only the _priority_ of the sink work depends on item 2. Verify `searchComponent` (#16), then land
`setHistory` first as the pattern confirmer, followed by `getMessageInit`, `getPopUpMessages`,
`setCommunicationMessages` — one PR each, each with a sink test.

**Sink status (2026-11-04):** `searchComponent` escapes `NameFirst`, `Login`, `Password`,
`customerID` and `AgentID`; `setHistory` escapes only the title and leaves the `getHistory` argument
raw; `getMessageInit` uses the **render-copy** pattern (escaped copies for the dropdown render,
`emailCount` restored raw after the synchronous success handler); `getPopUpMessages` escapes the
`getMessage` response fields **before** the original newline-to-`<br>` replacement, so `<br>` stays
markup and raw `<b>`/Subject/Id become text; `setCommunicationMessages` escapes only `Message`
(via `.html()`), while `Id` stays raw because `.attr("data-id", value)` is an attribute setter, not
an HTML sink — escaping it would break the later `mail.delete({id})` call. The async modal fetch is
outside the synchronous `setCommunicationMessages` body, so the "hardest sink" framing is withdrawn. `searchComponent` carries two accepted costs: (1) the search filter compares against escaped
values, so a literal `&`/`<` in a name/password no longer matches — **accepted by the desk security
owner (operator role), 2026-11-04**, mitigation search-by-login, escalate if agents report failures;
(2) the `players`/`agents` arrays hold escaped values after setup — new code must not read those
fields directly (the pinned `setPlayers()` does, and can show escaped text for special characters).
Recorded in #16; the array landmine is live for anything reading the module-level `players`/`agents`
arrays (searchComponent does). **But `setPlayers()` is not one of them:** it takes its argument from
hierarchy nodes; the hierarchy success sets the global array and then clears non-master node
`players` to `[]` before lazy expansion; GENERAL rows in the captured envelope carry no `players`
key (0/2,466); `getPlayers()` has no call sites. The `setPlayers()` direct-read risk is therefore
**theoretical**, not live. A browser check settles the display question: escaped `Login = "A&B"`
renders as text `A&B` (not `A&amp;B`), `id`/`for` attributes decode to `c&d`, label association and
`getElementById` work. Only a raw `#id` jQuery/CSS selector containing `&`/`<` would differ, and
`setPlayers()` does not use one. Prefer render-copy for new sinks regardless.

**Render-copy decision:** adopted for `getMessageInit` (escaped copies for the dropdown render,
`emailCount` restored raw). `getPopUpMessages`, `setCommunicationMessages`, `searchCustomer` and
`getCommunicationMessages` are splicers, so they use `setHistory`-style per-field escape at the
template/sink boundary. The arrays landmine and parser-semantics questions disappear for
render-copy paths.

**`searchCustomer` (fullscreen search):** **live in the pinned controller** and bound at boot to
`[data-field="search-customer"]` keyup. Migrated **defensively** (not reachability-gated):
`Login`/`Password`/`NameFirst` escaped in the `searchCustomerAdmin` response; `CustomerID` stays raw
because it is used in a jQuery `[data-customer="…"]` selector. `getCommunicationMessages` (Stamp +
popup) also landed; Lobibox source confirms `msg` is concatenated without escaping, so the popup path
was a real sink.

**Module-level sinks (2026-11-04):** `player-info.js` renders `n.Password` via `.html()` into
`[data-field="password-h"]` (plaintext on screen). Wrapped by intercepting `getInfoPlayer` success
and escaping only that selector; `.val()` and stored data stay raw. Module anchors `password-h`,
`bet-desc`, `gameReport` are now checked by `pin:cdn` against the live module bytes. `bet-desc` is
**not** an independent sink: it copies already-rendered `.gameReport` HTML into the delete modal; the
origin is `getResultTicketPending` / `getResultTicketMobileDetails`, which substitute raw
`Description`/`ChosenTeamID`/line/`Content` into the pending-row HTML. Fixing `bet-desc` alone would
not close that path — the source render is the next follow-up.

**Raised instead:** the Bearer verdict (item 2 — six requests, ~2 server-team hours) and the
financial ledger/reconciliation question (item 3). `data-pass` stays P0 upstream; the pin gate is
maintained, not expanded.

**Cost, named:** `searchComponent` XSS remains live until item 2 returns. That is a live exposure
accepted against the possibility that item 2 shows the XSS is not the crown-jewel path. The
acceptance is owned by the **desk security owner (operator role)**. **Expiry is a control, not a
clause:** the acceptance expires on **2026-12-03** (30 days from the pack). It is tracked by issue
[#17](https://github.com/bw496915-cmyk/Sports-desk-ops/issues/17) with that deadline and by a
scheduled reminder; if item 2 is not funded by then, it must be **re-opened deliberately**, not
silently extended. If the deadline is missed and re-accepted, that decision is recorded on #17.

## Unblock, by owner

The unblock is three decisions, not "waiting on access":

1. **Business owner** — provision a low-privilege test account and name the tenant/data that may be
   touched.
2. **Compliance/legal + operator** — signed scope for tamper testing (the server team saying OK is
   not the same approval).
3. **Server team lead** — ~2 hours to answer the Bearer question by test (six requests against one
   account: five read-only tampers plus one optional mutation). This is the entire technical ask for item 2.

Item 3's server-side half needs the same business owner to name the ledger, and the server team to
confirm or deny its existence.

## What the current controls credibly claim (for the PR/roadmap text)

> The seam, external-view guard, pin gate and SRI work raise the cost of stored XSS on one browser
> backend and make asset swaps visible. They do not address server authorization, financial
> reconciliation, account takeover, or insider access. The pin gate is the only one of the four with
> a detection-and-response pair; the others are prevention-only or unverified.

## Restart conditions

1. Item 2 executed and confirmed by the server team by test.
2. Item 3 answered by the business owner, with either a reconciliation that holds or a written
   finding (currently: no reconciliation in this repo).
3. Item 4's three chains executed with authorization, producing the marginal-reduction table.
4. Item 1 reviewed by an independent attacker against the executed results.

Only then should items 5–7 resume, in the order `searchComponent` → remaining sinks → WebKit
(behind a census), with `data-pass` and the financial ledger tracking upstream in parallel.
