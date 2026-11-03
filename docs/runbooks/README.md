# Runbooks & integration guides

Long-form operator and engineering runbooks live here so the repository root stays CLI- and config-focused.

Evidence ledger and OpenAPI citations use **filename only** (for example `operational_guardrails_runbook.md:153`); line numbers still match these files after the move.

| Document                                                                                           | Topic                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [operational_guardrails_runbook.md](./operational_guardrails_runbook.md)                           | Fantasy402 Manager wire evidence, capture guardrails, getWebLog modes |
| [bun_server_runtime_shapes_runbook.md](./bun_server_runtime_shapes_runbook.md)                     | Bun `Server`, WebSocket handlers, TLS, replay shapes                  |
| [bun-pm-policy.md](./bun-pm-policy.md)                                                             | `bun install`, `bun.lock`, machine bunfig, `bun-deps`, `pm:doctor`    |
| [token_architecture_and_verification_runbook.md](./token_architecture_and_verification_runbook.md) | Design tokens, CIEDE2000, WCAG, `gen:tokens`                          |
| [cloudflare_r2_and_api_runbook.md](./cloudflare_r2_and_api_runbook.md)                             | R2 sync, API tokens, reporting pipeline archive                       |
| [os_bun_cron_integration_guide.md](./os_bun_cron_integration_guide.md)                             | Crontab / systemd schedules for `bun run reports`                     |
| [vps_domain_setup_runbook.md](./vps_domain_setup_runbook.md)                                       | `scripts/deploy/deploy_to_vps.sh` production install                  |

Day-1 desk workflow remains in [../OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md](../OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md).
