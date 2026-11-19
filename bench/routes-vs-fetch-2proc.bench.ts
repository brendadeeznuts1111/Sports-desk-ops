// Two-process Bun HTTP microbenchmark; no production traffic or credentials.
// Run: bun run bench/routes-vs-fetch-2proc.bench.ts
// JSON snapshot: bun run bench/routes-vs-fetch-2proc.bench.ts --output=scratch/bench/routes-2proc.json
import { fullGC, heapStats } from "bun:jsc";
import { cpus } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  benchmarkOrder,
  retainedHeapDelta,
  routeImprovementPct,
  summarizeLatencies,
  summarizeRuns,
  type BenchMode,
  type HeapSnap,
  type RunResult,
} from "./routes-vs-fetch-2proc.core";

const WAGER_PATH = "/api/customers/AGT%20402/wagers/G99120488";
const EXPECTED_BODY = "AGT 402:G99120488";
const ROUTE = "/api/customers/:agentId/wagers/:wagerId";
const STARTUP_TIMEOUT_MS = 8_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

interface Settings {
  rounds: number;
  warmup: number;
  latency: number;
  heap: number;
  timeoutMs: number;
  output: string | null;
  json: boolean;
}

function parseSettings(argv: string[]): Settings {
  const settings: Settings = {
    rounds: 4,
    warmup: 2_000,
    latency: 10_000,
    heap: 2_000,
    timeoutMs: 120_000,
    output: null,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") {
      settings.json = true;
      continue;
    }
    if (arg === "--help") {
      console.log(
        "Usage: bun run bench/routes-vs-fetch-2proc.bench.ts " +
          "[--rounds=4] [--warmup=2000] [--latency=10000] " +
          "[--heap=2000] [--timeout-ms=120000] [--output=path.json] [--json]",
      );
      process.exit(0);
    }
    const match = /^--(rounds|warmup|latency|heap|timeout-ms|output)=(.+)$/.exec(arg);
    if (!match) throw new Error("Unknown benchmark option: " + arg);
    const name = match[1]!;
    const value = match[2]!;
    if (name === "output") {
      settings.output = value;
      continue;
    }
    const parsed = Number(value);
    const max = name === "rounds" ? 20 : 1_000_000;
    const min = name === "warmup" ? 0 : 1;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new RangeError("Invalid --" + name + ": " + value);
    }
    if (name === "timeout-ms") settings.timeoutMs = parsed;
    else if (name === "rounds") settings.rounds = parsed;
    else if (name === "warmup") settings.warmup = parsed;
    else if (name === "latency") settings.latency = parsed;
    else if (name === "heap") settings.heap = parsed;
  }
  return settings;
}

/** Both server modes bind loopback only; memory control calls cannot be remote. */
function startChildServer(mode: BenchMode): void {
  const snapshot = (): Response => {
    // Both snapshots are after FULL GC, so deltas describe surviving cells,
    // NOT total objects allocated while serving the request batch.
    fullGC();
    const { objectCount, heapSize } = heapStats();
    return Response.json({ objectCount, heapSize } satisfies HeapSnap, {
      headers: { "Cache-Control": "no-store" },
    });
  };
  const notFound = (): Response => new Response("Not Found", { status: 404 });

  const server =
    mode === "routes"
      ? Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          routes: {
            "/__gc": snapshot,
            [ROUTE]: (req) => {
              const { agentId, wagerId } = req.params;
              return new Response(agentId + ":" + wagerId);
            },
          },
          fetch: notFound,
        })
      : Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            const pathname = new URL(req.url).pathname;
            if (pathname === "/__gc") return snapshot();
            const parts = pathname.split("/");
            if (
              parts.length !== 6 ||
              parts[1] !== "api" ||
              parts[2] !== "customers" ||
              parts[4] !== "wagers" ||
              !parts[3] ||
              !parts[5]
            ) {
              return notFound();
            }
            const agentId = decodeURIComponent(parts[3]);
            const wagerId = decodeURIComponent(parts[5]);
            return new Response(agentId + ":" + wagerId);
          },
        });

  // Child stdout is a one-line readiness protocol, not a logging surface.
  process.stdout.write(server.url.origin + "\n");
  const stop = () => {
    void server.stop(true).then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Child exited before readiness handshake");
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_048) throw new Error("Child handshake exceeds 2KiB");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) return buffer.slice(0, newline).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

function makeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Child emitted a non-loopback origin");
  }
  return url.origin;
}

async function readOrigin(proc: Bun.Subprocess): Promise<string> {
  if (!proc.stdout || typeof proc.stdout === "number") {
    throw new Error("Missing child stdout pipe");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = readLine(proc.stdout).then(makeOrigin);
    const dead = proc.exited.then((code) => {
      throw new Error("Child exited before handshake (code " + code + ")");
    });
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Child startup timed out")), STARTUP_TIMEOUT_MS);
    });
    return await Promise.race([ready, dead, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopChild(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode !== null) {
    await proc.exited;
    return;
  }
  proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

const children = new Set<Bun.Subprocess>();
const globalAbort = new AbortController();
let interrupted: "SIGINT" | "SIGTERM" | null = null;

function onSignal(signal: "SIGINT" | "SIGTERM"): void {
  if (interrupted) return;
  interrupted = signal;
  globalAbort.abort(new Error("Benchmark interrupted by " + signal));
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

async function runOnce(
  mode: BenchMode,
  round: number,
  settings: Settings,
): Promise<RunResult> {
  if (globalAbort.signal.aborted) throw globalAbort.signal.reason;
  const proc = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, BENCH_ROLE: "server", BENCH_MODE: mode },
    stdout: "pipe",
    stderr: "inherit",
  });
  children.add(proc);
  const timed = new AbortController();
  const timer = setTimeout(
    () => timed.abort(new Error("Benchmark suite exceeded --timeout-ms")),
    settings.timeoutMs,
  );
  const onAbort = () => timed.abort(globalAbort.signal.reason);
  globalAbort.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const origin = await readOrigin(proc);
    const target = origin + WAGER_PATH;
    // One controller per process avoids per-request timer allocations in the
    // client loop. Bun fetch.timeout guards a stalled socket, not total duration.
    const init = {
      signal: timed.signal,
      timeout: 5_000,
    };
    const get = async (url: string): Promise<string> => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error("HTTP " + response.status + " from " + url);
      return response.text();
    };
    const verify = async () => {
      const body = await get(target);
      if (body !== EXPECTED_BODY) {
        throw new Error(mode + " returned " + JSON.stringify(body) + " instead of " + EXPECTED_BODY);
      }
    };

    await verify();
    for (let i = 0; i < settings.warmup; i++) await get(target);
    await verify();

    // End-to-end *client-observed* HTTP fetch+body latency; single outstanding
    // request, separate Bun client process. Not isolated server-handler time.
    const samples = new Float64Array(settings.latency);
    for (let i = 0; i < samples.length; i++) {
      const t0 = Bun.nanoseconds();
      await get(target);
      samples[i] = (Bun.nanoseconds() - t0) / 1_000;
    }
    const latency = summarizeLatencies(samples);
    await verify();

    const heap = async (): Promise<HeapSnap> => {
      const response = await fetch(origin + "/__gc", init);
      if (!response.ok) throw new Error("Unable to sample server heap");
      const snap = (await response.json()) as HeapSnap;
      if (
        !Number.isFinite(snap.objectCount) ||
        !Number.isFinite(snap.heapSize) ||
        snap.objectCount < 0 ||
        snap.heapSize < 0
      ) {
        throw new Error("Malformed server heap snapshot");
      }
      return snap;
    };

    const before = await heap();
    for (let i = 0; i < settings.heap; i++) await get(target);
    const after = await heap();
    return {
      round,
      mode,
      ...latency,
      ...retainedHeapDelta(before, after, settings.heap),
      heap_before: before,
      heap_after: after,
    };
  } finally {
    clearTimeout(timer);
    globalAbort.signal.removeEventListener("abort", onAbort);
    await stopChild(proc);
    children.delete(proc);
  }
}

async function main(): Promise<void> {
  const settings = parseSettings(process.argv.slice(2));
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  const runs: RunResult[] = [];

  for (const { round, mode } of benchmarkOrder(settings.rounds)) {
    if (globalAbort.signal.aborted) throw globalAbort.signal.reason;
    console.error("Benchmark " + round + "/" + settings.rounds + ": " + mode);
    runs.push(await runOnce(mode, round, settings));
  }

  const routes = summarizeRuns(runs, "routes");
  const manual = summarizeRuns(runs, "fetch");
  const delta = {
    mode: "fetch - routes",
    p50_us: Number((manual.p50_us - routes.p50_us).toFixed(2)),
    p95_us: Number((manual.p95_us - routes.p95_us).toFixed(2)),
    p99_us: Number((manual.p99_us - routes.p99_us).toFixed(2)),
    max_us: Number((manual.max_us - routes.max_us).toFixed(2)),
    retained_cells_per_request: Number(
      (manual.retained_cells_per_request - routes.retained_cells_per_request).toFixed(4),
    ),
    retained_bytes_per_request: Number(
      (manual.retained_bytes_per_request - routes.retained_bytes_per_request).toFixed(2),
    ),
  };
  const cpu = cpus();
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpu_model: cpu[0]?.model ?? "unknown",
      logical_cpus: cpu.length,
    },
    settings: {
      rounds: settings.rounds,
      warmup_requests_per_run: settings.warmup,
      latency_requests_per_run: settings.latency,
      heap_requests_per_run: settings.heap,
      timeout_ms_per_process: settings.timeoutMs,
      concurrency: 1,
      request_path: WAGER_PATH,
      expected_body: EXPECTED_BODY,
    },
    methodology: {
      latency: "Client-observed serial HTTP fetch plus consumed body, microseconds",
      quantiles: "Nearest-rank within run; final value = median of run-level quantiles",
      heap: "Full GC before and after batch; surviving JSC heap/cell delta per request, not allocation rate",
      exclusions: "JSC heap excludes native allocations; OS/cache/GC timing can still affect results",
    },
    runs,
    summary: { routes, fetch: manual, delta, route_p50_improvement_pct: routeImprovementPct(routes, manual) },
  };

  if (settings.output) {
    await mkdir(dirname(settings.output), { recursive: true });
    await Bun.write(settings.output, JSON.stringify(report, null, 2) + "\n");
    console.error("Saved measurement snapshot: " + settings.output);
  }
  if (settings.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const columns = [
      "mode",
      "p50_us",
      "p95_us",
      "p99_us",
      "max_us",
      "retained_cells_per_request",
      "retained_bytes_per_request",
    ];
    console.log(Bun.inspect.table([routes, manual, delta], columns, { colors: Boolean(process.stdout.isTTY) }));
    console.log("Native routes p50 improvement (%): " + report.summary.route_p50_improvement_pct);
    console.log("Heap columns measure post-GC survivors, NOT per-request allocations.");
  }
}

if (process.env.BENCH_ROLE === "server") {
  if (process.env.BENCH_MODE !== "routes" && process.env.BENCH_MODE !== "fetch") {
    throw new Error("Invalid BENCH_MODE");
  }
  startChildServer(process.env.BENCH_MODE);
} else {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    for (const child of children) await stopChild(child);
  }
}
