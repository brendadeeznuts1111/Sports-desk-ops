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

The portal document loads 86 assets from `cdn.fastassets.io`, `cdnjs.cloudflare.com`,
`fonts.googleapis.com` and `maps.googleapis.com`; this repository's pages add four explicit ones
(`setting.less` x2, `telegram-web-app.js`, the pinned Scalar bundle). `cdn-manifest.json` pins their
origin bytes (sha256 + sha384 SRI) and, for stylesheets, the `url()`/`@import` targets they pull in.

```bash
bun run pin:cdn                                    # check: exit 1 drift, 2 unreachable
bun run pin:cdn:update --vendor-version <version>  # human action; see docs/runbooks/cdn-pin-update.md
bun run sri:apply --in <html> [--out <html>]       # rewrite a document from the manifest
```

`bin/check-innerhtml.ts` enforces the manifest offline for tracked HTML; the live check runs in CI on
the daily schedule and through `portal:drift:cron`.
