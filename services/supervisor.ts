#!/usr/bin/env bun
/**
 * Minimal process supervisor for the long-lived services.
 *
 * - Starts each service as a child, restarts it with capped exponential backoff on exit.
 * - Polls every service's `/health`; three consecutive failures kill and restart that child.
 * - Stops all children on SIGINT/SIGTERM; no orphan processes.
 *
 * The blob gateway is opt-in: without BLOB_API_TOKEN/BLOB_TICKET_SECRET it is not supervised, so a
 * checkout that has not provisioned R2 credentials still runs the daemon alone.
 */

import { env } from "bun";

import { resolveSecretBackedEnv } from "../lib/r2_s3_client.ts";
import { guardedSecrets } from "../lib/keychain_access.ts";

export interface ServiceSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly healthUrl: string;
}

export type SupervisorKill = (signal?: "SIGTERM" | "SIGKILL") => void;

export interface SupervisorProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly kill: SupervisorKill;
}

export interface SupervisorOptions {
  readonly services?: readonly ServiceSpec[];
  readonly healthIntervalMs?: number;
  readonly unhealthyThreshold?: number;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly spawnImpl?: (command: readonly string[]) => SupervisorProcess;
  readonly noEnvFile?: boolean;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test/daemon hook: aborting stops children and resolves `supervise`. */
  readonly signal?: AbortSignal;
}

const HEALTH_INTERVAL_MS = 10_000;
const UNHEALTHY_THRESHOLD = 3;
const MAX_RESTART_DELAY_MS = 30_000;

function portFrom(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Service roster; the blob gateway appears only when its credentials are provisioned. */
export function supervisedServices(
  environment: Readonly<Record<string, string | undefined>> = env,
): readonly ServiceSpec[] {
  const webviewPort = portFrom(
    environment,
    "PORT",
    portFrom(environment, "BUN_PORT", 4020),
  );
  const blobPort = portFrom(environment, "BLOB_PORT", 4021);
  const services: ServiceSpec[] = [
    {
      name: "webview",
      command: ["bun", "run", "services/sportsdesk_webview_server.ts"],
      healthUrl:
        environment.WEBVIEW_HEALTH_URL ??
        `http://127.0.0.1:${webviewPort}/health`,
    },
  ];
  if (
    environment.BLOB_API_TOKEN !== undefined &&
    environment.BLOB_TICKET_SECRET !== undefined
  ) {
    services.push({
      name: "blob-live-bets",
      command: ["bun", "run", "services/blob_and_live_bets_server.ts"],
      healthUrl:
        environment.BLOB_HEALTH_URL ?? `http://127.0.0.1:${blobPort}/health`,
    });
  }
  return services;
}

/** Resolve the BLOB_* tokens from the guarded keychain when the environment has none. */
export async function supervisedServicesAsync(
  environment: Readonly<Record<string, string | undefined>> = env,
  secrets: Parameters<typeof resolveSecretBackedEnv>[1] = guardedSecrets,
): Promise<readonly ServiceSpec[]> {
  return supervisedServices(await resolveSecretBackedEnv(environment, secrets));
}

/** Capped exponential backoff: 1s, 2s, 4s … 30s. */
export function restartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(5, attempt));
  return Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** exponent);
}

export async function checkHealth(
  url: string,
  options: {
    readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface Child {
  readonly spec: ServiceSpec;
  process: SupervisorProcess;
  restarts: number;
  unhealthy: number;
  starting: boolean;
}

export async function supervise(
  options: SupervisorOptions = {},
): Promise<void> {
  const services = options.services ?? (await supervisedServicesAsync());
  const log =
    options.log ??
    ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const threshold = options.unhealthyThreshold ?? UNHEALTHY_THRESHOLD;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const noEnvFile = options.noEnvFile ?? Bun.env.SUPERVISOR_NO_ENV_FILE === "1";
  const spawnImpl =
    options.spawnImpl ??
    ((command: readonly string[]): SupervisorProcess => {
      const [bin, ...rest] = command;
      const args =
        bin === undefined
          ? [...command]
          : [
              bin,
              "--no-orphans",
              ...(noEnvFile ? ["--no-env-file"] : []),
              ...rest,
            ];
      return Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
    });

  let stopping = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const children: Child[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  const start = (spec: ServiceSpec): Child => {
    const child: Child = {
      spec,
      process: spawnImpl(spec.command),
      restarts: 0,
      unhealthy: 0,
      starting: true,
    };
    log({
      event: "start",
      service: spec.name,
      pid: child.process.pid,
      command: spec.command.join(" "),
    });
    void child.process.exited.then((code: number) => {
      if (stopping) return;
      const delay = restartDelayMs(child.restarts);
      child.restarts += 1;
      log({
        event: "exit",
        service: spec.name,
        code,
        restartInMs: delay,
      });
      void sleep(delay).then(() => {
        if (!stopping) {
          child.process = spawnImpl(spec.command);
          log({
            event: "restart",
            service: spec.name,
            pid: child.process.pid,
          });
        }
      });
    });
    return child;
  };

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ event: "shutdown", signal });
    for (const timer of timers) clearInterval(timer);
    for (const child of children) {
      try {
        child.process.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    resolveFinished();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  options.signal?.addEventListener("abort", () => stop("abort"));
  if (options.signal?.aborted === true) stop("abort");

  for (const spec of services) {
    const child = start(spec);
    children.push(child);
    timers.push(
      setInterval(() => {
        if (stopping) return;
        void checkHealth(spec.healthUrl, { fetchImpl }).then((healthy) => {
          if (stopping) return;
          if (healthy) {
            child.unhealthy = 0;
            child.starting = false;
            return;
          }
          child.unhealthy += 1;
          log({
            event: "unhealthy",
            service: spec.name,
            failures: child.unhealthy,
            healthUrl: spec.healthUrl,
          });
          if (child.unhealthy >= threshold) {
            child.unhealthy = 0;
            log({ event: "restart-unhealthy", service: spec.name });
            try {
              child.process.kill("SIGTERM");
            } catch {
              // already gone
            }
          }
        });
      }, healthIntervalMs),
    );
  }

  log({
    event: "supervising",
    services: services.map((spec) => ({
      name: spec.name,
      healthUrl: spec.healthUrl,
    })),
  });
  await finished;
}

if (import.meta.main) {
  await supervise().catch((error: unknown) => {
    console.error(
      `supervisor: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
