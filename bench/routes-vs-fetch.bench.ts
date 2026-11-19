// Bun 1.4.4: bun --no-env-file run bench/routes-vs-fetch.bench.ts [--check]
// Synthetic warm loopback latency, not production traffic or router-only time.
const ROUTE = "/api/customers/:agentId/wagers/:wagerId";
const CASES = [
  ["/api/customers/AGT%20402/wagers/G99120488", 200, "AGT 402:G99120488"],
  ["/api/customers/AGT-42/wagers/G8?limit=1", 200, "AGT-42:G8"],
  ["/api/customers/AGT%2F42/wagers/G8", 400, "Invalid identifier"],
  ["/api/customers/AGT%FF/wagers/G8", 400, "Invalid identifier"],
  ["/api/customers/AGT%ZZ/wagers/G8", 400, "Invalid identifier"],
  ["/api/accounts/AGT-42/wagers/G8", 404, "Not found"],
  ["/api/customers/AGT-42/wagers/G8/extra", 404, "Not found"],
] as const;
const WARMUP = 2_000;
const SAMPLES = 10_000;
const PAIRED_TRIALS = 6;
const LISTEN = { hostname: "127.0.0.1", port: 0, development: false } as const;

const notFound = () => new Response("Not found", { status: 404 });
const badIdentifier = () => new Response("Invalid identifier", { status: 400 });

// Shared synthetic endpoint policy: a decoded slash, replacement character, or
// literal percent isn't a valid ID. This is not a change to SportsDesk's ID rules.
function respond(agentId: string, wagerId: string): Response {
  return /^[A-Za-z0-9_ -]+$/.test(agentId) && /^[A-Za-z0-9_-]+$/.test(wagerId)
    ? new Response(`${agentId}:${wagerId}`)
    : badIdentifier();
}

function manual(req: Request): Response {
  const parts = new URL(req.url).pathname.split("/");
  const agentId = parts[3];
  const wagerId = parts[5];
  if (
    parts.length !== 6 ||
    parts[1] !== "api" ||
    parts[2] !== "customers" ||
    parts[4] !== "wagers" ||
    !agentId ||
    !wagerId
  ) {
    return notFound();
  }
  let agent: string;
  let wager: string;
  try {
    agent = decodeURIComponent(agentId);
    wager = decodeURIComponent(wagerId);
  } catch {
    return badIdentifier();
  }
  return respond(agent, wager);
}

async function preflight(mode: string, origin: string): Promise<void> {
  for (const [path, status, body] of CASES) {
    const response = await fetch(origin + path);
    const actual = await response.text();
    if (response.status !== status || actual !== body) {
      throw new Error(
        `${mode}: ${path} gave ${response.status} ${JSON.stringify(actual)}; expected ${status} ${JSON.stringify(body)}`,
      );
    }
  }
}

async function request(target: string, expected: string): Promise<void> {
  const response = await fetch(target);
  const actual = await response.text();
  if (response.status !== 200 || actual !== expected) {
    throw new Error(`Invalid benchmark response: ${response.status} ${actual}`);
  }
}

async function measure(origin: string, samples: Float64Array) {
  const [path, , expected] = CASES[0];
  const target = origin + path;
  for (let i = 0; i < WARMUP; i++) await request(target, expected);
  for (let i = 0; i < samples.length; i++) {
    const start = Bun.nanoseconds();
    await request(target, expected);
    samples[i] = (Bun.nanoseconds() - start) / 1_000;
  }
  samples.sort();
  const percentile = (p: number) =>
    samples[Math.ceil(samples.length * p) - 1]!;
  return {
    p50_us: percentile(0.5),
    p95_us: percentile(0.95),
    p99_us: percentile(0.99),
    max_us: percentile(1),
  };
}

const routes = Bun.serve({
  ...LISTEN,
  routes: {
    [ROUTE]: (req) => respond(req.params.agentId, req.params.wagerId),
  },
  fetch: notFound,
});

try {
  const fetchServer = Bun.serve({ ...LISTEN, fetch: manual });
  try {
    const origins = { routes: routes.url.origin, manual: fetchServer.url.origin };
    await preflight("routes", origins.routes);
    await preflight("manual", origins.manual);

    const metadata = {
      workload: "synthetic warm HTTP loopback, one request at a time",
      bun: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      measuredPath: CASES[0][0],
      parityChecks: CASES.length,
    };
    if (process.argv.includes("--check")) {
      console.log(JSON.stringify(metadata, null, 2));
    } else {
      const samples = new Float64Array(SAMPLES);
      const trials = [];
      for (let i = 0; i < PAIRED_TRIALS; i++) {
        const [first, second] =
          i % 2 === 0
            ? (["routes", "manual"] as const)
            : (["manual", "routes"] as const);
        const firstResult = await measure(origins[first], samples);
        const secondResult = await measure(origins[second], samples);
        const [native, manual] =
          first === "routes"
            ? [firstResult, secondResult]
            : [secondResult, firstResult];
        trials.push({
          order: [first, second],
          routes: native,
          manual,
          manual_minus_routes_us: {
            p50: manual.p50_us - native.p50_us,
            p95: manual.p95_us - native.p95_us,
            p99: manual.p99_us - native.p99_us,
          },
        });
      }
      console.log(
        JSON.stringify(
          { ...metadata, warmupPerMode: WARMUP, samplesPerMode: SAMPLES, trials },
          null,
          2,
        ),
      );
    }
  } finally {
    fetchServer.stop(true);
  }
} finally {
  routes.stop(true);
}
