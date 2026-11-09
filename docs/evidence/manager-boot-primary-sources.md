# Manager boot — primary sources (de-digest)

Hypotheses from prior summaries are verified against **downloaded artifacts** (2026-11-01) or marked **unresolved**. No `getListAgenstByAgent` **response body** exists in this repo; variance across N sessions is **not computed here**.

## Artifacts fetched (reproducible)

```bash
BASE=https://www.fantasy402.com
BUST=1.0.280
curl -fsSL "$BASE/app/setting/version.js?bust=$BUST"          # version:"1.0.280"
curl -fsSL "$BASE/app/setting/config-manager.js?bust=$BUST" # requirejs → main-manager
curl -fsSL "$BASE/app/main-manager.js?bust=$BUST"
curl -fsSL "$BASE/app/manager/manager.js?bust=$BUST"         -o manager.js
curl -fsSL "$BASE/app/util/util.js?bust=$BUST"
curl -fsSL "$BASE/app/system/security.js?bust=$BUST"
curl -fsSL "$BASE/app/manager/manager.js?bust=1.0.279"      -o manager-1.0.279.js
```

| File                          |  Bytes | SHA-256                                                            |
| ----------------------------- | -----: | ------------------------------------------------------------------ |
| `manager.js` (`bust=1.0.280`) | 100121 | `82c3d4ec9b5d0531b06219761f0b40db20bf07f4f4250eacdabf527e90e01937` |
| `manager-1.0.279.js`          | 100121 | **identical** to 1.0.280 (byte match)                              |

`manager.html` loads RequireJS with `urlArgs: 'bust=' + (new Date).getTime()` on the HTML shell, but `setting/version.js` pins `version:"1.0.280"` and `config-manager.js` sets `urlArgs:"bust="+e.version` → module URLs use **`bust=1.0.280`**, not the HTML cache-bust query.

## Hypothesis ledger

| Claim                                            | Verdict                                       | Source                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle `path` is `/qubic/api/Manager/`           | **Confirmed (source string)**                 | `manager.js` byte **253**: `path:"/qubic/api/Manager/"`                                                                                                                                                                                                                                                                                                                                                                       |
| Live host serves API at `/cloud/api/Manager/`    | **Confirmed (wire)**                          | Unauthenticated POST: `/qubic/.../getListAgenstByAgent` → **404**; `/cloud/.../getListAgenstByAgent` → **401** (2026-11-01 curl). Sniffer templates: `docs/evidence/captures/schema/_sniffed_form_templates.json` paths under `/cloud/api/Manager/`.                                                                                                                                                                          |
| `qubic` → `cloud` before XHR sends               | **Confirmed (mechanism)**                     | `system/security.js` `$.ajaxPrefilter`: `t.url=t.url.toString().replace("qubic", a.apiPath.replace(/\//g,""))` with `util.js` `apiPath:"/cloud/"` → substring **`qubic` → `cloud`**.                                                                                                                                                                                                                                          |
| `getCompleteHeriarchy` POST body                 | **Confirmed**                                 | `manager.js` byte **60338** (`getCompleteHeriarchy:function`): `{ agentID, agentType, operation:"getListAgenstByAgent", RRO:n.RRO }`; `url:a.path+s.operation` (prefilter rewrites to `/cloud/...`).                                                                                                                                                                                                                          |
| **`RRO` per-agent?**                             | **No (client)**                               | All Manager POST builders use `RRO:n.RRO`; `getCompleteHeriarchy` ignores `e.RRO`. See [`manager-boot-rro-audit.md`](./manager-boot-rro-audit.md).                                                                                                                                                                                                                                                                            |
| **`RRO` typically 1**                            | **Confirmed (client constant)**               | `util.js`: `RRO:1` in config object; ajax uses `RRO:n.RRO`.                                                                                                                                                                                                                                                                                                                                                                   |
| **Bust / version drift**                         | **Hash-pinned**                               | `manifest.json` artifacts; `fetch:pinned-portal` splits **`F402_PORTAL_TLS_TRUST_DRIFT`** vs **`F402_PORTAL_BUNDLE_BYTE_DRIFT`**; `portal:drift:cron` always-on signal.                                                                                                                                                                                                                                                       |
| **Oracle runtime pin**                           | **Manifest `runtime`**                        | `bun.version`, `bun.revision`, `process.versions.webkit` (JSC); gates call `assertPortalRuntimePin`.                                                                                                                                                                                                                                                                                                                          |
| **Replay auth**                                  | **Profile-first**                             | `F402_WEBVIEW_PROFILE` + `Bun.FetchSession` dataStore; optional `F402_REPLAY_PROXY_URL`; **`F402_COOKIE` deprecated**.                                                                                                                                                                                                                                                                                                        |
| **HAR capture (gate i)**                         | **Pipeline proof**                            | `capture:f402-har` → sweep → proof JSON; `verify:manager-har-redaction-proof`; exit **10** BLOCKED vs **1** FAILED — [`manager-boot-har-capture.md`](./manager-boot-har-capture.md)                                                                                                                                                                                                                                           |
| **HAR redaction**                                | **Spec**                                      | [`manager-boot-har-redaction.md`](./manager-boot-har-redaction.md)                                                                                                                                                                                                                                                                                                                                                            |
| **Replay scaffold**                              | **dry / replay / oracle**                     | `scripts/capture/f402_hierarchy_replay.ts` (`bun run hierarchy:replay`)                                                                                                                                                                                                                                                                                                                                                       |
| **Slice ↔ pin coupling**                         | **pretest guard**                             | `verify:manager-oracle-slices` — re-slice `pinned/manager.js`, diff `extracted/*`; hashes in manifest                                                                                                                                                                                                                                                                                                                         |
| **Live bundle drift**                            | **Signal + throw**                            | stderr `F402_PORTAL_ARTIFACT_DRIFT`; probe fetch throws unless `F402_DRIFT_RECORD_ONLY=1`                                                                                                                                                                                                                                                                                                                                     |
| **Production oracle gate (e)**                   | **Blocked**                                   | `verify:manager-oracle-production` — `captureActor` + `assertProductionOracleFixtureRedaction` then oracle (`productionOracleGate` in manifest)                                                                                                                                                                                                                                                                               |
| **Variance gate (g)**                            | **Blocked**                                   | `verify:manager-oracle-variance` — N≥3 redacted HARs (`varianceGate` in manifest); [`manager-boot-variance-gate.md`](./manager-boot-variance-gate.md)                                                                                                                                                                                                                                                                         |
| **CI slice guard (f)**                           | **Wired**                                     | `.github/workflows/ci.yml` runs `verify:manager-oracle-slices`                                                                                                                                                                                                                                                                                                                                                                |
| **`getListAgenstByAgent` typo on wire**          | **Confirmed**                                 | Literal in `manager.js` byte **60503** (`operation:"getListAgenstByAgent"`).                                                                                                                                                                                                                                                                                                                                                  |
| **`getHeriarchy` typo (separate op)**            | **Confirmed**                                 | `manager.js` byte **33085**: `operation:"getHeriarchy"` (not `Hierarchy`). Response `e.LIST` → `setHeriarchy`.                                                                                                                                                                                                                                                                                                                |
| **`getCompleteHeriarchy` from `setAccountInfo`** | **Partially confirmed**                       | **Not** called directly in `setAccountInfo:function` (byte **23515**). **`main-manager.js`**: `getAccountInfo` → `language.change` → **`call: u.setAccountInfo`**. Inside `setAccountInfo`, **`.settings()`** is invoked; **`getCompleteHeriarchy`** runs inside **`settings:function`** (byte **25097**), byte **29014**: `"Tile Menu"===...?setTimeout(function(){e.getCompleteHeriarchy()},500):e.getCompleteHeriarchy()`. |
| **500ms delay for Tile Menu**                    | **Confirmed (`setTimeout`)**                  | Same line: `setTimeout(..., 500)` only when `AgentMenuStyle === "Tile Menu"`; else immediate `getCompleteHeriarchy()`.                                                                                                                                                                                                                                                                                                        |
| **Level 1–12 in tree builder**                   | **Confirmed (`baseHeriarchy`)**               | **12** branches `===v.Level` (levels 1–12) in `baseHeriarchy:function` (byte **61664**). **`buildTree`** caps depth with `if(n>13)return[]` (byte **61357**) — different structure (uses `Master`, `AgentType=="M"`).                                                                                                                                                                                                         |
| **`PLAYERS` scale**                              | **Confirmed (`F402_PLAYERS_MODE` qualified)** | Projected boot capture i′ (`F402_PLAYERS_MODE=projected`): ~5.7k `PLAYERS` / ~2.5k `GENERAL` (`F402_PLAYERS_TYPICAL_COUNT`); full unprojected `getListAgenstByAgent` envelope (`F402_PLAYERS_MODE=full`, `raw-f402-list-agents.json`): `57,763` `PLAYERS` / `2,466` `GENERAL`.                                                                                                                                                |
| **`SeqNumber` = 5183 + index**                   | **Unresolved (not client logic)**             | Not referenced in `getCompleteHeriarchy` / `baseHeriarchy` slices; portal uses **`Level`**, **`AgentID`**, **`Login`**. Needs N response captures.                                                                                                                                                                                                                                                                            |
| **`getAccountInfoOwner` response**               | **Unresolved (no raw body in repo)**          | Request shape: sniffer `application/json` keys `agentID`, `operation`; `manager.js` byte **22773** area `operation:"getAccountInfoOwner"`. **No** committed raw JSON response artifact found under `docs/evidence/captures/`.                                                                                                                                                                                                 |

## Call graph (source-backed)

```
main-manager.js
  u.getAccountInfo({ setLenguage:true, func → language.change({ call: u.setAccountInfo, ... }) })
setAccountInfo (manager.js ~23515)
  … → .settings()
settings (manager.js ~25097)
  … → setTimeout(getCompleteHeriarchy, 500) | getCompleteHeriarchy()
getCompleteHeriarchy (manager.js ~60338)
  $.ajax POST path+getListAgenstByAgent  [security.js prefilter → /cloud/api/...]
  success: players=e.PLAYERS; setCompleteHeriarchy({data:e.GENERAL}); agents=e.GENERAL
setCompleteHeriarchy (manager.js ~60884)
  baseHeriarchy({data:o}); UI searchComponent / completeHeriarchy
```

Parallel (not the big envelope): **`getHeriarchy`** (~32970) → `{LIST}` only.

## Oracle (before parser code)

**Replace** “my tree vs unspecified tree” with the bundle’s **`baseHeriarchy`** output.

| Role              | Oracle                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary**       | Run extracted **`baseHeriarchy({ data: GENERAL })`** (and its returned agent map / side effects on `f[...]`) in a JS sandbox with the **same** `GENERAL` array as the capture. Parser or tree code must produce a **canonical JSON serialization** of that oracle output; diff must be **empty** after normalizing key order. |
| **Secondary**     | **`buildTree`** is a **different** algorithm (Master-linked, max depth 13); do **not** use as primary oracle unless the UI path under test is explicitly `buildTree`.                                                                                                                                                         |
| **Not an oracle** | `SeqNumber` ordering, normalized camelCase rows, or `summarizeListAgentsByAgent` stats — useful for audits, not portal parity.                                                                                                                                                                                                |

Extraction boundary: copy `baseHeriarchy`, `findInTree`, `buildTree` plus minimal stubs for `this.MASTER_ID`, `this.accountInfo.Login`, `n.typeAgent` from the same `manager.js` hash above.

## Variance table (N captures)

**Status: not produced.** Requirements and blockers:

| Dimension                                       | N needed                  | Repo state                                                    |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Top-level keys (`GENERAL`, `PLAYERS`, `EXTRA`)  | ≥3 response bodies        | **0** stored                                                  |
| Row counts (`GENERAL.length`, `PLAYERS.length`) | same                      | **unresolved**                                                |
| `Level` max / distribution                      | same                      | client max **12** in `baseHeriarchy`; live max **unresolved** |
| `RRO` on wire                                   | same                      | client sends **1**; wire **unresolved** without bodies        |
| Per-step boot timings                           | N boots + instrumentation | **unresolved**                                                |
| `agentType` / menu style (`Tile Menu` vs left)  | session metadata          | affects **500ms** branch only (verified)                      |

**Sniffer-only evidence (keys, not values):** `_sniffed_form_templates.json` — `getListAgenstByAgent` form keys: `RRO`, `agentID`, `agentOwner`, `agentType`, `operation`.

## Methods & tools (authorized workflow)

| Phase                  | Tool                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static                 | `rg` on pinned `manager.js` SHA; byte-offset slices; **1.0.279 vs 1.0.280** diff (currently empty).                                                                                                                       |
| Dynamic                | `capture:f402 --suite manager-boot --sniff-requests` (in-page `/cloud/api/` templates); **Playwright HAR** export ≥3 sessions → `docs/evidence/captures/har/` (not yet populated).                                        |
| Replay                 | curl POST **`https://www.fantasy402.com/cloud/api/Manager/getListAgenstByAgent`** with **byte-identical** body from HAR + session `Cookie` + `Authorization: Bearer` (security prefilter behavior); **not** `/qubic/...`. |
| Contract               | Infer schema from N responses; validate held-out + sentinel negatives.                                                                                                                                                    |
| Redaction              | Sentinel seed + grep sweep stdout, log, disk, subprocess (pass = 0 hits).                                                                                                                                                 |
| Timing                 | `Bun.nanoseconds` per step in probe (`withTrace`, `DEBUG_TRACE`) — regression after N boots.                                                                                                                              |
| Minimal-PII experiment | Three request variants (full / projected fields / scoped `agentID`) — **requires live auth**; not run in this pass.                                                                                                       |

## Proof obligations

| Criterion                                        | Obtainable now?                                                        | Stand-in                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------- |
| (a) Bundle tree builder empty diff vs mine       | **Yes, once** `baseHeriarchy` extracted + GENERAL fixture from capture | User paste / future HAR → redacted fixture          |
| (b) Request body byte-identical to browser       | **No** without HAR                                                     | Sniffer key set + manual DevTools copy              |
| (c) Schema accepts N captures, rejects sentinels | **No** (N=0 bodies)                                                    | —                                                   |
| (d) Sentinel sweep zero hits                     | **Runnable** on tooling paths                                          | Not executed in this pass                           |
| (e) `bust` diff expected function changes        | **Done for 279 vs 280**                                                | identical file; next bust compare same SHA workflow |

## Scope & “done” (client)

**Authorized:** Read-only capture of boot ops; redacted fixtures; oracle extraction from public `manager.js`; replay against `/cloud/api/` with operator credentials.

**Minimal necessary request (evidence-bound):**

- Portal **always** requests the **full** ajax response for `getListAgenstByAgent` (assigns `e.PLAYERS` and `e.GENERAL` in success handler). **No bundle evidence** that the server omits `PLAYERS` via projection, `agentID` scope, or a different op for the same data.
- **`getHeriarchy`** returns **`LIST`** only — different contract; does **not** substitute for `GENERAL`+`PLAYERS`.

**Done (client):** Signed-in manager boot completes hierarchy load: `loadedHierarchy` set, `completeHeriarchy` / agent search UI populated, no silent skip on ajax error (errors currently `console.log` in `getCompleteHeriarchy` error handler — byte **60338** vicinity).

## Enhancement set (traceable only)

| Item                                                                                                                    | Traces to                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Probes/replay MUST target **`/cloud/api/Manager/`**                                                                     | security.js prefilter + curl 404/401                      |
| Request envelope MUST include **`operation:getListAgenstByAgent`**, **`RRO:1`**, session **`agentID`/`agentType`**      | manager.js getCompleteHeriarchy                           |
| Do not wait **500ms** in automation; await hierarchy fetch                                                              | settings setTimeout verified; not a server requirement    |
| Parser oracle = **`baseHeriarchy`**, not SeqNumber order                                                                | manager.js levels 1–12                                    |
| **`getHeriarchy`** documented separately (`LIST`)                                                                       | manager.js ~32970                                         |
| **`agentOwner`** optional on wire (sniffer)                                                                             | not in getCompleteHeriarchy minimal object — variance TBD |
| **BLOCKED until N captures:** PLAYERS row count, SeqNumber indexing, response JSON schema, variance-driven PLAYERS_MODE | unresolved rows above                                     |

**Cut (no primary source):** enhancements justified only by ~57k PLAYERS, typical counts, or parser ergonomics without capture variance.
