# Bun native routes vs manual fetch routing — two processes

This is an **isolated local microbenchmark**, not an application benchmark or a production service. It compares Bun 1.4.4 `Bun.serve({ routes })` against a `fetch(req)` handler that calls `new URL(req.url)`, splits the pathname and runs `decodeURIComponent`.

**No live Fantasy402 credentials, endpoints, sessions, customer records, or production traffic.** The URL and expected body are synthetic. The server binds **127.0.0.1 on port 0**, and each observation launches a new child process.

## Run and save a real measurement snapshot

```sh
bun --revision     # should be 1.4.4 (repository pin)
mkdir -p scratch/bench
bun test tests/routes_vs_fetch_2proc_bench.test.ts
bun run bench/routes-vs-fetch-2proc.bench.ts \
  --rounds=4 --warmup=2000 --latency=10000 --heap=2000 \
  --output=scratch/bench/routes-vs-fetch-2proc.json

# Machine-readable JSON to stdout; progress stays on stderr:
bun run bench/routes-vs-fetch-2proc.bench.ts \
  --rounds=4 --json > scratch/bench/routes-vs-fetch-2proc.stdout.json

# Fast development smoke (NOT a statistically robust performance claim):
bun run bench/routes-vs-fetch-2proc.bench.ts \
  --rounds=1 --warmup=100 --latency=200 --heap=100
```

The output file is **written only when `--output` is requested**. `scratch/` is gitignored. A snapshot is *real measured data* and includes timestamp, **git commit and dirty-worktree flag**, Bun version and revision, OS/architecture, CPU model and logical CPU count, settings, each run and median summary. No fabricated latency numbers are committed.

## What is actually measured

| Metric | Correct interpretation |
| --- | --- |
| `p50_us`, `p95_us`, `p99_us`, `max_us` | **Client-observed**, serial one-at-a-time HTTP request + consumed body, microseconds. Includes loopback networking, Bun client overhead and both processes' scheduling. **Not** handler-only time. |
| `retained_cells_per_request` | (Server JSC cells after full GC − before full GC) / batch size. Signed **survivor** delta; can be negative and is **not allocations per request**. |
| `retained_bytes_per_request` | Same surviving-JSC-heap delta / batch size. Includes off-heap memory owned by JS objects; excludes other native/OS allocations. |
| `route_p50_improvement_pct` | `(manual_p50 - routes_p50) / manual_p50 × 100`. Positive means native routes have lower observed median latency. |

The two processes isolate **client JSC allocations** from server `heapStats()`, but do not eliminate HTTP, network stack, process scheduling, GC, CPU frequency, cache or native-memory effects.

The server control endpoint invokes `fullGC()` **before both snapshots** and then reads `heapStats()`; there is **no** non-GC `objectCount` or `heapSize` subtraction masquerading as an allocation counter. Transient allocations that were collected are invisible to this metric. Use Bun CPU/heap profiling or allocation instrumentation for allocator throughput, and repeat measurements when looking for leaks.

## Fairness and failure controls

1. Each round runs **both modes** in balanced AB/BA order, with a **fresh server child for every observation**. Four rounds produce eight child-server runs; final metrics are medians of per-run quantiles, *not pooled* samples.
2. Both modes bind loopback, expose one route and a GC control route, return the **exact same decoded body** for `/api/customers/AGT%20402/wagers/G99120488`, and fail before timing if the result differs. The fetch handler validates the same path shape and responds 404 on unmatched paths.
3. One request in flight at a time; warmup JIT and keep-alive pool before sampling. The typed-array latency samples are held only in the client, never in the server JSC heap.
4. `Bun.nanoseconds()` times fetch+body. The Bun-only `fetch.timeout` is a **5s socket inactivity watchdog**, while one shared AbortController bounds the whole child-run duration (default 120s). Neither stopwatch is a `FetchSession.keepAlive.idleTimeout`, whose value is in seconds and applies **after** a response.
5. A bounded child stdout handshake identifies the random loopback origin (8s deadline). SIGINT/SIGTERM aborts further work and terminates the child; shutdown uses SIGTERM then a 2s SIGKILL fallback.
6. Report all raw per-run summaries and hardware/runtime metadata. Compare successive runs on similar hardware and controlled background load; never report an unrun benchmark as a verified 50% speedup.

## Result honesty

This benchmark can establish a **repeatable directional difference** in this narrow handler workload. It does **not** establish a server-only allocation rate, end-to-end SportsDesk production speedup, memory safety, concurrency scaling, or the latency of the actual customer/wager backend.

Each child runs 16 GET preflight cases and compares the HTTP status, exact text body and `X-Error-Code` header. The focused test command runs this check over loopback against both routing implementations.

| Condition | Status | Body | X-Error-Code |
| --- | --- | --- | --- |
| Valid identifiers | 200 | Decoded agent and wager IDs joined by a colon | Absent |
| Invalid agent ID | 400 | Invalid identifier | INVALID_AGENT_ID |
| Invalid wager ID | 400 | Invalid identifier | INVALID_WAGER_ID |
| Missing path segment or unmatched path | 404 | Not found | ROUTE_NOT_FOUND |

The benchmark decodes each segment once. Both IDs accept ASCII letters, digits, hyphens and underscores. Only the agent ID accepts spaces. Path shape is checked first, then the agent ID, then the wager ID. Query parameters cannot override either path parameter. These are synthetic benchmark rules. Production routing requires a separate application contract.

Use an even number of rounds for balanced ordering. The JSON `paired` rows report manual minus native latency by round, the median and range of those differences, and native wins. Treat the pair as the repeat unit. The `runs` rows include signed whole-batch retained cells and bytes alongside the underlying snapshots. Repeat under representative application and network conditions before drawing a SportsDesk performance conclusion.

Official references:
- [Bun router and percent-decoded params](https://bun.com/docs/runtime/http/routing)
- [Bun benchmark methodology and memory](https://bun.com/docs/project/benchmarking)
- [`bun:jsc.heapStats` semantics](https://bun.sh/reference/bun/jsc/heapStats)
- [Bun subprocess and signal lifecycle](https://bun.com/docs/runtime/child-process)
- [`BunFetchRequestInit.timeout` milliseconds](https://bun.com/reference/globals/BunFetchRequestInit/timeout)
