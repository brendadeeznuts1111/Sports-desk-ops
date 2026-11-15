# Pinned portal artifacts

Hashes are authoritative in **`manifest.json`** (compare with `fetch-pinned-bundles.sh`).

| Artifact      | Role                                                               |
| ------------- | ------------------------------------------------------------------ |
| `version.js`  | Bust string source; drift = **SHA-256**, not semver string compare |
| `manager.js`  | Oracle extraction + RRO grep                                       |
| `util.js`     | `apiPath`, `RRO:1`                                                 |
| `security.js` | qubic→cloud ajax prefilter                                         |

Re-fetch (no credentials):

```bash
bash verification/manager-boot-oracle/pinned/fetch-pinned-bundles.sh
bun run fetch:pinned-portal   # Bun TLS vs bundle-byte drift class
```

Runtime pin (Bun + JSC) lives in **`manifest.json` → `runtime`**. CI and gates call
`verify:manager-oracle-slices` (includes runtime + slice guard).

After manager hash changes, re-slice (**separate from `bun fmt`** — slices are `*.body.min.js`):

```bash
node verification/manager-boot-oracle/slice-methods.mjs
```

Always-on drift: `bun run portal:drift:cron --watch` (spawned checks use pinned `bunExecutablePath`).

## CDN assets (`cdn-manifest.json`)

The portal document loads 87 assets from `cdn.fastassets.io`, `cdnjs.cloudflare.com`,
`fonts.googleapis.com` and `maps.googleapis.com`; this repository's pages add four explicit ones
(`setting.less` x2, `telegram-web-app.js`, the pinned Scalar bundle); and the shell reaches 101
same-origin modules. `cdn-manifest.json` pins their origin bytes (sha256 + sha384 SRI), the
`url()`/`@import` targets stylesheets pull in, and the `/app/` module graph.

That graph is the **transitive** `require([...])` closure from the controller, not just the
controller's direct list: `manager/module/customer-admin/performance.js` is required by
`player-info.js`, so a one-hop scan could not see it. RequireJS `paths` aliases are resolved too
(`swal2` → `/assets/js/scripts/swal2/sweetalert2.min.js`), which keeps an alias from being reported
as a `/app/<id>.js` 404 that does not exist. Modules the controller selects through a variable stay
visible only via `DYNAMIC_APP_MODULES` in `lib/f402_cdn_pin.ts`. The oracle bundles in `manifest.json`
remain the extraction source; this manifest is the client-surface gate.

```bash
bun run pin:cdn                                    # check: exit 1 drift, 2 unreachable
bun run pin:cdn:update --vendor-version <version>  # human action; see docs/runbooks/cdn-pin-update.md
bun run sri:apply --in <html> [--out <html>]       # rewrite a document from the manifest
```

`bin/check-innerhtml.ts` enforces the manifest offline for tracked HTML; the live check runs in CI on
the daily schedule and through `portal:drift:cron`.
