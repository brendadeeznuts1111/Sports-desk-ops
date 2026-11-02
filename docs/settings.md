# Settings — the portal modal and what this repo does with it

The portal's gear menu opens a `#update-settings` modal with five controls. Four are persisted on the
manager account; the fifth never leaves the browser. This dashboard models the four, applies them
locally, and writes nothing back to the portal.

## The portal contract

Evidence is the portal's own `manager.js`, pinned at
`verification/manager-boot-oracle/pinned/manager.js` (function `updateBasicSettings`), plus the modal
markup captured from `manager.html`. No HTTP capture of this operation exists in this repo, so the
response shape is unknown — see [Not captured](#not-captured).

| Control            | `data-field`        | Persisted by the portal? | Values                                           |
| ------------------ | ------------------- | ------------------------ | ------------------------------------------------ |
| Wager Alerts       | `notify-flag`       | yes                      | `Y` / `N`                                        |
| Language           | `language`          | yes                      | `English`, `Spanish`, `Chinese (Simp)`, `French` |
| Time Zone          | `timezone`          | yes                      | `0`–`3` = `(EST)`, `(CST)`, `(MST)`, `(PST)`     |
| Agent Menu         | `agent-menu-style`  | yes                      | `Left Menu` / `Tile Menu`                        |
| Go to desktop view | `desktop-view-flag` | **no**                   | `M` = with left menu, `L` = when in landscape    |

The write is `POST /qubic/api/Manager/updateBasicSettings` (base path `/qubic/api/Manager/`),
form-encoded, with these fields:

```text
language=<value>&timezone=<0-3>&menu=<Left Menu|Tile Menu>&notifyFlag=<Y|N>&agentID=<id>&operation=updateBasicSettings
```

Two details of that handler matter more than the field list:

1. **`desktop-view-flag` is not in the request.** The portal keeps it in
   `localStorage["G0-DESKTOP-VIEW"]` (default `M`) and reacts to the browser orientation itself. Only
   the four server-side controls are sent. The modal also removes the desktop-view row while
   `Tile Menu` is active, so the two controls are coupled in the UI but not on the wire.
2. **The success callback never inspects the response.** It assigns
   `authorizations.NotifyVipBets`, `accountInfo.AgentMenuStyle`, `accountInfo.TimeZone` and
   `accountInfo.Language` from the values it just sent, with no status check and no error branch. A
   rejected save therefore looks saved until the next page load. That is a fact about the portal's
   code, not a claim about how often it happens.

## `NotifyVipBets` is the Wager Alerts flag, not the VIP list

The name invites a conflation worth heading off. `updateBasicSettings` copies the Wager Alerts
selector (`notify-flag`, `Y`/`N`) into `authorizations.NotifyVipBets`, so that authorization is "will
this account be notified", not "which customers are VIP".

The VIP list itself is a separate surface with its own write, observed 2026-11-01: the Analysis
screen's `show-vip` button opens it, and saving sends three requests —
`POST /cloud/api/Manager/vipListInsert` (JSON, `{"list":[…]}`), then `POST /cloud/api/Log/writeDetail`
(form-encoded, the same list inside the `data` field) and `POST /cloud/api/Log/write` (JSON,
`description: "Save Action / Vip List [ v1.0.280 | fantasy402.com ]"`). The ack is `{"INFO":""}` — an
empty string, which is consistent with success but does not establish it. This repository records
that flow and never replays it.

The two surfaces do share state downstream: the bet ticker carries a `VIP` column, and all 17 rows of
the salvaged ticker paste read `"0"`, so the repo has never seen the list populated.

## What this dashboard does

Source: `lib/settings_prefs.ts` (vocabulary, validation, timezone rendering) and the Settings panel in
`static/customer-churn-simulation-dashboard.html`.

- Preferences are stored in `localStorage["sportsdesk-dashboard-settings"]`. Nothing is POSTed: this
  repo is read-only against production unless a task is explicitly a deploy, and a settings write is
  an account mutation.
- **Confirm** persists and applies immediately, then re-renders every panel through a
  `sportsdesk-settings` event, so timestamps change without waiting for the next poll. **Revert**
  clears the key and returns to the portal's defaults (`Y`, `English`, `1` = CST, `Left Menu`).
- `readSettings` validates stored values and falls back per field: an unknown timezone becomes the
  default rather than throwing or rendering `undefined`.

What each preference actually changes, from `SETTINGS_EFFECTS`:

| Preference   | Effect in this dashboard                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| Wager Alerts | Shows or hides the Telegram dispatch buttons. Sending still requires the admin token.  |
| Language     | Sets `<html lang>` and nothing else. No strings are translated, and the panel says so. |
| Time Zone    | Shifts every timestamp the dashboard renders (`sdFormatTs`), including capture times.  |
| Agent Menu   | Switches the panel layout between one column and a tile grid.                          |

Two limitations are stated rather than papered over:

- **The time zone is a fixed UTC offset**, so it does not follow US daylight saving. The portal's
  selector has the same limitation — it stores `0`–`3`, not an IANA zone.
- **Language does not translate.** Machine-translating domain terms (`Exposure`, `Hold`, `Void`) into
  four languages would produce confidently wrong labels, so the selector sets the document language
  and the UI stays in English until real strings exist.

`desktop-view-flag` is deliberately not modelled: it controls mobile orientation behaviour, and this
dashboard is a desktop surface. It is listed here so its absence is a decision rather than an
oversight.

## Not captured

`POST /qubic/api/Manager/updateBasicSettings` is not in `docs/openapi.json`. Capturing it requires a
deliberate write on a controlled test account, with the operator's approval, and the ledger row would
then move from inferred to captured. Until then:

- The request field names above come from the portal's `manager.js`, not from a wire capture.
- The response is unknown. Nothing here asserts a status, a body or an error shape.
- The dashboard does not call the operation, so no capture is needed to run it.

## Reproducing

```sh
bun test lib/settings_prefs.test.ts                # vocabulary, validation, timezone maths
bun test tests/dashboard_live_desk.test.ts          # panel wiring + drift against the module
bun run manual:fetch                                # re-check the vendor manual digest
```

The drift tests evaluate the panel's inline `ZONES`, `LANGS` and `DEFAULTS` literals and compare them
with `TIMEZONES`, `LANGUAGES` and `DEFAULT_SETTINGS`. The page cannot import the module, so it carries
a copy; the test is what keeps the copy honest.
