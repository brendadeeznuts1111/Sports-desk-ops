# Dashboard WebSocket forensic audit

Pinned with the GSLIVE run: Bun 1.4.4, `bun-types@1.4.4` (`s3.d.ts` 9d6d1979…, `serve.d.ts` a006fe6f…),
`packages/api/src/ws.ts` `accc0e4a…` at the time of the fix.

## Results (probe_ws.ts, live sockets on an ephemeral port)

| Check                                        | Result                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Declared limits                              | `maxPayloadLength` 16,384 · `backpressureLimit` 262,144 · `closeOnBackpressureLimit` true · `idleTimeout` 120 |
| Normal subscribe                             | `{"type":"subscribed","topic":"dashboard",…}`                                                                 |
| Malformed JSON (`not-json`, `{broken`)       | ignored; connection stays open; a later subscribe replies                                                     |
| 32 KiB frame (16 KiB cap)                    | close **1009**                                                                                                |
| Stalled consumer (raw TCP, paused after 101) | 198 frames delivered, 1 dropped, connection closed on the first drop; `silentGap: false`                      |
| Before the fix (direct `ws.send`)            | first non-delivery left the socket open; 104 further zero-status sends before the server closed it            |

## Other probes

- `probe_nanoseconds.ts`: monotonic, 26.078 ms delta vs 26 ms wall, all usage sites are durations.
- `probe_secrets.ts`: `false` = absent and a malformed call throws; `true`/keychain-failure paths are
  **UNVERIFIED** because this sandbox denies `Bun.secrets.set` with `EPERM` on a disposable service.

## Falsified guarantee → fix

`publishDashboardTopicEvent` ignored `ws.send`'s return value, so a lagging dashboard silently lost
frames until the server's own `closeOnBackpressureLimit` caught up. It now closes with
`1011 backpressure` on the first non-delivery (`packages/api/src/ws.ts`), matching the repo's
`lib/ws_backpressure.ts` policy. Unit gates: `tests/dashboard_ws_backpressure.test.ts`,
`tests/ws_limits.test.ts`.

## Reproduce

```sh
bun verification/ws-forensic-audit/run.ts
bun test tests/ws_limits.test.ts tests/dashboard_ws_backpressure.test.ts
```
