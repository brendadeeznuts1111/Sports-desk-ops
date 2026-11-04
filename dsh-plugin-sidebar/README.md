# dsh-plugin-sportsdesk-desk-panel

A **separate**, removable DSH bundle that adds one **left-sidebar entry** to the
Harness Web UI: a `SportsDesk` icon in the global panel list (`sidebar.panellist`,
beside Plugins and Schedules). Selecting it opens a desk page in the main column
(`main`, keyed `sportsdesk`) that reports the local SportsDesk webview service
from **real data** — it never renders a mocked or assumed state.

This directory is independent of `../dsh-plugin/` (the read-only Host tools
bundle) and `../dsh-plugin-ui/` (the composer desk-status row): different
package, different row id, installable and removable on its own.

## What the sidebar entry is

The sidebar owns the button, its hover tooltip, the wide-mode label, the
selected state, and the "More" menu. This bundle supplies:

| Slot                | Id / key     | Contribution                                 |
| ------------------- | ------------ | -------------------------------------------- |
| `sidebar.panellist` | `sportsdesk` | the glyph (`size`, `active` owner props)     |
| `main`              | `sportsdesk` | the page the sidebar selects by that same id |

Both use one id because `main` is keyed by the sidebar entry id: reusing an
existing id would replace that entry, so the id is fresh.

## What the page shows

A header (title, one-line description, Refresh and Open desk actions) and a
status card. Classification is the same one the `sportsdesk_status` Host tool
and the composer desk-status row use:

| Observation                                                                       | Status text               | Dot     |
| --------------------------------------------------------------------------------- | ------------------------- | ------- |
| Probe not finished                                                                | "checking…"               | idle    |
| `/health` fetch rejects / non-2xx                                                 | "service down"            | error   |
| `/health` ok, but `/api/status` is 404 **or** the `/health` body has no `ingress` | "stale build (uptime 5d)" | warn    |
| `/health` ok and `/api/status` answers                                            | "current"                 | success |
| `/health` ok but the `/api/status` probe itself failed                            | "status probe failed"     | warn    |

Data source: `http://127.0.0.1:4020/health` and
`http://127.0.0.1:4020/api/status`. The page measures when it opens and on
**Refresh**; it does not poll in the background. Each request is bounded by a
4 s abort, and unmount cancels the in-flight request so nothing publishes after
disposal. The card's `title` carries the raw error when there is one.

The `/api/status` probe and the `ingress` field check exist because the running
service can answer `/health` while predating the checkout. Measured on
2026-11-02: `uptimeSeconds` 457596 (~5.3 days), `/api/status` 404, `/health`
without `ingress` — a naive health check says "healthy"; this page says
**stale build**.

## CORS

The service grants cross-origin reads only for origins listed in
`SPORTSDESK_ALLOWED_ORIGINS` (`services/sportsdesk_webview_server.ts:691-722`;
the blanket `*` grant was removed on 2026-11-01, because it also exposed the
PII routes). Measured 2026-11-03 with that variable set to the GUI origin:

| Request origin                         | `/health`                                                                         | `/api/status`     |
| -------------------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `https://dsh.bookdeskops.com` (listed) | `200`, `Access-Control-Allow-Origin: https://dsh.bookdeskops.com`, `Vary: Origin` | same grant, `200` |
| `https://evil.example` (unlisted)      | `200`, **no** `Access-Control-Allow-Origin`                                       | no grant          |

So the page can read the service only when the operator's env lists the origin
the Harness Web UI is served from — for this deployment
`SPORTSDESK_ALLOWED_ORIGINS=https://dsh.bookdeskops.com`. Without it the browser
blocks the read and the panel reports "service down", because a browser cannot
distinguish a CORS refusal from a network failure. Run the service with:

```
PORT=4020 SPORTSDESK_ALLOWED_ORIGINS=https://dsh.bookdeskops.com bun run serve
```

`PORT` is stated explicitly because `bun run serve` otherwise relies on the
auto-loaded `.env` for `PORT=4020` (and the Bun port cascade falls back to 3000).

## Rules followed

- `package.json` declares `dsh.client` (`platform: web`, `immediately: true`,
  `inject` ordering for the two slot owners and the locale service) and exports
  `./client` beside the bundle patch.
- The Client factory is side-effect free; the locale dictionary and the row
  registrations are `ctx.effect`/`ctx.slots.inject` resources cleaned up on
  dispose.
- Visible copy is registered through the Client locale service
  (`ctx.locale.register` + the slot's `locale:` option, which supplies `t`), in
  both built-in locales, with an English fallback so a missing seat cannot
  render a raw key.
- Chrome uses only host `--dsw-alias-*` color tokens; the glyph uses
  `currentColor`, so the host owns its color in every theme. React comes from
  the browser module table; no Harness Client package is imported; the app root
  is not touched.

## Verify

```
bun dsh-plugin-sidebar/verify-load.mjs
```

Proves the manifest, patch, locales, icon, factory id, `apply` registrations
(sidebar id === main key), dictionary completeness, a throw-free panel render
in the unmeasured state, token-only chrome, and disposal.

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
module generation.
