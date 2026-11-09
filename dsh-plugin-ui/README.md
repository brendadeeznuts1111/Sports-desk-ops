# dsh-plugin-sportsdesk-desk-status

A **separate**, removable DSH bundle for the SportsDesk desk. It adds one compact,
single-line, ambient row to the Harness Web UI below the composer
(`conversation.composer.dock`) and reports the local SportsDesk webview service
from **real data** — it never renders a mocked or assumed state.

This directory is independent of `../dsh-plugin/` (the read-only Host tools
bundle): different package, different row id, installable and removable on its
own.

## What the row shows

| Observation                                                                       | Row text                  | Dot     |
| --------------------------------------------------------------------------------- | ------------------------- | ------- |
| First probe not finished                                                          | "checking…"               | idle    |
| `/health` fetch rejects / non-2xx                                                 | "service down"            | error   |
| `/health` ok, but `/api/status` is 404 **or** the `/health` body has no `ingress` | "stale build (uptime 5d)" | warn    |
| `/health` ok and `/api/status` answers                                            | "current"                 | success |
| `/health` ok but the `/api/status` probe itself failed                            | "status probe failed"     | warn    |

Data source: `http://127.0.0.1:4020/health` and
`http://127.0.0.1:4020/api/status`, polled every 30 s (inside the ≤60 s bound),
each request bounded by `AbortSignal.timeout(3000)`. The tooltip carries the
probe URL, the last check time, the HTTP status and the error, if any.

The tooltip adds the HTTP status, the probe error when there is one, and, for a
stale or down service, the exact recovery command (`PORT=4020 bun run serve` to
restart, `bun run serve` to start).

The `/api/status` probe and the `ingress` field check exist because the running
service can answer `/health` while predating the checkout. Measured on
2026-11-02: `uptimeSeconds` 457596 (~5.3 days), `/api/status` 404, `/health`
without `ingress` — a naive health check says "healthy"; this row says
**stale build**.

## Transport (Desktop CORS)

The DSH Desktop shell is `dsh-app://app`, so loopback fetches to `:4020` are
cross-origin unless the daemon lists that origin in `SPORTSDESK_ALLOWED_ORIGINS`.
The client probes `/api/sportsdesk-desk/{health,status}` on the Host first (same
origin, registered by `dsh-plugin-sportsdesk-desk-panel`), then falls back to
`http://127.0.0.1:4020` when the proxy route is absent.

## Rules followed

- `package.json` declares `dsh.client` (`platform: web`, `immediately: true`,
  `inject` ordering) and exports `./client` beside the bundle patch.
- The Client factory is side-effect free; the locale dictionary and the fetch
  loop are registered in `apply` with `ctx.effect` and cleaned up on dispose.
- Visible copy is registered through the Client locale service
  (`ctx.locale.register` + the slot's `locale:` option, which supplies `t`), in
  both built-in locales.
- Chrome uses only host `--dsw-alias-*` tokens (`label-primary`,
  `label-secondary`, `label-tertiary`, `state-*`); React comes from the browser
  module table; no Harness Client package is imported; the app root is not
  touched.

## Install / remove

```
plugin_manager({ action: "install_bundle",
                 target: "/Users/nolarose/code/sportsdesk-ops/dsh-plugin-ui" })
plugin_manager({ action: "remove_bundle", target: "dsh-plugin-sportsdesk-desk-status" })
```

## Verification

```sh
node dsh-plugin-ui/verify-load.mjs   # dependency-free; also runs under Bun
```

`verify-load.mjs` proves the wiring without a DSH Host: the manifest (`dsh.client`, exports,
`files`, locale, icon), the deliberately empty Host half, the Client loader id and inject list,
the single `conversation.composer.dock` registration (id `sportsdesk-desk-status`, order 40),
that every visible `t(...)` key exists in both the embedded en and zh dictionaries (and that
`locale/en.json` and `locale/zh.json` agree), that the poll effect clears its timer on dispose,
and that the chrome is token-only, DOM-safe and fetches only the desk's two routes. The repo gate
`tests/plugin_bundles.test.ts` runs this harness for every bundle in `bun test tests/`.

## Verification status

The bundle installs and the client slot registration is inspectable through
`cordis_inspect_query` (`client`, `Slots`, `listSubTree` with
`root: "conversation.composer.dock"`). Rendered pixels are **unverified**: this
session has no browser control, and the Client inspect provider timed out while
authoring. A DSH restart may be required before the row appears if the client
module generation was cached.
