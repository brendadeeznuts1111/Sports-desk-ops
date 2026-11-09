# dsh-plugin-sportsdesk-desk-panel

A **separate**, removable DSH bundle that adds one **left-sidebar entry** to the
Harness Web UI: a `SportsDesk` icon in the global panel list (`sidebar.panellist`,
beside Plugins and Schedules). Selecting it opens a desk page in the main column
(`main`, keyed `sportsdesk`) that reports the local SportsDesk webview service
and its desk from **real measured data** — it never renders a mocked or assumed
state.

The icon also carries a small status dot, and the page and the icon read the
same measured snapshot: one 15 s probe loop feeds both, so desk health is
visible from the sidebar without opening the page. The page additionally opens
the desk's own Server-Sent Events stream while it is mounted; the sidebar dot
never depends on that stream.

This directory is independent of `../dsh-plugin/` (the read-only Host tools
bundle) and `../dsh-plugin-ui/` (the composer desk-status row): different
package, different row id, installable and removable on its own.

## What the sidebar entry is

The sidebar owns the button, its hover tooltip, the wide-mode label, the
selected state, and the "More" menu. This bundle supplies:

| Slot                | Id / key     | Contribution                                 |
| ------------------- | ------------ | -------------------------------------------- |
| `sidebar.panellist` | `sportsdesk` | the glyph plus the measured phase as a dot   |
| `main`              | `sportsdesk` | the page the sidebar selects by that same id |

Both use one id because `main` is keyed by the sidebar entry id: reusing an
existing id would replace that entry, so the id is fresh.

The dot tracks the **service phase only** — the page's overview sources never
move it. Its tooltip reads `SportsDesk desk: <status>`, so the phase is also
available without opening the page.

| Phase                             | Dot color |
| --------------------------------- | --------- |
| `current`                         | success   |
| `stale` / `unknown`               | warning   |
| `down`                            | error     |
| `checking` (nothing measured yet) | idle      |

## What the page shows

A header (title, one-line description, Refresh and Open desk), a compact **Last
measured** line, the existing service status card, a **Live stream** card, a
**Live bridge** card, a recovery callout when the service is stale/down/unknown,
an **attention**
banner, and a responsive card grid (2 columns at ≥ 900 px, 1 below) with the
three desk cards. Every card carries its own state chip — `live` / `stale` /
`error` / `missing` — plus the time its payload was received (or, when it has no
payload, the last attempt) and the relative age.

### Service phase

Classification is the same one the `sportsdesk_status` Host tool and the
composer desk-status row use (health + `/api/status` + the `/health` `ingress`
field):

| Observation                                                                       | Status text               | Dot     |
| --------------------------------------------------------------------------------- | ------------------------- | ------- |
| Probe not finished                                                                | "checking…"               | idle    |
| `/health` fetch rejects / non-2xx                                                 | "service down"            | error   |
| `/health` ok, but `/api/status` is 404 **or** the `/health` body has no `ingress` | "stale build (uptime 5d)" | warn    |
| `/health` ok and `/api/status` answers 2xx                                        | "current"                 | success |
| `/health` ok but `/api/status` rejects **or** answers non-2xx (not 404)           | "status probe failed"     | warn    |

The status card carries the endpoint, the HTTP status, uptime, the absolute and
relative check time, the probe source (**Harness proxy** or **direct loopback**)
with the `/health` latency, and links to the raw `/health` and `/api/status`
documents. A rolling **health-latency strip** keeps the last 30 successful
`/health` probes and renders their p50/max plus a sparkline (failed probes are
excluded, and before the first success it says "No successful probes yet"). The
header's **Copy diagnostics** action copies the measured snapshot (phase,
latencies, per-source status/HTTP/error) to the clipboard for a bug report and
reports `Copied` / `Copy failed` in place. The Service card renders only fields the service actually returned:
runtime, PID, RSS memory, `nodeEnv`; Telegram mode (with `modeReason` as a
tooltip) and the `checks` entries; both probe latencies; and the scheduled
reports with their enabled count.

When the build is stale the callout names what is missing (`/api/status` route
404, `ingress` field) and shows the exact restart command,
`PORT=4020 bun run serve`; when the service is down it shows the upstream error
and the same start command.

### Live stream

The **Live stream** card sits directly below the service card and reads the
desk's own push route, `GET /api/graph/stream`, through a **chunked**
same-origin proxy (see [Transport and CORS](#transport-and-cors)). The desk
sends an `event: summary` frame only when its stat fingerprint changes (at most
every 5 s) and a `: heartbeat <epochMs>` comment every 5 s, so the card
distinguishes "connected but quiet" from "not connected".

| State              | Meaning                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connecting…`      | a connection attempt is in flight                                                                                                                              |
| `streaming`        | HTTP 200; frames and/or heartbeats are being read                                                                                                              |
| `reconnecting`     | the connection ended or failed; the next attempt has a delay                                                                                                   |
| `paused`           | the browser tab is hidden; reading resumes when it is visible                                                                                                  |
| `polling fallback` | no stream route in this build, but the 15 s graph probe has data: the card shows those counters, labelled as a poll                                            |
| `no stream route`  | the proxy or the desk does not serve `/api/graph/stream` and no polled data exists — no retry, because the route cannot appear until the Host half is reloaded |
| `stream error`     | any other measured failure (a 502 from the proxy, a bad body, …)                                                                                               |

The card renders only what arrived: the endpoint and HTTP status, the transport
(Harness proxy or direct loopback), frames received with their byte count, the
last change frame's clock and age, heartbeats with the last heartbeat's age, and
the connection time. From the latest frame it renders the same counters the
Market feed card uses (pending bets, active wallets, open legs, open exposure,
IP clusters) plus feed status, feed age and poll sequence; the feed age is the
frame's `ageSeconds` plus the time elapsed since that frame, because the honest
feed keeps aging between frames.

A **Changes while connected** list shows the counter deltas between consecutive
frames (`Pending bets 14 → 16`, `Open exposure $15,609 → $16,609`) with the
clock time of the frame that reported them. It is bounded to the newest 8.

Honesty rules specific to the stream:

- the first frame establishes values and produces **no** deltas; a counter
  absent from either frame is never diffed;
- a frame whose `data:` is not JSON is counted in `parseErrors`, not rendered;
- a payload without a recognised `feed`/`repo` shape is not rendered at all;
- a marked 404 renders `no stream route` (or `polling fallback` when the graph
  probe has data) and does not fall back or retry; an unmarked 404 — or a 200
  whose content type is not `text/event-stream` — falls back to loopback, and a
  route the proxy does not have plus a loopback that does not answer renders
  `no stream route`/`polling fallback` instead of reconnecting forever;
- in `polling fallback` the counters and deltas come from the 15 s graph probe,
  never from a fabricated stream frame; a later successful connection replaces
  them with stream frames;
- retries use a bounded backoff (2 s, 5 s, 10 s, then 30 s) and keep the last
  measured failure reason on screen;
- the page's **Refresh** action re-probes the five polled sources **and**
  reopens the stream immediately.

The stream connection belongs to the desk page: it opens when the page mounts,
closes when the page unmounts, pauses when the tab hides, and aborts on bundle
disposal. The sidebar glyph starts only the probe loop, so a closed page never
holds an SSE connection.

### Live bridge

The **Live bridge** card reads the desk's own WebSocket pub/sub hub
(`/api/live-bets`, subprotocol `sportsdesk.bridge.v1`) instead of polling: the
panel opens a browser `WebSocket`, subscribes to `f402-bet-ticker` and
`gslive-tally`, and sends a `PING` every 15 s. The desk answers `SUBSCRIBED`,
`PONG` and its per-topic rollup frames; the card renders the connection state,
protocol, ping round-trip, frame count, last frame and the newest five frame
kinds with a numeric, PII-free summary — never a frame payload.

Transport: the browser connects to the same-origin Host tunnel
`/api/sportsdesk-desk/ws`; on a loopback-served UI (or a browser on the desk
host) it falls back to `ws[://127.0.0.1:4020/api/live-bets]`. The Host performs
both RFC 6455 handshakes — it validates the client's key and offered
subprotocol, connects to the desk, verifies the upstream accept key and echoed
protocol, then pipes the raw upgraded sockets — so a remotely served UI reaches
a loopback bridge without exposing a port.

Bun 1.4 WebSocket semantics are handled explicitly:

- an `error` event is recorded but is **not** treated as a close; the bridge
  reconnects only on `close`, so a `1006` (failed connection) is not duplicated;
- a pre-open failure falls back to the next transport immediately; a failure
  after opening reconnects with a bounded 1/2/5/10 s backoff;
- hiding the tab sends `close(1000)` and shows `paused`; becoming visible
  reopens;
- `bufferedAmount` over 64 KiB closes the socket `1011 backpressure` instead of
  queueing frames;
- disposal closes with `close(1000)` and no later frame publishes.

### Desk overview cards

Each card is measured from one read-only desk route and rendered from its own
source state; a failed source never blanks another card.

**Market feed**, from `GET /api/graph/summary` (`graph`):

- `feed.status`, `feed.dataMode`, `feed.wssIngestion`, `feed.pollSequence`;
- `feed.lastUpdatedIso` rendered absolute in UTC **and** relative (the feed
  reports UTC instants; a local-zone rendering would shift the evidence), plus
  `feed.ageSeconds` and a warn chip when `feed.stale` is true — the "is the feed
  live?" answer;
- a Counts block: active wallets, open legs, open exposure USD, pending bets,
  IP clusters;
- a Repo block: `repo.branch`, short `repo.head`, `repo.routes.served`, the
  citations evidence age (`repo.citations.checked` + `ageSeconds`, warn when
  stale) and the tests evidence age (`repo.checks.tests`).

If the payload has no `feed` section the card says "feed section missing"
instead of rendering zeros; a payload with only a feed or only a repo renders
only the measured part.

**Book**, from `GET /api/kpis` (`kpis`): the Agents (`total`/`agents`/`masters`),
Pending (`wagers`/`tickets` + wagered/to-win USD), Ticker
(`wagers`/`live`/risk/volume USD) and Customer book (`customers`/`tickets` +
customer net USD) blocks. The payload stores money in **cents**, so the cards
convert to USD. Each block renders its own `provenance` age beside it, with a
warn chip when that provenance says `stale`; a stale block also makes the card
chip `stale`. A block that is absent is omitted, never zeroed.

**Paper execution**, from `GET /api/execution/plan` (`execution`):

- `mode` and `killSwitch` (kill switch on is an error-tone value), and
  `policy.liveEnabled` rendered as "live execution: off/on" from the payload;
- `risk.dailyPlannedUsd` / `risk.dailyCapUsd` with a meter, and
  `risk.openIntents` / `policy.maxOpenIntents` as `required / cap`;
- `risk.marketExposureUsd` entries (a present-but-empty object says "none",
  which is a measured zero; an absent field omits the row);
- each venue's `liveReady` with its `reason` (expected `false` in this
  checkout), and the decisions blocked vs not-blocked counts derived from
  `decisions[].blocked`, plus `blockedReasons` counts; when the payload has no
  decisions array the card says so explicitly ("Unknown — the payload has no
  decisions array.");
- when `provenance.stale` is true, the plan is labelled as computed from stale
  market data, with its age.

### Attention banner

The banner above the cards is derived **only** from measured sources, and each
item names its source (and age when known):

- service `down` / `stale` / `unknown` (the same wording as the status card);
- market feed stale, `feed.status` not `"measured"`, or `wssIngestion` not
  `"ingested"` (one combined "Market feed:" item);
- `killSwitch === true`, `mode !== "paper"`, or `policy.liveEnabled === true`
  (one item each, prefixed "Paper execution:");
- a failed or missing overview source (one item per source, with its reason).

Absent data is rendered as unknown by the card, never as an alert, and a fully
healthy desk shows no banner at all. The banner's `data-count` attribute states
how many conditions it is reporting.

### Honesty rules

These are not negotiable:

- a failed or missing source renders its **explicit measured state** and reason
  ("missing", "unknown", an HTTP status, a transport error string) — never a
  fake `0` or `—` as if it were measured;
- a payload that previously loaded **stays visible** when a later probe fails,
  labelled with the time it was received ("Showing the last good measurement
  from …") and with the failure reason shown next to it;
- a 2xx response whose body is not a JSON object is an error ("non-JSON body"),
  never a partial assumption; a 404 means the route is not in this build
  (`missing`), not that the service is down;
- an unrecognised payload shape is tolerated: the boundary readers return null,
  absent rows are omitted, and nothing throws in render.

### Live behaviour

One module-level store owns the snapshot. The sidebar glyph starts the probe
loop on mount (the icon is mounted even when the page is closed), the page
subscribes to the same store, and both re-render when a probe publishes. Each
tick probes all five sources independently. The loop:

- probes immediately, then every **15 s** while the browser tab is visible;
- stops probing while the tab is hidden and probes immediately when it becomes
  visible again;
- aborts a superseded in-flight probe (manual **Refresh** measures now and
  wins);
- never publishes after disposal, and clears its timer, visibility listener and
  in-flight request when the bundle is disposed.

The live stream has its own store and lifetime, and never moves the service
phase the sidebar dot renders. The page opens it on mount; hiding the tab aborts
it and records `paused`; becoming visible reopens it; unmounting the page or
disposing the bundle aborts it and forbids any later frame from publishing.
Retries use the bounded backoff described above and stop on disposal.

In `polling fallback` the live card follows the poll store instead: every
published snapshot refreshes its counters and derives poll-to-poll deltas. The
stream is not retried on a timer (a missing Host half cannot appear without a
reload), so **Refresh** is the explicit way to try again; a successful
connection switches the card back to `streaming`.

A poll tick that finds the same phase keeps the last measurement on screen
instead of flashing "checking…"; only a manual Refresh resets the visible
state — and even then the last good per-source payloads survive, so a failed
Refresh cannot blank a card that previously measured.

## Transport and CORS

Every source probes **same-origin first** — `/api/sportsdesk-desk/health`,
`/status`, `/graph`, `/kpis`, `/execution` — which the Host half (`index.js`)
proxies to `http://127.0.0.1:4020`. If a proxy route answers 404 **without** the
proxy marker, the source falls back to the direct loopback URL
(`http://127.0.0.1:4020/...`).

The proxy exists because the Harness Web UI is tunnel-served (`--public-url`,
Cloudflare Access): the browser's `127.0.0.1` is the **viewer's** machine, not the
desk host, so a direct loopback fetch from a remote browser answers
connection-refused and the panel reads "service down" while the service is healthy.
The Harness server is the process on the desk host, so it proxies instead.
Measured 2026-11-04: the desk service answered 200 on `/health` and `/api/status`
while the panel showed "service down" from the tunnel-served UI.

The Host half allowlists seven read-only routes — five buffered JSON documents,
one chunked SSE stream and one WebSocket upgrade tunnel — served by three fixed
handlers (`target` is the route's fixed upstream path, never caller input):

| Proxy route                      | Upstream              | Forwarding |
| -------------------------------- | --------------------- | ---------- |
| `/api/sportsdesk-desk/health`    | `/health`             | buffered   |
| `/api/sportsdesk-desk/status`    | `/api/status`         | buffered   |
| `/api/sportsdesk-desk/graph`     | `/api/graph/summary`  | buffered   |
| `/api/sportsdesk-desk/kpis`      | `/api/kpis`           | buffered   |
| `/api/sportsdesk-desk/execution` | `/api/execution/plan` | buffered   |
| `/api/sportsdesk-desk/stream`    | `/api/graph/stream`   | chunked    |
| `/api/sportsdesk-desk/ws`        | `/api/live-bets`      | WS tunnel  |

Both handlers answer GET only (405 otherwise) and refuse a present Origin that
does not match the carrier (403). The buffered handler bounds the upstream with
a 4 s abort, forwards the upstream status/content-type/body, and always sets
`cache-control: no-store`; a forwarded document over 512 KiB becomes 502
`response_too_large` instead of being forwarded. The stream handler bounds only
the wait for upstream response headers (4 s), then forwards the SSE bytes as
they arrive with `x-accel-buffering: no`, aborts the upstream read when the
browser closes the connection, and ends the response when the desk ends the
stream so the page reconnects. Every route is unregistered on disposal,
including when the `webServer` injection callback resolves after disposal; open
streams are aborted at the same time. Measured 2026-11-04 18:13 UTC, the five documents were
`/health` 255 B, `/api/status` 2,355 B, `/api/graph/summary` 12,691 B (~12.7 KB),
`/api/kpis` 4,165 B (~4.2 KB) and `/api/execution/plan` 9,925 B (~10 KB), so the
cap is a runaway-response guard, not a working limit. Every route is
unregistered on disposal, including when the `webServer` injection callback
resolves after disposal.

Every answer carries `x-sportsdesk-desk-proxy: <upstream path>`, including 405,
403, forward, and 502 responses. Without it, a forwarded 404 (a stale service that
has no route) is indistinguishable from the generic Harness 404 for an
unregistered route, and the client would fall back to a loopback URL the remote
browser cannot reach — turning "stale build" into "status probe failed". The
marker makes a proxied 404 authoritative. When the health probe already answered
through the proxy, a 404 from any of the other four proxies is treated as
authoritative too: the Host half registers all six routes together, so this
also covers a Host half older than the marker (the source renders `missing` —
"not in this build" — rather than probing a loopback the viewer cannot reach).
An unmarked 404 when health was _not_ proxied still falls back to the loopback
URLs.

The `/api/status` probe and the `ingress` field check exist because the running
service can answer `/health` while predating the checkout. Measured on
2026-11-02: `uptimeSeconds` 457596 (~5.3 days), `/api/status` 404, `/health`
without `ingress` — a naive health check says "healthy"; this page says
**stale build**.

Measured 2026-11-04 17:57 UTC on the desk host, the current build answered:

```
/health     200  uptimeSeconds 62, runtime "Bun v1.4.4 (arm64-darwin)",
                 ingress {"proxied":false,"trustProxy":false}, nodeEnv "development"
/api/status 200  {"ok":true,"status":"serving","checks":{"telegram":"ok"},
                 "telegram":{"status":{"mode":"simulation",...},"schedules":[6 rows]}}
```

and the captured overview payloads (2026-11-04 18:13 UTC, kept in
`Scratch/plugin-v2/desk-panel/`) measured:

```
/api/graph/summary  feed.status "measured", dataMode "PARTIAL",
                    wssIngestion "not_ingested", pollSequence 1,
                    lastUpdatedIso 2026-11-04T11:44:39.790Z, ageSeconds 23339,
                    stale true; counts activeWallets 23, openLegs 94,
                    openExposureUsd 64139, pendingBets 14, ipClusters 13;
                    repo branch "main", head "d3a10ed", routes.served 63,
                    citations checked 441 ageSeconds 2667 stale false
/api/kpis           agents 2276/1679/596; pending 2 wagers / 2 tickets,
                    wageredCents 22406500, toWinCents 20006500;
                    ticker 16 wagers, live 0, riskCents 105225,
                    volumeCents 103863; customer book 220 customers /
                    1100 tickets / customerNetCents -118120894
/api/execution/plan mode "paper", killSwitch false, policy.liveEnabled false,
                    risk 0 planned / 5000 cap USD, 0 / 25 open intents,
                    marketExposureUsd {}; kalshi liveReady false
                    ("api_key_id_missing"), polymarket liveReady false (no
                    EIP-712 signer); 13 decisions, all blocked
                    (no_book 12, maker_edge_below_min 1), provenance stale true
```

That measured snapshot is why the page's first overview render shows a **stale**
feed chip and a stale plan note rather than a green board: the payloads say the
feed is stale and WSS is not ingested, so the page says so.

The same-origin proxy is the normal path, so the panel needs no CORS grant. The
direct loopback fallback does: the service grants cross-origin reads only for
origins listed in `SPORTSDESK_ALLOWED_ORIGINS` (the blanket `*` grant was removed
on 2026-11-01, because it also exposed the PII routes). Measured 2026-11-03 with
that variable set to the GUI origin:

| Request origin                         | `/health`                                                                         | `/api/status`     |
| -------------------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `https://dsh.bookdeskops.com` (listed) | `200`, `Access-Control-Allow-Origin: https://dsh.bookdeskops.com`, `Vary: Origin` | same grant, `200` |
| `https://evil.example` (unlisted)      | `200`, **no** `Access-Control-Allow-Origin`                                       | no grant          |

A browser cannot distinguish a CORS refusal from a network failure, which is why
the panel says "service down" in that case. Since 2026-11-04 the service also
emits `Access-Control-Allow-Private-Network: true` for those same allowed origins:
Chrome treats a public page reaching loopback as a Private Network Access request
and blocks it unless the local server opts in on the preflight. Run the service
with:

```
PORT=4020 SPORTSDESK_ALLOWED_ORIGINS=https://dsh.bookdeskops.com bun run serve
```

`PORT` is stated explicitly because `bun run serve` otherwise relies on the
auto-loaded `.env` for `PORT=4020` (and the Bun port cascade falls back to 3000).

## Rules followed

- `package.json` declares `dsh.client` (`platform: web`, `immediately: true`,
  `inject` ordering for the two slot owners and the locale service) and exports
  `./client` beside the bundle patch.
- The Client factory is side-effect free; the locale dictionary, slot
  registrations and the probe/stream lifetimes are `ctx.effect`/
  `ctx.slots.inject` resources cleaned up on dispose. Probing and streaming
  start from a mounted component, so a headless composition never polls or
  connects.
- Visible copy is registered through the Client locale service
  (`ctx.locale.register` + the slot's `locale:` option, which supplies `t`), in
  both built-in locales, with an English fallback so a missing seat cannot
  render a raw key.
- Chrome uses only host `--dsw-alias-*` color tokens; the glyph uses
  `currentColor`, so the host owns its color in every theme. No literal colors,
  no `innerHTML`, no blockable `window.confirm`/`alert`/`prompt`, no
  `document.body` writes.
- React comes from the browser module table; no Harness Client package is
  imported; the app root is not touched.
- Read-only: no POST, no control actions, no mutations, and no network
  destination beyond the seven allowlisted same-origin routes and their loopback
  fallbacks. The streaming route forwards the desk's own SSE bytes and the
  bridge tunnel forwards the desk's own frames; the client only sends
  `SUBSCRIBE` and `PING` on the bridge. It never sends a body or a credential,
  and the Host forwards no client header other than the fixed handshake.

## Verify

```
bun dsh-plugin-sidebar/verify-load.mjs
```

Proves the manifest, patch, locale metadata, icon, factory id, `apply`
registrations (sidebar id === main key), dictionary completeness, token-only
chrome and disposal. With a stubbed fetch it drives the real probe path against
the five payloads captured from the running desk (2026-11-04 18:13 UTC) and
checks:

- the first render is "checking…", then a current service renders runtime, PID,
  memory, Telegram mode, the enabled schedule count and the proxy provenance;
- **all five sources are probed independently through the same-origin proxy**,
  and the captured fixtures parse into the three overview cards with the
  measured values (feed status/dataMode/WSS/age, counts, repo head/routes,
  agents, pending/ticker/customer-book USD, risk caps, venues, decisions,
  provenance ages);
- **per-source failure isolation**: a graph 502 leaves the Book and Paper
  execution cards rendered and the service phase unchanged; a missing execution
  source renders `missing` with its reason, never a fake zero;
- **stale after good**: a later graph failure keeps the last good feed values
  visible under "Showing the last good measurement from …";
- a 2xx non-JSON body is a source error; partial payloads render only measured
  fields and say "unknown" for a missing decisions array;
- the attention banner derives the feed/kill-switch/mode/live-execution
  conditions from the payloads, is quiet for a fully healthy desk, and Retry
  re-probes the whole snapshot and recovers a failed source;
- a stale service renders "stale build", the missing route/`ingress` items and
  `PORT=4020 bun run serve`; a refused health probe renders "service down"; an
  `/api/status` 5xx is unknown;
- a proxy-marked 404 is authoritative (no loopback fallback), a proxied 404 from
  a Host half older than the marker is authoritative once health came through
  the proxy, and an unmarked proxy 404 still falls back to the loopback URLs
  when it did not;
- **the live stream**: from a stubbed SSE body the card reaches `streaming`,
  counts two frames and two heartbeats, renders `Pending bets 14 → 16` and
  `Open exposure $15,609 → $16,609`, and never invents a delta for the first
  frame; a proxy-marked 404 renders `no stream route` when there is no polled
  data and `polling fallback` (with the fixture counters) when there is; an
  unmarked 404 falls back to loopback, and the sidebar glyph opens no stream;
- the Host half streams the desk's SSE body chunk by chunk (content-type,
  `x-accel-buffering: no`, proxy marker, no buffering), reports a missing route
  as 404 `stream_route_missing` and an unreachable desk as 502, and aborts an
  open upstream stream on disposal;
- **the live bridge**: the fake socket opens with the tunnel URL and the
  `sportsdesk.bridge.v1` subprotocol, subscribes to both topics, pings and
  counts a frame; a pre-open failure falls back to the loopback URL; a `1006`
  after opening reconnects after the backoff; hiding sends `close(1000)` and
  shows `paused`; disposal closes with `1000`; without a `WebSocket` the card
  reports `unsupported`;
- **the Host tunnel**: the RFC 6455 accept key matches the spec vector, keys
  are validated, the upstream handshake carries the fixed path and protocol,
  the upgrade route refuses a foreign origin and a missing subprotocol before
  connecting, and disposal removes the upgrade route;
- **disposal** removes the slot registrations and locale dictionary, removes the
  visibility listener, aborts the in-flight request and publishes nothing after
  the probe resolves;
- the sidebar dot tracks the service phase only;
- the Host half registers the six exact allowlisted GET routes, refuses non-GET
  (405) and a foreign Origin (403) with the proxy marker, forwards upstream
  status/body/content-type plus the marker with `cache-control: no-store`, caps
  an oversized upstream document at 502 `response_too_large`, turns an
  unreachable service into 502 JSON, and unregisters every route on disposal
  (including a `webServer` callback that resolves after disposal).

It does **not** prove that the entry appears or looks right in the running Web
UI. Visual verification needs the connected page (Chrome DevTools on
`127.0.0.1:9222`); when that is unavailable, treat the rendered entry as
unverified and say so.

## Install / remove

```
plugin_manager({ action: "install_bundle",
                 target: "<absolute path>/dsh-plugin-sidebar" })
plugin_manager({ action: "remove_bundle",
                 target: "dsh-plugin-sportsdesk-desk-panel" })
```

Installing a new bundle can activate through HMR; replacing an already-installed
package requires a page refresh or a Harness restart to load a fresh JavaScript
module generation. The Host half is server-side: a change to `index.js` is picked
up when the Harness process loads the bundle again.
