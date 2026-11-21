#!/usr/bin/env bun
/**
 * @file scripts/probe-registry.ts
 * @description Probe every registry the project uses, snapshot the result, and (in CI) record it.
 *
 * `registry:check` answers "which registry does this one name resolve to, and is the host up?".
 * This answers the release question instead: can every configured registry serve its canary
 * package right now? A registry root can return 200 from a landing page while its packument API
 * is broken, and a scope can be routed to a registry that has never heard of the package.
 *
 *   bun scripts/probe-registry.ts \
 *     --probe-pkg default=bun \
 *     --probe-pkg @sportsdesk=@sportsdesk/contracts \
 *     --dry-run
 *
 *   bun scripts/probe-registry.ts --strict   # upload the snapshot to R2, exit 1 on any failure
 *
 * Flags:
 *   --probe-pkg <selector>=<package>   canary per registry; repeatable. `<selector>` is `default`
 *                                      or a `@scope` from .npmrc. A scope without a canary is
 *                                      probed at its registry root instead.
 *   --dry-run                          print/write the snapshot, never upload
 *   --strict                           record the snapshot to R2 and exit 1 if ANY registry fails
 *   --out <path>                       also write the snapshot JSON to this path
 *   --json                             machine-readable output
 *   --help, -h
 *
 * Exit codes: 0 ok, 1 probe/gate failure, 2 usage.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { type NpmrcConfig, parseNpmrc } from "../lib/npm_registry.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";

export interface ProbeTarget {
  /** `default` or `@scope`. */
  readonly selector: string;
  readonly registry: string;
  /** Canary package; `null` probes the registry root. */
  readonly canary: string | null;
}

export interface ProbeResult extends ProbeTarget {
  readonly url: string;
  readonly status: number | null;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error: string | null;
}

export interface SnapshotBody {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: "dry-run" | "live";
  readonly ok: boolean;
  readonly results: readonly ProbeResult[];
}

export interface RegistrySnapshot extends SnapshotBody {
  readonly upload: {
    readonly status: "skipped" | "ok" | "failed";
    readonly keys?: readonly string[];
    readonly error?: string;
  };
}

export interface ProbePkg {
  readonly selector: string;
  readonly canary: string;
}

const DEFAULT_CANARY = "bun";
const DEFAULT_TIMEOUT_MS = 5_000;
const UPLOAD_PREFIX = "registry-probe";

const HELP = `probe-registry — probe every configured npm registry, snapshot, and gate CI

Options:
  --probe-pkg <selector>=<package>   canary package for a registry; repeatable
                                     selector is "default" or a @scope from .npmrc
  --dry-run                          snapshot only, never upload to R2
  --strict                           exit 1 if any registry fails; upload is required
  --out <path>                       also write the snapshot JSON here
  --json                             machine-readable snapshot on stdout
  -h, --help                         this text

Exit codes:
  0  every probe answered
  1  a probe failed under --strict, a network error, or --strict could not upload
  2  a flag was rejected

Examples:
  bun scripts/probe-registry.ts --probe-pkg default=bun --dry-run
  bun scripts/probe-registry.ts --probe-pkg @sportsdesk=@sportsdesk/contracts --dry-run
  bun scripts/probe-registry.ts --strict
  bun scripts/probe-registry.ts --json --out scratch/registry-probe.json
`;

/** `--probe-pkg default=bun` / `--probe-pkg @scope=pkg`; `null` means "not this flag's value". */
export function parseProbePkg(raw: string): ProbePkg | null {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) return null;
  const selector = raw.slice(0, eq).trim();
  const canary = raw.slice(eq + 1).trim();
  if (selector === "" || canary === "") return null;
  if (selector !== "default" && !selector.startsWith("@")) return null;
  return { selector, canary };
}

/** One target per configured registry; a `--probe-pkg` canary wins, scope roots have none. */
export function resolveProbeTargets(
  config: NpmrcConfig,
  canaries: readonly ProbePkg[],
): { targets: ProbeTarget[]; errors: string[] } {
  const errors: string[] = [];
  const configured = new Map<string, string>();
  if (config.defaultRegistry !== null) {
    configured.set("default", config.defaultRegistry);
  }
  for (const [scope, url] of Object.entries(config.scopes)) {
    configured.set(scope, url);
  }

  const canaryBySelector = new Map<string, string>();
  for (const entry of canaries) {
    if (!configured.has(entry.selector)) {
      const known = [...configured.keys()].sort().join(", ") || "(none)";
      errors.push(
        `--probe-pkg ${entry.selector}=${entry.canary}: no such registry (configured: ${known})`,
      );
      continue;
    }
    canaryBySelector.set(entry.selector, entry.canary);
  }

  const targets: ProbeTarget[] = [];
  for (const [selector, registry] of configured) {
    const explicit = canaryBySelector.get(selector);
    const canary = explicit ?? (selector === "default" ? DEFAULT_CANARY : null);
    targets.push({ selector, registry, canary });
  }
  return { targets, errors };
}

/**
 * Registry URL for one canary. npm's packument route for a scoped package keeps the `@` and
 * encodes the slash (`@scope%2fname`), so the slash is replaced before the URL join, not after.
 */
export function canaryUrl(registry: string, canary: string): string {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const encoded = canary.replace("/", "%2f");
  return new URL(encoded, base).toString();
}

/** Hide `user:pass@` if an .npmrc ever carries credentials in the URL. */
function sanitise(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "")
      return parsed.toString();
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Probe one target. Every failure is returned, never thrown. */
export async function probeTarget(
  target: ProbeTarget,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProbeResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const url =
    target.canary === null
      ? sanitise(target.registry)
      : sanitise(canaryUrl(target.registry, target.canary));
  const started = Bun.nanoseconds();
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return {
      ...target,
      url,
      status: response.status,
      ok: response.ok,
      latencyMs: Math.round((Bun.nanoseconds() - started) / 1e6),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ...target,
      url,
      status: null,
      ok: false,
      latencyMs: Math.round((Bun.nanoseconds() - started) / 1e6),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** All targets in parallel: one unreachable registry cannot delay the report. */
export function probeAll(
  targets: readonly ProbeTarget[],
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProbeResult[]> {
  return Promise.all(targets.map((target) => probeTarget(target, options)));
}

/**
 * `--strict` fails on any probe; without it only a transport error is actionable, because a 404
 * from a reachable registry just means "not published" (the `registry:check` rule).
 */
export function exitCodeFor(
  results: readonly ProbeResult[],
  strict: boolean,
): number {
  if (strict) return results.every((result) => result.ok) ? 0 : 1;
  return results.some((result) => result.status === null) ? 1 : 0;
}

/** R2 keys for one snapshot: a timestamped object plus the `latest` pointer. */
export function snapshotKeys(iso: string): readonly [string, string] {
  const stamp = iso.replace(/[:.]/g, "-");
  return [`${UPLOAD_PREFIX}/${stamp}.json`, `${UPLOAD_PREFIX}/latest.json`];
}

async function uploadSnapshot(
  body: SnapshotBody,
): Promise<RegistrySnapshot["upload"]> {
  const client = await R2S3Client.fromEnvOrSecrets();
  if (client === null) {
    return {
      status: "failed",
      error:
        "no R2 credentials (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY or the Cloudflare token pair)",
    };
  }
  const keys = snapshotKeys(body.generatedAt);
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  try {
    for (const key of keys) {
      await client.write(key, payload, { type: "application/json" });
    }
    return { status: "ok", keys };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface Args {
  readonly probePkg: readonly ProbePkg[];
  readonly dryRun: boolean;
  readonly strict: boolean;
  readonly json: boolean;
  readonly out: string | null;
}

/** Closed flag set: an unknown flag is a usage error, never silently ignored. */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const probePkg: ProbePkg[] = [];
  let dryRun = false;
  let strict = false;
  let json = false;
  let out: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = (): string | null => argv[index + 1] ?? null;
    switch (arg) {
      case "--probe-pkg": {
        const raw = value();
        if (raw === null)
          return { error: "--probe-pkg needs <selector>=<package>" };
        const parsed = parseProbePkg(raw);
        if (parsed === null) {
          return {
            error: `--probe-pkg ${raw}: expected default=<pkg> or @scope=<pkg>`,
          };
        }
        probePkg.push(parsed);
        index += 1;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--json":
        json = true;
        break;
      case "--out": {
        const raw = value();
        if (raw === null || raw.startsWith("-"))
          return { error: "--out needs a path" };
        out = raw;
        index += 1;
        break;
      }
      default:
        return { error: `unknown flag "${arg}"` };
    }
  }
  return { probePkg, dryRun, strict, json, out };
}

async function readConfig(): Promise<NpmrcConfig> {
  const project = Bun.file(".npmrc");
  const home = Bun.file(join(homedir(), ".npmrc"));
  const base: NpmrcConfig = (await project.exists())
    ? parseNpmrc(await project.text())
    : { defaultRegistry: null, scopes: {} };
  const over: NpmrcConfig = (await home.exists())
    ? parseNpmrc(await home.text())
    : { defaultRegistry: null, scopes: {} };
  return {
    defaultRegistry: over.defaultRegistry ?? base.defaultRegistry,
    scopes: { ...base.scopes, ...over.scopes },
  };
}

function render(snapshot: RegistrySnapshot): string {
  const lines = [
    `probe-registry · ${snapshot.mode} · ${snapshot.ok ? "OK" : "FAILED"}`,
    `snapshot: ${snapshot.generatedAt}`,
    "",
  ];
  for (const result of snapshot.results) {
    const label = result.canary === null ? "root" : result.canary;
    lines.push(
      `${result.ok ? "OK  " : "FAIL"} ${result.selector.padEnd(14)} ${label.padEnd(28)} ${
        result.status === null ? "unreachable" : `HTTP ${result.status}`
      } · ${result.latencyMs} ms · ${result.url}`,
    );
    if (result.error !== null && result.status !== null) {
      lines.push(`     ${result.error}`);
    }
  }
  lines.push(
    "",
    `upload: ${snapshot.upload.status}${
      snapshot.upload.keys === undefined
        ? ""
        : ` (${snapshot.upload.keys.join(", ")})`
    }${snapshot.upload.error === undefined ? "" : ` — ${snapshot.upload.error}`}`,
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`probe-registry: ${parsed.error}`);
    console.error("  bun scripts/probe-registry.ts --help");
    return 2;
  }

  const config = await readConfig();
  const { targets, errors } = resolveProbeTargets(config, parsed.probePkg);
  if (errors.length > 0) {
    for (const error of errors) console.error(`probe-registry: ${error}`);
    console.error("  bun scripts/probe-registry.ts --help");
    return 2;
  }
  if (targets.length === 0) {
    console.error(
      "probe-registry: no registry configured (set `registry=` or a `@scope:registry=` in .npmrc)",
    );
    return 2;
  }

  const results = await probeAll(targets);
  const body: SnapshotBody = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: parsed.dryRun ? "dry-run" : "live",
    ok: results.every((result) => result.ok),
    results,
  };
  // Only `--strict` records to R2: a bare run stays a read-only probe, so it never reaches for
  // the keychain or writes to the bucket.
  const upload: RegistrySnapshot["upload"] =
    parsed.strict && !parsed.dryRun
      ? await uploadSnapshot(body)
      : { status: "skipped" };
  const snapshot: RegistrySnapshot = { ...body, upload };

  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (parsed.out !== null) {
    await Bun.write(parsed.out, json);
  }
  if (parsed.json) console.log(json.trimEnd());
  else console.log(render(snapshot));

  if (parsed.strict && upload.status === "failed") {
    console.error(
      `probe-registry: --strict requires the snapshot upload: ${upload.error ?? "unknown error"}`,
    );
    return 1;
  }
  return exitCodeFor(results, parsed.strict);
}

if (import.meta.main) {
  process.exit(await main());
}
