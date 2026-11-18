# Cloudflare edge audit (read-only)

This check inventories DNS records, Cloudflare Tunnel ingress and health, Worker names, and Worker routes for the configured account. It does **not** modify Cloudflare, create previews, deploy code, or read Worker secret values.

## Run from a remote development runner

Use Bun 1.4.4 and an API token with the *read-only* scopes needed for:

- Account zone listing (Zone Read)
- DNS listing (DNS Read)
- Tunnel listing/configuration (Cloudflare Tunnel Read)
- Worker listing (Workers Scripts Read)
- Worker route listing (Workers Routes Read)

Store the token as a protected CI secret, **never** in the repository or workflow logs. Its name is `CLOUDFLARE_AUDIT_TOKEN` so it cannot accidentally be selected by Wrangler as a deployment token.

```sh
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export CLOUDFLARE_AUDIT_TOKEN="<read-only-token-from-secret-store>"
bun scripts/cloudflare/edge_audit.ts
```

Exit codes: `0` = no detectable discrepancies; `1` = findings (not necessarily live outages); `2` = auth/API/configuration error. For debugging, run `bun test tests/cloudflare_edge_audit.test.ts` using synthetic fixtures; no Cloudflare credentials are required.

## Interpretation and safeguards

- `INGRESS_MISSING`: a DNS CNAME points to a known Tunnel but no matching explicit **HTTP** ingress hostname exists. A default `http_status:404` rule does not count as a working ingress. Before changing the Tunnel, determine the intended origin and expected HTTP path.
- `TUNNEL_UNHEALTHY`: the Tunnel is not healthy at inventory time; inspect connectors/host machine/service, not DNS alone.
- `TUNNEL_UNKNOWN`: a DNS CNAME targets a Tunnel UUID missing from the selected account.
- `WORKER_UNKNOWN`: a CNAME references a `<worker>.<account>.workers.dev` name absent from the selected Worker inventory. This does not prove that the hostname is publicly unavailable.
- `ROUTE_DNS_MISSING`: an explicit Worker route hostname has no DNS record; confirm whether the route was intentionally left unbound.

Limitations: this is control-plane configuration drift detection, not HTTP reachability testing. It deliberately does not read sensitive TXT/MX values, external DNS, Pages hostnames, or compute a web availability conclusion from a proxy-only DNS record. Wildcard routes and CNAME chains are not exhaustively expanded; follow-up verification is necessary.

## Release policy

Do not add this to an automatic production deploy job. CI may run synthetic tests on PRs; live inventory should be a manually invoked, read-only scheduled workflow after read-only secrets are configured. Each hostname or Tunnel repair requires its own reviewed change, a verified intended origin, and a rollback plan. Production Worker uploads or deployments remain approval gated.
