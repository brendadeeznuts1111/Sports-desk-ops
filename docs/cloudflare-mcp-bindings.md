# Cloudflare binding contracts in the local `dx` MCP

This is a **read-only, non-deployment** diagnostic for the local SportsDesk MCP in
`scripts/mcp_dx_server.ts`. It complements `scripts/cloudflare/edge_audit.ts`:
the edge audit inspects DNS/Tunnel/route resolution; the `cloudflare_bindings`
tool inspects **Worker names and binding metadata** and compares a small set of
source-observed module requirements. Neither reads secret values or invokes
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

MCP tool: `cloudflare_bindings`, input `{}` for all Workers or
`{"worker":"sports-ops-desk"}` for one. The server returns structured data:
`workers[].bindings[]` (name/type and only safe resource labels), `failures[]`
(unreadable Worker metadata), and `checks[]` (module/API anchors). Missing
permissions produce errors/`unverified`, **not invented `missing` conclusions**.

The read-only Cloudflare token must have the permissions needed to list Worker
scripts and read Worker settings. Test these permissions with the operator's
approved secret injection mechanism; do not reuse a deployment token merely to
make the probe pass. The code sends only authenticated GET requests to the
Cloudflare API and does not read KV values, objects, databases, or secret values.

## Status semantics

| Status | Meaning |
| --- | --- |
| `bound` | Deployed binding exists with the expected type. **Not** proof the route works. |
| `missing` | Expected required binding not present in a successfully read Worker configuration. |
| `wrong_type` | Name exists, but its deployed type does not match the module contract. |
| `inactive` | Optional feature binding absent; investigate only if feature should be enabled. |
| `unverified` | Settings could not be read; do not infer absence. |

The module contracts in `MODULE_BINDING_REQUIREMENTS` are a **small, evidence-
anchored list**, not an exhaustive API/module registry. Add a contract only after
pinning its owning Worker, binding type, source path and actual API behavior.
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
