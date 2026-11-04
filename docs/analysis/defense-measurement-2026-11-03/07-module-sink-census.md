# Module-level sink census — 2026-11-04

The controller-only audit found seven sinks in `manager.js`; `password-h` in `player-info.js` was
found by a targeted probe, not by an audit. This census covers the lazily loaded
`/app/manager/module/*.js` surface.

## Method

- Modules: the 29 `manager/module/*.js` assets in `pinned/cdn-manifest.json`, fetched live for vendor
  **1.0.281** (`/tmp/modules` this session; the manifest pins hashes, not bodies).
- Counts: `.html(` plus `.append(`/`.prepend(` occurrences; then for each `.html()` call, inspect the
  next 700 characters for a player-adjacent field (`NameFirst`, `Login`, `Password`, `Note`,
  `Comments`, `Description`, `Message`, `Subject`, `FromE`, `AgentLogin`, `CustomerID`,
  `ChosenTeamID`).
- A proximity hit is a **candidate**, not a confirmed sink. The call may be a static label, a copy of
  already-rendered DOM, or a field that is system-assigned.

## Results (top by `.html()` count)

| Module                     | `.html()` | `.append` | candidate `.html()` calls | fields seen nearby                                                   |
| -------------------------- | --------: | --------: | ------------------------: | -------------------------------------------------------------------- |
| `game-admin.js`            |       219 |        21 |                        21 | `ChosenTeamID`, `Description`                                        |
| `agent-management-thin.js` |       118 |        40 |                        18 | `Comments`, `CustomerID`, `Description`, `Login`, `Password`         |
| `player-info.js`           |       108 |        45 |                        22 | `AgentLogin`, `Description`, `FromE`, `Login`, `Message`, `Password` |
| `pending-thin.js`          |        28 |        17 |                        10 | `ChosenTeamID`, `CustomerID`, `Description`, `Login`, `Password`     |
| `agent-performance.js`     |        28 |        58 |                         3 | `Description`                                                        |
| `add-customer.js`          |        16 |         2 |                         7 | `CustomerID`, `Login`                                                |
| `customer-admin.js`        |        11 |         2 |                         7 | `AgentLogin`, `Comments`, `CustomerID`, `Login`, `Password`          |
| `transaction-history.js`   |        11 |        20 |                         2 | `CustomerID`, `Description`, `Login`                                 |
| `message.js`               |         7 |        11 |                         7 | `FromE`, `Login`, `Message`                                          |
| `delete-wager.js`          |         6 |         8 |                         0 | —                                                                    |

**Totals:** 29 modules, **651 `.html()` calls**, **98 candidate calls** with a player-adjacent field
in the window. The remaining modules have 0–5 `.html()` calls.

## Known findings already classified

- `player-info.js` `password-h` — confirmed `.html(n.Password)` sink; **fixed** in the overlay
  (`7c8b6ad`), restore-on-throw test added, module anchor present.
- `pending-thin.js` `bet-desc` — copy of `.gameReport`; **anchor-protected but not closed**. Source
  render `getResultTicketPending`/`getResultTicketMobileDetails` is the fix; tracked as its own
  ticket.
- `delete-wager.js` `data-ticket` — string-concatenated table; no `Note`/`Comments` field in the
  module; classified system/game data pending a server-schema check.
- Select2 demo (`escapeMarkup` identity, `http://api.github.com`) — cached `transaction-history-main`
  fragment, absent from `manager.html` and the pinned graph; cleanup-only/latent.

## Next audit order

1. `game-admin.js` and `agent-management-thin.js` — most candidate calls, `Login`/`Password`/
   `Description` nearby.
2. `player-info.js` beyond `password-h`, `customer-admin.js`, `message.js`.
3. `pending-thin.js` source render (tracked).
4. Re-run this census after each module wrapper lands; a count reduction is not the success metric —
   the success metric is each candidate classified as escaped / system-only / copy.

## Re-run

```sh
# modules must be fetched first; /tmp/modules is the live 1.0.281 set from this session
bun -e '
const $=Bun.$;
const files=(await $`find /tmp/modules -maxdepth 1 -name "*.js"`.text()).trim().split("\n").filter(Boolean);
const fields=/NameFirst|Login|Password|Note|Comments|Description|Message|Subject|FromE|AgentLogin|CustomerID|ChosenTeamID/g;
for(const f of files){const t=await Bun.file(f).text();const html=[...t.matchAll(/\.html\(/g)];let c=0;const s=new Set();
for(const m of html){const w=t.slice(m.index,m.index+700);const h=[...new Set(w.match(fields)||[])];if(h.length){c++;h.forEach(x=>s.add(x));}}
if(c) console.log(c, f.split("/").pop(), [...s].join(","));}'
```
