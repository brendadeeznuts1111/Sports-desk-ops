# DSH Web vs Desktop + SportsDesk ports

Three concepts—do not merge them:

| Concept                       | Where it lives                                                           | Role                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Harness workspace package** | Upstream monorepo `packages/<group>/<pkg>/`, scope `@deepseek-ai/dsh-*`  | Internal harness source; groups are containers only (no group-level `package.json`).                              |
| **Plugin bundle**             | e.g. `sportsdesk-ops/dsh-plugin*/` with `dsh.bundle`, `cordis.patch.yml` | Distributable Cordis entry; installed via `dsh plugin --profile <name> add` or `link:` in profile `package.json`. |
| **Profile**                   | `~/.dsh/profiles/<name>/`                                                | Assembly list (`dsh.profile.bundles`) + `cordis.patch.yml` overrides.                                             |

SportsDesk does **not** belong under the harness `packages/<group>/<pkg>/` tree unless you are contributing **to the harness repo itself**. This repo’s `packages/*` Bun workspaces (e.g. `ba-example`) are **SportsDesk monorepo** workspaces, not DSH harness groups.

Below: **profiles** + **bundles** only (ports, proxy, inspector).

## Layer 1 — Harness profiles

```text
~/.dsh/profiles/
├── web/          # `dsh web` (HTTP UI, often :3080 + tunnel)
│   ├── package.json      → dsh.profile.bundles
│   ├── cordis.yml        → usually []
│   └── cordis.patch.yml  → id-targeted overrides (top-level YAML **array**)
└── desktop/      # DeepSeek Harness.app (dsh-app://)
    ├── package.json
    ├── cordis.yml
    └── cordis.patch.yml
```

**Cordis.patch shape:** a **list of patch entries** (`- id: …`, `name:`, `config:`). There is **no** `profile: desktop` header in the patch file; the profile name is the directory (`web` / `desktop`) plus `package.json` bundles.

**Shared SportsDesk bundles (desktop today):**

| Bundle name in `package.json`       | Repo directory                  |
| ----------------------------------- | ------------------------------- |
| `dsh-plugin-sportsdesk-desk-status` | `dsh-plugin-ui/`                |
| `dsh-plugin-sportsdesk-desk-panel`  | `dsh-plugin-sidebar/`           |
| `dsh-plugin-sportsdesk-ops`         | `dsh-plugin/`                   |
| `dsh-plugin-sportsdesk-security`    | `dsh-plugin-security/`          |
| `dsh-plugin-watchlist-autobet`      | `dsh-plugin-watchlist-autobet/` |

Link installs: `link:../../../code/sportsdesk-ops/dsh-plugin-…` in `desktop/package.json`.

**Desktop-only Cordis overrides (examples):**

```yaml
- id: sportsdesk-ops
  name: dsh-plugin-sportsdesk-ops
  config:
    repoPath: /Users/nolarose/code/sportsdesk-ops
```

Same pattern for `sportsdesk-security` and `watchlist-autobet` (`repoPath` required at plugin `apply()`).

**Experimental inspector (optional):**

- Bundled via `@deepseek-ai/dsh-experimental-inspector-profile` (on **web**, not on **desktop** in the current layout).
- Default worker port **9230**, scans upward on `EADDRINUSE`.
- Client ingest: `ws://127.0.0.1:<port>/ingest` with `Sec-WebSocket-Protocol` token + allowed `Origin`.
- **Not** a SportsDesk service. Collides when both `dsh web` and Desktop load the inspector profile.

**Desktop without inspector:** drop `@deepseek-ai/dsh-experimental-inspector-profile` from `desktop/package.json` bundles to avoid ingest/bootstrap noise while keeping `dsh web` on 9230.

**Re-enable inspector on desktop only:** add the profile bundle back and patch:

```yaml
- id: experimental-inspector
  name: "@deepseek-ai/dsh-experimental-inspector"
  config:
    port: 9240
    clientOrigins:
      - dsh-app://app
```

## Layer 2 — SportsDesk UI (no shared `isDesktop` package required)

DSH Client bundles are **browser modules** loaded by the Harness; they do not consume a monorepo workspace package unless you add a bundled dependency.

**Desk traffic pattern:**

1. **Preferred:** same-origin Host proxy from `dsh-plugin-sidebar` (Host `index.js`):

   - `/api/sportsdesk-desk/health` → `http://127.0.0.1:4020/health`
   - `/api/sportsdesk-desk/status` → `http://127.0.0.1:4020/api/status`
   - (graph, kpis, execution, stream)

2. **Fallback:** direct `http://127.0.0.1:4020/…` when the proxy route is missing (browser on the desk host).

3. **Desk-status row** (`dsh-plugin-ui/client.js`): proxy-first, same as the panel.

Desktop (`dsh-app://app`) must **not** rely on loopback CORS; use the proxy or set `SPORTSDESK_ALLOWED_ORIGINS=dsh-app://app` on the daemon.

## Port map (measured conventions)

| Service                 | Typical bind           | Profile              | Notes                                         |
| ----------------------- | ---------------------- | -------------------- | --------------------------------------------- |
| Harness Web UI          | `:3080` (configurable) | web                  | `dsh web`                                     |
| SportsDesk daemon       | `:4020`                | —                    | `PORT=4020 bun run serve` in `sportsdesk-ops` |
| Inspector worker        | `:9230+`               | web (default)        | CDP + `/ingest`; not SportsDesk               |
| Inspector (desktop pin) | `:9240`                | desktop (if enabled) | Avoid collision with web on 9230              |

There is **no** separate SportsDesk “ingest” WebSocket on 9231/9241—those ports were the inspector client reconnecting to a dead or wrong ingest URL.

## Backend CORS (`:4020`)

Daemon uses opt-in origins (`SPORTSDESK_ALLOWED_ORIGINS`, comma-separated). Unset = no `Access-Control-Allow-Origin` (same-origin dashboard/Mini App only).

For direct cross-origin reads from Desktop:

```sh
SPORTSDESK_ALLOWED_ORIGINS=dsh-app://app PORT=4020 bun run serve
```

Prefer the Host proxy so the UI stays same-origin.

## Checklist

1. **Same plugin bundles** — only where needed; desktop carries SportsDesk; web may stay lean (tunnel/watch) unless you add desk plugins to `web/package.json`.
2. **Patches, not duplicated JS** — `repoPath`, inspector `port` / `clientOrigins` in `cordis.patch.yml`.
3. **One daemon** — `4020` for both profiles on the same machine.
4. **Inspector** — either web-only, or desktop pinned to `9240` with `dsh-app://app` in `clientOrigins`.
5. **Verify listeners** — `lsof -iTCP -sTCP:LISTEN -n -P | rg ':3080|:4020|:9230|:9240'`.

## Proxy env (Bun `fetch`)

If `HTTP_PROXY` / `HTTPS_PROXY` are set for the Desktop process, account reads can fail with `ERR_PROXY_TUNNEL` on newer Bun. This shell often has `NO_PROXY=localhost,127.0.0.1,::1` only—confirm proxy vars in the app environment if account errors persist.
