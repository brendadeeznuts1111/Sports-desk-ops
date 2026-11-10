#!/usr/bin/env bun
/**
 * @file scripts/health_check.ts
 * @description Fast zero-dependency HTTP health check for SportsDesk local services.
 * Tests actual application-layer reachability on ports 4022 (Dashboard) and 4020 (Desk API).
 */

interface ServiceProbe {
  readonly name: string;
  readonly url: string;
  readonly port: number;
  readonly critical: boolean;
}

const SERVICES: readonly ServiceProbe[] = [
  {
    name: "SportsDesk Dashboard SPA & Dev Server",
    url: "http://127.0.0.1:4022/health",
    port: 4022,
    critical: true,
  },
  {
    name: "SportsDesk Core API Daemon",
    url: "http://127.0.0.1:4020/health",
    port: 4020,
    critical: false,
  },
];

async function probeService(service: ServiceProbe): Promise<{
  readonly ok: boolean;
  readonly status: number | string;
  readonly latencyMs: number;
  readonly payload?: unknown;
}> {
  const start = performance.now();
  try {
    const res = await fetch(service.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const latencyMs = Math.round(performance.now() - start);
    let payload: unknown = undefined;
    try {
      payload = await res.json();
    } catch {
      // Non-JSON or empty
    }
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      payload,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      status: err instanceof Error ? err.name : "ERR_FAILED",
      latencyMs,
    };
  }
}

async function main() {
  const isJson = process.argv.includes("--json");
  const results = [];
  let allHealthy = true;

  if (!isJson) {
    console.log(
      "\x1b[1;36m⚡ SportsDesk Operations Local Health Check (Bun v" +
        Bun.version +
        ")\x1b[0m",
    );
    console.log(
      "\x1b[90mTargeting local stack on ports 4022 (SPA) & 4020 (API)\x1b[0m\n",
    );
  }

  for (const s of SERVICES) {
    let result = await probeService(s);
    // If /health returns 404/non-200, try root fallback for SPA
    if (!result.ok && s.port === 4022) {
      const fallback = await probeService({
        ...s,
        url: "http://127.0.0.1:4022/",
      });
      if (fallback.ok) {
        result = fallback;
      }
    }

    results.push({ service: s, result });
    if (!result.ok && s.critical) {
      allHealthy = false;
    }

    if (!isJson) {
      const statusSymbol = result.ok
        ? "\x1b[32m● OK\x1b[0m"
        : s.critical
          ? "\x1b[31m✖ FAIL\x1b[0m"
          : "\x1b[33m▲ WARN\x1b[0m";
      const latencyStr = `\x1b[90m(${result.latencyMs}ms)\x1b[0m`;
      console.log(
        `  ${statusSymbol} \x1b[1m${s.name}\x1b[0m on :${s.port} ${latencyStr}`,
      );
      console.log(`     URL: ${s.url} · HTTP Status: ${result.status}`);
      if (
        result.payload &&
        typeof result.payload === "object" &&
        "alerts" in result.payload
      ) {
        const a = (
          result.payload as {
            alerts: {
              status: string;
              backlog: number;
              delivered: number;
              dead: number;
            };
          }
        ).alerts;
        const aColor =
          a.status === "ok"
            ? "\x1b[32m● OK\x1b[0m"
            : a.status === "warning"
              ? "\x1b[33m▲ WARN\x1b[0m"
              : "\x1b[31m✖ DEGRADED\x1b[0m";
        console.log(
          `     Alerts: ${aColor} (backlog: ${a.backlog}, delivered: ${a.delivered}, dead: ${a.dead})`,
        );
      }
      if (!result.ok) {
        console.log(
          `     \x1b[33mRemedy:\x1b[0m ${
            s.port === 4022 ? "bun run dev" : "bun run serve"
          }`,
        );
      }
    }
  }

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          allHealthy,
          services: results.map((r) => ({
            name: r.service.name,
            port: r.service.port,
            ok: r.result.ok,
            status: r.result.status,
            latencyMs: r.result.latencyMs,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log();
    if (allHealthy) {
      console.log(
        "\x1b[1;32m✔ Local stack is healthy and ready for operator workflows.\x1b[0m",
      );
    } else {
      console.log(
        "\x1b[1;31m✖ One or more critical services are offline.\x1b[0m",
      );
    }
  }

  process.exit(allHealthy ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
