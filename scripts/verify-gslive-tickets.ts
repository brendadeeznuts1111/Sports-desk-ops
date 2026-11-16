import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  inspect as nodeInspect,
  parseArgs,
  type InspectOptions,
} from "node:util";
import type {
  TicketVerificationMode,
  TicketVerificationSummary,
} from "@sportsdesk-ops/contracts";
import { S3Client } from "bun";
import { getDnsTelemetry, type DnsCacheTelemetry } from "../lib/bun_dns.ts";
import {
  BUN_CI_GOVERNOR_LANE,
  BUN_CI_GOVERNOR_R2_KEY,
  encodePreflightErrorFrame256B,
  type LaneR2Key,
  type PreflightErrorCode,
} from "../src/telemetry/skill-error-frame.ts";

// --- Secret Redaction, Canary & Custom Inspection Helpers ---

function redactFingerprint(secret: string): string {
  if (!secret) return "<UNSET>";
  const digest = new Bun.CryptoHasher("sha256")
    .update(secret)
    .digest("hex")
    .slice(0, 8);
  return `[REDACTED len=${secret.length} sha256:${digest}]`;
}

export function assertNoSecretLeak(
  formatted: string,
  rawSecrets: readonly string[],
): void {
  for (const secret of rawSecrets) {
    if (secret && formatted.includes(secret)) {
      throw new Error(
        "ERR_INSP_SECRET_REDACTION_LEAK: Raw credential detected in formatted output",
      );
    }
  }
  if (
    /(?:Bearer\s+[A-Za-z0-9._-]+|GSLIVE_SESSION_ID=[^\s\]]+)/.test(formatted)
  ) {
    throw new Error(
      "ERR_INSP_SECRET_REDACTION_LEAK: Auth header or session pattern leaked",
    );
  }
}

function assertRedactedCanary(
  target: unknown,
  rawSecrets: readonly string[],
): void {
  assertNoSecretLeak(Bun.inspect(target, { depth: Infinity }), rawSecrets);
  assertNoSecretLeak(
    nodeInspect(target, { showHidden: true, depth: null }),
    rawSecrets,
  );
  assertNoSecretLeak(JSON.stringify(target), rawSecrets);
}

export interface R2ClientConfig {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  toJSON(): Record<string, unknown>;
  [Bun.inspect.custom](
    depth: number,
    options: InspectOptions,
    inspect: typeof nodeInspect,
  ): string;
}

function redactedR2View(fields: {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): Record<string, string> {
  return {
    bucket: fields.bucket,
    endpoint: fields.endpoint,
    region: fields.region,
    accessKeyId: redactFingerprint(fields.accessKeyId),
    secretAccessKey: redactFingerprint(fields.secretAccessKey),
  };
}

function createRedactedR2Config(raw: {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): R2ClientConfig {
  // Closure-isolated credentials: invisible to Object.keys, Reflect.ownKeys, and descriptor values
  const _accessKeyId = raw.accessKeyId;
  const _secretAccessKey = raw.secretAccessKey;

  const safeSummary = () =>
    redactedR2View({
      bucket: raw.bucket,
      endpoint: raw.endpoint,
      region: raw.region,
      accessKeyId: _accessKeyId,
      secretAccessKey: _secretAccessKey,
    });

  const cfg = {
    bucket: raw.bucket,
    endpoint: raw.endpoint,
    region: raw.region,
    toJSON: safeSummary,
    [Bun.inspect.custom](
      depth: number,
      options: InspectOptions,
      inspect: typeof nodeInspect,
    ): string {
      if (depth < 0) return "[R2ClientConfig]";
      return `R2ClientConfig ${inspect(safeSummary(), { ...options, showHidden: false })}`;
    },
  };

  Object.defineProperties(cfg, {
    accessKeyId: {
      get: () => _accessKeyId,
      enumerable: false,
      configurable: false,
    },
    secretAccessKey: {
      get: () => _secretAccessKey,
      enumerable: false,
      configurable: false,
    },
  });

  const frozen = Object.freeze(cfg) as unknown as R2ClientConfig;

  assertRedactedCanary(frozen, [_accessKeyId, _secretAccessKey]);

  return frozen;
}

// --- 1. Fantasy402 Live API Client with True ES #private Field ---

export class Fantasy402ApiClient {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly agentOwner: string;
  #jwt: string;
  #lastCallMs = 0;
  readonly #minIntervalMs = 60;

  constructor(opts: {
    baseUrl: string;
    agentId: string;
    agentOwner: string;
    jwt: string;
  }) {
    if (!opts.agentId || opts.agentId === "BILLY666") {
      throw new Error(
        "ERR_F402_MASTER_AGENT_FORBIDDEN: Leaf agentID required (never BILLY666)",
      );
    }

    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.agentId = opts.agentId;
    this.agentOwner = opts.agentOwner;
    this.#jwt = opts.jwt;

    // Fail-closed startup redaction canary
    assertRedactedCanary(this, [this.#jwt]);
  }

  static async fromEnvAndSecrets(): Promise<Fantasy402ApiClient> {
    let jwt = Bun.env.F402_AUTH_JWT ?? Bun.env.F402_BEARER_TOKEN ?? "";
    if (!jwt && typeof Bun.secrets?.get === "function") {
      jwt =
        (await Bun.secrets.get({
          service: "sportsdesk-ops",
          name: "F402_AUTH_JWT",
        })) ?? "";
    }
    if (!jwt) {
      throw new Error(
        "ERR_F402_NO_TOKEN: Missing F402_AUTH_JWT in env or Bun.secrets (run `dx session login`)",
      );
    }

    const agentId = Bun.env.F402_AGENT_ID;
    if (!agentId) {
      throw new Error("ERR_F402_NO_AGENT: Set F402_AGENT_ID in f402.env");
    }

    const baseUrl = Bun.env.F402_BASE_URL ?? "https://www.fantasy402.com";
    Bun.dns.prefetch(new URL(baseUrl).hostname, 443);

    return new Fantasy402ApiClient({
      baseUrl,
      agentId,
      agentOwner: Bun.env.F402_AGENT_OWNER ?? agentId,
      jwt,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      agentId: this.agentId,
      agentOwner: this.agentOwner,
      jwt: redactFingerprint(this.#jwt),
    };
  }

  [Bun.inspect.custom](
    depth: number,
    options: InspectOptions,
    inspect: typeof nodeInspect,
  ): string {
    if (depth < 0) return "[Fantasy402ApiClient]";
    const safeView = {
      baseUrl: this.baseUrl,
      agentId: this.agentId,
      agentOwner: this.agentOwner,
      jwt: redactFingerprint(this.#jwt),
    };
    return `Fantasy402ApiClient ${inspect(safeView, { ...options, showHidden: false })}`;
  }

  async #pace(): Promise<void> {
    const now = Bun.nanoseconds() / 1e6;
    const wait = this.#minIntervalMs - (now - this.#lastCallMs);
    if (wait > 0) await Bun.sleep(wait);
    this.#lastCallMs = Bun.nanoseconds() / 1e6;
  }

  async #evictStaleToken(): Promise<void> {
    this.#jwt = "";
    if (typeof Bun.secrets?.delete === "function") {
      await Bun.secrets
        .delete({ service: "sportsdesk-ops", name: "F402_AUTH_JWT" })
        .catch(() => {});
    }
  }

  async postForm<T>(
    endpointPath: string,
    formFields: Record<string, string>,
  ): Promise<T> {
    await this.#pace();
    const body = new URLSearchParams({
      agentID: this.agentId,
      agentOwner: this.agentOwner,
      operation: endpointPath.split("/").pop() ?? "",
      RRO: "1",
      ...formFields,
    });

    const res = await fetch(`${this.baseUrl}${endpointPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#jwt}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await this.#evictStaleToken();
      }
      throw new Error(`ERR_F402_HTTP_${res.status}: ${endpointPath} failed`);
    }

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let offset = 0;
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      offset = 3;
    }
    while (
      offset < bytes.length &&
      (bytes[offset] === 0x20 ||
        bytes[offset] === 0x0a ||
        bytes[offset] === 0x0d ||
        bytes[offset] === 0x09)
    ) {
      offset++;
    }

    if (bytes[offset] === 0x3c) {
      await this.#evictStaleToken();
      throw new Error(
        `ERR_F402_HTML_LOGIN_TRAP_200: ${endpointPath} returned HTML on HTTP 200; evicted F402_AUTH_JWT`,
      );
    }

    const text = new TextDecoder().decode(bytes.subarray(offset));
    return JSON.parse(text) as T;
  }
}

// --- 2. Sealed S3Client Wrapper & Cloudflare R2 Factory ---

function sealS3ClientInspection(
  client: S3Client,
  config: R2ClientConfig,
): S3Client {
  const safeClientView = () => redactedR2View(config);

  Object.defineProperties(client, {
    toJSON: {
      value: safeClientView,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    [Bun.inspect.custom]: {
      value(
        depth: number,
        options: InspectOptions,
        inspect: typeof nodeInspect,
      ): string {
        if (depth < 0) return "[S3Client]";
        return `S3Client ${inspect(safeClientView(), { ...options, showHidden: false })}`;
      },
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });

  // Verify the S3Client instance itself passes the redaction canary
  assertRedactedCanary(client, [config.accessKeyId, config.secretAccessKey]);

  return client;
}

/** Cloudflare Pages and R2 tokens must never share a process/token scope. */
export function assertCloudflareTokenIsolation(): void {
  if (Bun.env.CLOUDFLARE_API_TOKEN && Bun.env.CLOUDFLARE_R2_API_TOKEN) {
    throw new Error(
      "ERR_CF_TOKEN_BLEED_10000: CLOUDFLARE_API_TOKEN and CLOUDFLARE_R2_API_TOKEN cannot coexist in R2 scope",
    );
  }
}

export function createR2Client(): { client: S3Client; config: R2ClientConfig } {
  // Enforce shell-boundary token isolation (r2.env vs pages.env)
  assertCloudflareTokenIsolation();

  const accessKeyId =
    Bun.env.R2_ACCESS_KEY_ID ?? Bun.env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey =
    Bun.env.R2_SECRET_ACCESS_KEY ?? Bun.env.AWS_SECRET_ACCESS_KEY ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "ERR_R2_AUTH_MISSING: Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (e.g. via --env-file=r2.env)",
    );
  }

  const endpoint =
    Bun.env.R2_ENDPOINT ??
    "https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com";
  Bun.dns.prefetch(new URL(endpoint).hostname, 443);

  const config = createRedactedR2Config({
    bucket: Bun.env.R2_BUCKET ?? "sportsdesk-ops-reports",
    endpoint,
    region: Bun.env.R2_REGION ?? "enam",
    accessKeyId,
    secretAccessKey,
  });

  const rawClient = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
  });

  const client = sealS3ClientInspection(rawClient, config);

  return { client, config };
}

export interface RuntimePreflightReport {
  readonly bunVersion: string;
  readonly bindings: {
    readonly s3: string;
    readonly S3Client: string;
    readonly SQL: string;
    readonly sql: string;
    readonly secretsGet: string;
    readonly dnsGetCacheStats: string;
  };
  readonly tokenIsolation: "isolated";
  readonly awsFallbackEnvPresent: boolean;
  readonly dnsCache: DnsCacheTelemetry & { readonly errorRatioBps: number };
  /**
   * Bun's own S3Client inspector already prints `accessKeyId`/`secretAccessKey` as
   * `"[REDACTED]"`. This flag is the canary result, not a seal: preflight must not mutate the
   * shared `Bun.s3` singleton.
   */
  readonly globalS3InspectRedacted: boolean;
}

const PREFLIGHT_SECRET_ENV_NAMES = [
  "F402_AUTH_JWT",
  "F402_BEARER_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "DATABASE_URL",
] as const;

function activePreflightSecrets(): string[] {
  return PREFLIGHT_SECRET_ENV_NAMES.map((name) => Bun.env[name] ?? "").filter(
    (value) => value !== "",
  );
}

/**
 * Startup guard: verify the native bindings the pipeline needs, enforce Cloudflare token
 * isolation, audit DNS cache errors, and run a redaction canary. No network I/O.
 */
export function runRuntimePreflightAudit(options?: {
  readonly maxDnsErrorRatioBps?: number;
  readonly dnsTelemetry?: DnsCacheTelemetry;
}): RuntimePreflightReport {
  const bindings = {
    s3: typeof Bun.s3,
    S3Client: typeof Bun.S3Client,
    SQL: typeof Bun.SQL,
    sql: typeof Bun.sql,
    secretsGet: typeof Bun.secrets?.get,
    dnsGetCacheStats: typeof Bun.dns?.getCacheStats,
  } as const;

  if (
    bindings.S3Client !== "function" ||
    bindings.secretsGet !== "function" ||
    bindings.dnsGetCacheStats !== "function"
  ) {
    throw new Error(
      `ERR_BUN_RUNTIME_SURFACE: required native bindings missing (${JSON.stringify(bindings)})`,
    );
  }

  assertCloudflareTokenIsolation();

  const telemetry = options?.dnsTelemetry ?? getDnsTelemetry();
  const errorRatioBps =
    telemetry.totalCount > 0
      ? Math.round((telemetry.errors / telemetry.totalCount) * 10_000)
      : 0;
  const maxBps = options?.maxDnsErrorRatioBps ?? 500;
  if (errorRatioBps > maxBps) {
    throw new Error(
      `ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE: DNS cache error ratio ${errorRatioBps} bps exceeds ${maxBps} bps`,
    );
  }

  const activeSecrets = activePreflightSecrets();

  const globalS3 =
    typeof Bun.s3 === "object" && Bun.s3 !== null ? Bun.s3 : null;
  if (globalS3 !== null) {
    // Bun's inspector redacts accessKeyId/secretAccessKey; check both its view and the
    // node:util view (the latter can opt into hidden properties).
    assertNoSecretLeak(
      Bun.inspect(globalS3, { depth: Infinity }),
      activeSecrets,
    );
    assertNoSecretLeak(
      nodeInspect(globalS3, { showHidden: true, depth: null }),
      activeSecrets,
    );
  }

  const report: RuntimePreflightReport = Object.freeze({
    bunVersion: Bun.version,
    bindings,
    tokenIsolation: "isolated",
    awsFallbackEnvPresent: Boolean(
      Bun.env.AWS_ACCESS_KEY_ID || Bun.env.S3_ACCESS_KEY_ID,
    ),
    dnsCache: Object.freeze({ ...telemetry, errorRatioBps }),
    globalS3InspectRedacted: true,
  });

  assertNoSecretLeak(JSON.stringify(report), activeSecrets);
  return report;
}

// --- 3. Ticket Verification Pipeline, Sanitized Artifact & CLI ---

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_VERIFY_OUT_PATH = resolve(
  REPO_ROOT,
  "scratch/gslive-tickets-verify.json",
);
const DEFAULT_DRY_RUN_CAPTURE_PATHS = [
  "data/live-wagers.json",
  "tests/fixtures/live-wagers.partial.json",
] as const;

export interface TicketPayloadTotals {
  readonly totalRows: number;
  readonly actionableTickets: number;
  readonly sentinelNoiseCount: number;
  readonly volumeMismatchCount: number;
  readonly totalWageredCents: number;
  readonly totalVolumeCents: number;
  readonly totalToWinCents: number;
}

function asFiniteCents(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function extractTicketRows(raw: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  }
  if (typeof raw !== "object" || raw === null) return [];
  const obj = raw as Record<string, unknown>;
  const list = obj.LIST ?? obj.wagers ?? obj.tickets;
  if (Array.isArray(list)) {
    return list.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  }
  if (typeof list === "object" && list !== null) {
    return [list as Record<string, unknown>];
  }
  return [];
}

/**
 * Summarize a raw Fantasy402/GSLive ticket payload into integer-cent totals without
 * copying customer identifiers, logins, or raw ticket text.
 */
export function summarizeTicketPayload(raw: unknown): TicketPayloadTotals {
  const rows = extractTicketRows(raw);
  let actionableTickets = 0;
  let sentinelNoiseCount = 0;
  let volumeMismatchCount = 0;
  let totalWageredCents = 0;
  let totalVolumeCents = 0;
  let totalToWinCents = 0;

  for (const row of rows) {
    const writer = String(row.TicketWriter ?? row.ticketWriter ?? "")
      .trim()
      .toUpperCase();
    if (writer === "ALERT" || writer === "BLOCKED") {
      sentinelNoiseCount += 1;
      continue;
    }
    actionableTickets += 1;
    const wageredCents = asFiniteCents(
      row.AmountWagered ?? row.amountWagered ?? row.wageredUsd ?? row.riskUsd,
    );
    const volumeCents = asFiniteCents(
      row.VolumeAmount ?? row.volumeAmount ?? row.volumeUsd,
    );
    const toWinCents = asFiniteCents(
      row.ToWinAmount ?? row.toWinAmount ?? row.toWinUsd,
    );
    if (volumeCents !== 0 && volumeCents !== wageredCents) {
      volumeMismatchCount += 1;
    }
    totalWageredCents += wageredCents;
    totalVolumeCents += volumeCents;
    totalToWinCents += toWinCents;
  }

  return {
    totalRows: rows.length,
    actionableTickets,
    sentinelNoiseCount,
    volumeMismatchCount,
    totalWageredCents,
    totalVolumeCents,
    totalToWinCents,
  };
}

export function resolveGsliveTicketVerifyOutPath(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const override = env.GSLIVE_TICKETS_VERIFY_PATH?.trim();
  return override ? resolve(REPO_ROOT, override) : DEFAULT_VERIFY_OUT_PATH;
}

export function readGsliveTicketVerifyArtifact(
  path: string = resolveGsliveTicketVerifyOutPath(),
): TicketVerificationSummary | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (parsed.schemaVersion !== 1 || typeof parsed.available !== "boolean") {
      return null;
    }
    return parsed as unknown as TicketVerificationSummary;
  } catch {
    return null;
  }
}

function writeAtomicJson(targetPath: string, payload: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  assertNoSecretLeak(serialized, activePreflightSecrets());
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, "utf8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure for non-existent tmp file
    }
    throw err;
  }
}

export interface RunGsliveTicketVerificationOptions {
  readonly dryRun?: boolean | undefined;
  readonly fromPath?: string | undefined;
  readonly outPath?: string | undefined;
  readonly publishR2?: boolean | undefined;
  readonly endpointPath?: string | undefined;
  readonly formFields?: Record<string, string> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly clientFactory?: (() => Promise<Fantasy402ApiClient>) | undefined;
  readonly r2Factory?:
    (() => { client: S3Client; config: R2ClientConfig }) | undefined;
}

function runSyntheticSealCanary(): {
  readonly canaryPassed: boolean;
  readonly clientSealed: boolean;
} {
  const synthJwt = "canary_synth_jwt_token_never_logged";
  const synthClient = new Fantasy402ApiClient({
    baseUrl: "https://canary.invalid",
    agentId: "CANARY_LEAF",
    agentOwner: "CANARY_OWNER",
    jwt: synthJwt,
  });
  assertRedactedCanary(synthClient, [synthJwt]);

  const synthAk = "CANARY_AKIA_KEY_0001";
  const synthSk = "CANARY_SECRET_KEY_0002";
  const synthCfg = createRedactedR2Config({
    bucket: "canary-bucket",
    endpoint: "https://canary.r2.invalid",
    region: "enam",
    accessKeyId: synthAk,
    secretAccessKey: synthSk,
  });
  const synthS3 = sealS3ClientInspection(
    new S3Client({
      accessKeyId: synthCfg.accessKeyId,
      secretAccessKey: synthCfg.secretAccessKey,
      bucket: synthCfg.bucket,
      endpoint: synthCfg.endpoint,
      region: synthCfg.region,
    }),
    synthCfg,
  );
  assertRedactedCanary(synthS3, [synthAk, synthSk]);
  return { canaryPassed: true, clientSealed: true };
}

export async function runGsliveTicketVerification(
  options: RunGsliveTicketVerificationOptions = {},
): Promise<TicketVerificationSummary> {
  const dryRun = options.dryRun ?? false;
  const nowDate = (options.now ?? (() => new Date()))();
  const verifiedAt = nowDate.toISOString();
  const outPath = options.outPath ?? resolveGsliveTicketVerifyOutPath();

  let canaryPassed = false;
  let clientSealed = false;
  try {
    runRuntimePreflightAudit();
    const canary = runSyntheticSealCanary();
    canaryPassed = canary.canaryPassed;
    clientSealed = canary.clientSealed;
  } catch (err) {
    const summary: TicketVerificationSummary = {
      schemaVersion: 1,
      available: false,
      mode: dryRun ? "dry-run" : "unmeasured",
      verifiedAt,
      sourcePath: options.fromPath ?? null,
      totalRows: 0,
      actionableTickets: 0,
      sentinelNoiseCount: 0,
      volumeMismatchCount: 0,
      totalWageredCents: 0,
      totalVolumeCents: 0,
      totalToWinCents: 0,
      canaryPassed,
      clientSealed,
      f402Status: "error",
      r2Status: "skipped",
      r2PublishedKey: null,
      error: err instanceof Error ? err.message : String(err),
      remediation: "bun run verify:gslive-tickets -- --dry-run",
    };
    writeAtomicJson(outPath, summary);
    return summary;
  }

  let mode: TicketVerificationMode = dryRun ? "dry-run" : "live";
  let sourcePath: string | null = null;
  let f402Status: TicketVerificationSummary["f402Status"] = "skipped";
  let r2Status: TicketVerificationSummary["r2Status"] = "skipped";
  let r2PublishedKey: string | null = null;
  let error: string | null = null;
  let remediation: string | null = null;
  let totals: TicketPayloadTotals = {
    totalRows: 0,
    actionableTickets: 0,
    sentinelNoiseCount: 0,
    volumeMismatchCount: 0,
    totalWageredCents: 0,
    totalVolumeCents: 0,
    totalToWinCents: 0,
  };

  if (options.fromPath) {
    const resolvedFrom = resolve(REPO_ROOT, options.fromPath);
    mode = dryRun ? "dry-run" : "fixture";
    sourcePath = options.fromPath;
    if (!existsSync(resolvedFrom)) {
      f402Status = "error";
      error = `Capture file not found: ${options.fromPath}`;
      remediation = "Pass an existing --from <path> capture file";
    } else {
      const parsed = JSON.parse(readFileSync(resolvedFrom, "utf8")) as unknown;
      totals = summarizeTicketPayload(parsed);
      f402Status = "ok";
    }
  } else if (dryRun) {
    const candidate = DEFAULT_DRY_RUN_CAPTURE_PATHS.find((rel) =>
      existsSync(resolve(REPO_ROOT, rel)),
    );
    if (candidate) {
      mode = "dry-run";
      sourcePath = candidate;
      const parsed = JSON.parse(
        readFileSync(resolve(REPO_ROOT, candidate), "utf8"),
      ) as unknown;
      totals = summarizeTicketPayload(parsed);
      f402Status = "ok";
    } else {
      mode = "unmeasured";
      f402Status = "skipped";
    }
  } else {
    try {
      const client = await (
        options.clientFactory ?? (() => Fantasy402ApiClient.fromEnvAndSecrets())
      )();
      const payload = await client.postForm<unknown>(
        options.endpointPath ?? "/cloud/api/Manager/getBetReport",
        options.formFields ?? { week: "0" },
      );
      totals = summarizeTicketPayload(payload);
      f402Status = "ok";
      sourcePath = options.endpointPath ?? "/cloud/api/Manager/getBetReport";
    } catch (err) {
      f402Status = "error";
      error = err instanceof Error ? err.message : String(err);
      remediation = "dx session login (or pass --dry-run / --from <fixture>)";
    }
  }

  if (options.publishR2 && !dryRun && f402Status === "ok") {
    try {
      const { client } = (options.r2Factory ?? createR2Client)();
      const deskDate = verifiedAt.slice(0, 10);
      const datedKey = `gslive-tickets/${deskDate}/verify.json`;
      const latestKey = "gslive-tickets/latest.json";
      const receipt = {
        schemaVersion: 1,
        mode,
        verifiedAt,
        ...totals,
        canaryPassed,
        clientSealed,
        datedKey,
      };
      const receiptJson = JSON.stringify(receipt, null, 2);
      assertNoSecretLeak(receiptJson, activePreflightSecrets());
      await client.file(datedKey).write(receiptJson, {
        type: "application/json",
      });
      await client
        .file(latestKey)
        .write(
          JSON.stringify({ schemaVersion: 1, rollupKey: datedKey, verifiedAt }),
          { type: "application/json" },
        );
      r2Status = "ok";
      r2PublishedKey = latestKey;
    } catch (err) {
      r2Status = "error";
      error = error ?? (err instanceof Error ? err.message : String(err));
      remediation =
        remediation ?? "Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY";
    }
  }

  const summary: TicketVerificationSummary = {
    schemaVersion: 1,
    available: f402Status === "ok" || (dryRun && canaryPassed),
    mode,
    verifiedAt,
    sourcePath,
    ...totals,
    canaryPassed,
    clientSealed,
    f402Status,
    r2Status,
    r2PublishedKey,
    error,
    remediation,
  };

  writeAtomicJson(outPath, summary);
  return summary;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      from: { type: "string" },
      out: { type: "string" },
      "publish-r2": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        "Usage: bun run scripts/verify-gslive-tickets.ts [options]",
        "  --dry-run      Run preflight + redaction canary against local capture/fixture (no network)",
        "  --from <path>  Summarize tickets from a local JSON file",
        "  --out <path>   Write sanitized receipt JSON (default: scratch/gslive-tickets-verify.json)",
        "  --publish-r2   Publish sanitized receipt to R2 via sealed S3Client",
        "  --json         Print JSON summary to stdout",
      ].join("\n"),
    );
    process.exit(0);
  }

  const summary = await runGsliveTicketVerification({
    dryRun: values["dry-run"],
    ...(values.from === undefined ? {} : { fromPath: values.from }),
    ...(values.out === undefined ? {} : { outPath: values.out }),
    publishR2: values["publish-r2"],
  });

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[verify-gslive-tickets] mode=${summary.mode} canary=${summary.canaryPassed ? "PASS" : "FAIL"} ` +
        `sealed=${summary.clientSealed} tickets=${summary.actionableTickets}/${summary.totalRows} ` +
        `noise=${summary.sentinelNoiseCount} f402=${summary.f402Status} r2=${summary.r2Status}`,
    );
  }

  if (
    !values["dry-run"] &&
    (summary.f402Status === "error" || summary.r2Status === "error")
  ) {
    process.exit(1);
  }
}

/**
 * Fail-closed startup wrapper: on any preflight failure, publish one 256-byte frame through the
 * injected lane flusher and exit with the class-specific code (75 transient, 77 terminal).
 *
 * `deps` exists so tests can observe the frame and intercept the exit; production callers omit it.
 */
export async function runPreflightOrExit(
  telemetrySab: SharedArrayBuffer,
  slot1Offset: number,
  flushLaneIpc: (frame: Uint8Array, r2Key: LaneR2Key) => Promise<void>,
  deps?: {
    readonly runPreflight?: () => Promise<RuntimePreflightReport>;
    readonly exit?: (code: number) => never;
  },
): Promise<RuntimePreflightReport> {
  try {
    return await (deps?.runPreflight ?? (() => runRuntimePreflightAudit()))();
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    let code: PreflightErrorCode = "ERR_INSP_SECRET_REDACTION_LEAK";
    let safeDetail =
      "Secret or token pattern detected during startup preflight";

    if (rawMsg.startsWith("ERR_CF_TOKEN_BLEED_10000")) {
      code = "ERR_CF_TOKEN_BLEED_10000";
      safeDetail =
        "Conflicting CLOUDFLARE_API_TOKEN and R2/AWS credentials in env";
    } else if (rawMsg.startsWith("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE")) {
      code = "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE";
      safeDetail = rawMsg.slice(0, 95); // numeric counters only; never echoes secrets
    }

    const encoded = encodePreflightErrorFrame256B(
      telemetrySab,
      slot1Offset,
      code,
      safeDetail,
    );

    try {
      await flushLaneIpc(encoded.frame, BUN_CI_GOVERNOR_R2_KEY);
    } catch (flushErr) {
      console.error(
        `[${BUN_CI_GOVERNOR_LANE}] ERR_TELEMETRY_FLUSH_FAILED: ${
          flushErr instanceof Error ? flushErr.message : String(flushErr)
        }`,
      );
    }

    console.error(
      `[${BUN_CI_GOVERNOR_LANE}] ${code} (u16=0x${encoded.errorCodeU16
        .toString(16)
        .padStart(4, "0")}, exit=${encoded.exitCode})`,
    );
    const exit =
      deps?.exit ?? ((exitCode: number): never => process.exit(exitCode));
    return exit(encoded.exitCode);
  }
}
