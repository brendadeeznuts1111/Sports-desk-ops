# Cloudflare binding contracts in the local `dx` MCP

This is a **read-only, non-deployment** diagnostic for the local SportsDesk MCP in
`scripts/mcp_dx_server.ts`. It complements `scripts/cloudflare/edge_audit.ts`:
the edge audit inspects DNS/Tunnel/route resolution; the `cloudflare_bindings`
tool inspects **Worker names and binding metadata** and compares a small set of
module requirements labeled by evidence source (code or a deployed snapshot). Neither reads secret values or invokes
business API endpoints.

## Setup and use

Run the MCP server in the SportsDesk worktree using the pinned Bun runtime:

```sh
bun run scripts/mcp_dx_server.ts
```

Configure its process environment with `CLOUDFLARE_ACCOUNT_ID` and a
**separately issued read-only `CLOUDFLARE_AUDIT_TOKEN`**, provisioned using the
existing operator secret workflow. Do not paste token values into chat or an
MCP client configuration. The metadata tool never loads them until called.
The existing `shot` tool requires neither value.

MCP tool: `cloudflare_bindings`, input `{}` to audit **registered module
Workers only**, or `{"worker":"sports-ops-desk"}` to narrow the audit.
Unregistered Workers cannot be selected through the tool, even if they share
the account. It first lists Worker names to establish deployment presence, then
reads settings only for registered Workers.

The structured result includes `discoveredWorkers[]` (registered Worker names
found in Cloudflare), `workers[].bindings[]` (successfully read metadata),
`failures[]` (unreadable settings), and `checks[]` (module/API contracts).
A failed account list stops the audit: it never returns an incomplete inventory
as a passing result. Settings errors are `unverified`, not invented `missing`.
Cloudflare's explicit `total_pages` is honored even if a page is short.

The read-only Cloudflare token must have the permissions needed to list Worker
scripts and read Worker settings. Test these permissions with the operator's
approved secret injection mechanism; do not reuse a deployment token merely to
make the probe pass. The code sends only authenticated GET requests to the
Cloudflare API and does not read KV values, objects, databases, or secret values.

## Status semantics

| Status | Meaning |
| --- | --- |
| `bound` | Deployed binding exists with the expected type. **Not** proof the route works. |
| `missing` | Required binding absent from a **successfully read** Worker configuration. |
| `wrong_type` | Name exists, but its deployed type does not match the module contract. |
| `inactive` | Optional feature binding absent; investigate only if feature should be enabled. |
| `not_deployed` | Registered Worker absent from the complete Worker-name listing. Distinct from a missing binding. |
| `unverified` | Worker listed but settings unreadable or unavailable; do not infer binding absence. |

The module contracts in `MODULE_BINDING_REQUIREMENTS` are a **small,
evidence-anchored list**, not an exhaustive API/module registry. A check also
carries its `basis`: `source` means declared in a code/config contract;
`deployment_snapshot` means the binding existed in a prior live inventory.
A missing snapshot binding indicates drift, **not proven application breakage**.
Add a code-backed requirement only after pinning its owning Worker, binding
type, source path and actual API behavior.
Do not equate a Worker `MCP_LIMITER` binding with proof that an externally
reachable `/mcp` endpoint is configured or authenticated.

## Current reconciliation baseline (Cloudflare read, 2026-11-21)

- `sports-ops-desk`: `MCP_LIMITER`, `SIGNAL_STORE`, `DRIFT_STORE`, `PROFILE_DAY`
  Durable Objects plus `DESK_ARCHIVE` R2 and secrets. These names are binding
  metadata, not proof of which routes are exposed.
- `fantasy402-ingestion`: R2 `RAW_ARCHIVE`, KV `AUTH_CACHE` and `SESSION_KV`,
  plus a broadcaster Durable Object.
- `bet-ticker-worker`: `BET_TICKER` Durable Object, `BET_TICKER_CACHE` R2.
- `bookdeskops` and `bookdeskops-staging`: deployed settings have
  `APP_NAME`, `ENVIRONMENT` and `PUBLIC_ORIGIN`. No `OPS_ORIGIN` was observed.
  Therefore the optional weekly reports/bank payments proxy is **not confirmed
  configured**. The repo's `wrangler.jsonc` declares additional CORS vars;
  reconcile source and deployed settings before staging or production deploy.
- No D1 databases or Queues appeared in this account-wide inventory. The
  `bookdeskops` Alchemy D1/Queue/Telegram split Worker graph is documented as
  a **local pilot**, not a deployed feature. Do not create live resources just
  because declarations exist.

Only names, types and counts were checked. The sample date is not a runtime
health check, data-access test, endpoint authorization test or deployment proof.
The local MCP server uses stdio, not a remotely exposed authenticated `/mcp`
endpoint. The presence of `MCP_LIMITER` in `sports-ops-desk` does not prove
an HTTP MCP server or OAuth flow exists on that Worker.

## Gates before changing a deployed binding

1. Pin the exact repository, branch, commit, Worker/environment and live target.
2. Confirm the application's current `wrangler.jsonc` or equivalent deployment
   authority, including environment-specific (non-inherited) bindings.
3. Update source-of-truth config, generate types (`bun run types` in
   `bookdeskops`) and run tests, typecheck and Wrangler dry-run.
4. Verify secrets are managed separately and compare intended vs deployed
   binding names/types **without reading values**.
5. Validate on isolated staging; deploy to production only under its own
   explicit change approval. Preserve the Alchemy pilot/adoption boundary.

Cloudflare references: [Worker bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[remote MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).
