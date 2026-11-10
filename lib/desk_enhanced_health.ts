/**
 * Deep /health payload: version identity, auth probes, and R2 pipeline summaries.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { readF402Session, resolveF402SessionPath } from "./f402_session.ts";
import {
  GSLIVE_MANUAL_DUAL_AUTH_ACTION,
  gsliveConsecutiveMintFailures,
} from "./gslive_auto_session.ts";
import { readGsliveSessionMeta } from "./gslive_session_meta.ts";
import type { GsliveSessionHealth } from "./gslive_session_health.ts";
import {
  probeR2PipelineKpis,
  type R2PipelineKpis,
  type R2PipelineSinkKpi,
} from "./r2_pipeline_kpis.ts";

export type DeskOperationalStatus = "ok" | "degraded" | "down";

export type DeskDataStatus = "ok" | "stale";

export type DegradedReasonKind = "auth" | "publish" | "data";

export type DegradedReasonSeverity = "warn" | "error";

export interface DegradedReason {
  readonly message: string;
  readonly kind: DegradedReasonKind;
  readonly action?: string;
  readonly severity: DegradedReasonSeverity;
}

export type F402AuthStatus = "ok" | "missing" | "expired";

export interface F402AuthProbe {
  readonly status: F402AuthStatus;
  readonly source: "session-file" | "bearer" | "token-file" | "none";
  readonly expiresInSeconds: number | null;
  /** Keychain (or env) has credentials for a live WebView mint. */
  readonly mintCapable: boolean;
  /** Operator-facing hint when {@link status} is not ok; null when healthy. */
  readonly remediation: string | null;
}

export interface GsliveAuthProbe {
  readonly status: "ok" | "missing" | "expired" | "degraded" | "unconfigured";
  readonly source: string;
  readonly probeStatus: number | null;
  readonly mintCapable: boolean;
  /** Why automated mint is unavailable (GSLive only). */
  readonly automintBlocked: "cloudflare" | null;
  readonly remediation: string | null;
  /** From last verified credential sign-in metadata file (not the live probe). */
  readonly user: string | null;
  readonly partner: string | number | null;
}

export interface DeskPipelineChecks {
  readonly ticker: string;
  readonly gslive: string;
  readonly weblog: string;
  readonly wagers: string;
}

export interface DeskPipelinesSummary {
  readonly r2Fresh: number;
  readonly r2Total: number;
  readonly r2StaleKeys: readonly string[];
  readonly dataStaleKeys: readonly string[];
  readonly checks: DeskPipelineChecks;
}

export interface DeskVersionIdentity {
  readonly gitSha: string | null;
  readonly buildTime: string | null;
  readonly nodeEnv: string;
}

export interface DeskEnhancedHealthInput {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly runtime: string;
  readonly ingress: unknown;
  readonly nodeEnv: string;
  readonly uptimeSeconds: number;
  readonly now?: Date;
  readonly resolveGitSha?: () => string | null;
  readonly readF402?: typeof readF402Session;
  readonly readGsliveHealth?: () => Promise<GsliveSessionHealth>;
  readonly probeR2?: typeof probeR2PipelineKpis;
  /** @deprecated GSLive never auto-mints from Bun; kept for test injection only. */
  readonly hasGsliveMintCredentials?: () => Promise<boolean>;
  readonly hasF402MintCredentials?: () => Promise<boolean>;
  /** Override mint-failure streak (tests); defaults to {@link gsliveConsecutiveMintFailures}. */
  readonly gsliveMintFailureStreak?: () => number;
}

export interface DeskEnhancedHealthPayload {
  /** Legacy clients expect `healthy` when the process is up and checks pass. */
  readonly status: "healthy" | "degraded" | "down";
  readonly operationalStatus: DeskOperationalStatus;
  /** Covered data window age only; does not affect {@link operationalStatus}. */
  readonly dataStatus: DeskDataStatus;
  readonly httpStatus: number;
  readonly timestamp: string;
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly uptimeSeconds: number;
  readonly runtime: string;
  readonly ingress: unknown;
  readonly nodeEnv: string;
  readonly version: DeskVersionIdentity;
  readonly checks: {
    readonly daemon: "ok";
    readonly auth: {
      readonly f402: F402AuthProbe;
      readonly gslive: GsliveAuthProbe;
    };
    readonly pipelines: DeskPipelinesSummary;
  };
  readonly sources: {
    readonly auth: {
      readonly f402: F402AuthProbe;
      readonly gslive: GsliveAuthProbe;
    };
  };
  readonly degradedReasons: readonly DegradedReason[];
}

const R2_PUBLISH_ACTION: Readonly<Record<string, string>> = {
  "f402-bet-ticker": "bun run scripts/f402_bet_ticker_bridge3a.ts --once",
  "gslive-tally": "bun run bridge3c:rollup --fetch-open",
  "f402-weblog": "bun run scripts/f402_weblog_bridge.ts",
  "wagers-by-state": "bun run wagers:publish-snapshot",
};

function pushDegradedReason(
  out: DegradedReason[],
  message: string,
  kind: DegradedReasonKind,
  options?: {
    readonly action?: string;
    readonly severity?: DegradedReasonSeverity;
  },
): void {
  out.push({
    message,
    kind,
    severity: options?.severity ?? "warn",
    ...(options?.action === undefined ? {} : { action: options.action }),
  });
}

const SINK_SHORT: Readonly<Record<string, keyof DeskPipelineChecks>> = {
  "f402-bet-ticker": "ticker",
  "gslive-tally": "gslive",
  "f402-weblog": "weblog",
  "wagers-by-state": "wagers",
};

let cachedGitSha: string | null | undefined;

function defaultGitSha(): string | null {
  if (cachedGitSha !== undefined) return cachedGitSha;
  const fromEnv =
    (Bun.env.GIT_SHA ?? Bun.env.SPORTSDESK_GIT_SHA ?? "").trim() || null;
  if (fromEnv !== null) {
    cachedGitSha = fromEnv;
    return fromEnv;
  }
  try {
    const root = resolve(import.meta.dirname, "..");
    const proc = Bun.spawnSync(
      ["git", "-C", root, "rev-parse", "--short", "HEAD"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (proc.exitCode === 0) {
      const sha = new TextDecoder().decode(proc.stdout).trim();
      cachedGitSha = sha === "" ? null : sha;
      return cachedGitSha;
    }
  } catch {
    /* non-git checkout */
  }
  cachedGitSha = null;
  return null;
}

function defaultBuildTime(): string | null {
  const explicit = (
    Bun.env.BUILD_TIME ??
    Bun.env.SPORTSDESK_BUILD_TIME ??
    ""
  ).trim();
  if (explicit !== "") return explicit;
  try {
    const self = Bun.file(import.meta.path);
    return new Date(self.lastModified).toISOString();
  } catch {
    return null;
  }
}

type F402AuthCore = Omit<F402AuthProbe, "mintCapable" | "remediation">;

function probeF402Auth(
  nowMs: number,
  readSession: typeof readF402Session,
): F402AuthCore {
  const bearer = (Bun.env.F402_BEARER_TOKEN ?? "").trim();
  if (bearer !== "") {
    return { status: "ok", source: "bearer", expiresInSeconds: null };
  }
  const tokenPath = (Bun.env.F402_TOKEN_FILE ?? "").trim();
  if (tokenPath !== "" && existsSync(tokenPath)) {
    try {
      if (statSync(tokenPath).size > 0) {
        return { status: "ok", source: "token-file", expiresInSeconds: null };
      }
    } catch {
      /* fall through */
    }
  }
  const session = readSession({ now: nowMs });
  if (session !== null) {
    const expiresAt = Date.parse(session.expiresAtIso);
    const expiresInSeconds = Number.isFinite(expiresAt)
      ? Math.max(0, Math.floor((expiresAt - nowMs) / 1000))
      : null;
    return { status: "ok", source: "session-file", expiresInSeconds };
  }
  const path = resolveF402SessionPath();
  if (existsSync(path)) {
    return { status: "expired", source: "session-file", expiresInSeconds: 0 };
  }
  return { status: "missing", source: "none", expiresInSeconds: null };
}

type GsliveAuthCore = Omit<
  GsliveAuthProbe,
  "mintCapable" | "automintBlocked" | "remediation" | "user" | "partner"
>;

function gsliveAuthFromHealth(health: GsliveSessionHealth): GsliveAuthCore {
  const source = health.session.source;
  if (!health.session.configured) {
    return {
      status: "unconfigured",
      source,
      probeStatus: health.probe.httpStatus,
    };
  }
  const probe = health.probe.status;
  if (probe === "ok") {
    return {
      status: "ok",
      source,
      probeStatus: health.probe.httpStatus,
    };
  }
  if (probe === "unconfigured") {
    return {
      status: "unconfigured",
      source,
      probeStatus: health.probe.httpStatus,
    };
  }
  if (probe === "expired") {
    return { status: "expired", source, probeStatus: health.probe.httpStatus };
  }
  return { status: "degraded", source, probeStatus: health.probe.httpStatus };
}

function sinkCheckLabel(sink: R2PipelineSinkKpi | undefined): string {
  if (sink === undefined) return "missing";
  const publishStale = sink.stale;
  const dataStale = sink.dataStale;
  if (publishStale && dataStale) return "stale-publish-and-data";
  if (publishStale) return "stale-publish";
  if (dataStale) return "stale-data";
  return "ok";
}

function summarizePipelines(kpis: R2PipelineKpis): DeskPipelinesSummary {
  const r2StaleKeys: string[] = [];
  const dataStaleKeys: string[] = [];
  const checksMutable: Record<keyof DeskPipelineChecks, string> = {
    ticker: "missing",
    gslive: "missing",
    weblog: "missing",
    wagers: "missing",
  };
  let r2Fresh = 0;
  let r2Total = 0;
  for (const [id, sink] of Object.entries(kpis)) {
    r2Total += 1;
    if (!sink.stale) r2Fresh += 1;
    if (sink.stale) r2StaleKeys.push(id);
    if (sink.dataStale) dataStaleKeys.push(id);
    const short = SINK_SHORT[id];
    if (short !== undefined) checksMutable[short] = sinkCheckLabel(sink);
  }
  const checks: DeskPipelineChecks = checksMutable;
  return {
    r2Fresh,
    r2Total,
    r2StaleKeys,
    dataStaleKeys,
    checks,
  };
}

function legacyStatus(
  operational: DeskOperationalStatus,
): DeskEnhancedHealthPayload["status"] {
  if (operational === "ok") return "healthy";
  if (operational === "down") return "down";
  return "degraded";
}

function httpStatusFor(operational: DeskOperationalStatus): number {
  return operational === "down" ? 503 : 200;
}

const SECRETS_SERVICE = "com.bookdeskops.sportsdesk";

async function secretPresent(name: string): Promise<boolean> {
  try {
    const value = await Bun.secrets.get({ service: SECRETS_SERVICE, name });
    return typeof value === "string" && value.trim() !== "";
  } catch {
    return false;
  }
}

const F402_MINT_CACHE_TTL_MS = 30_000;
let cachedF402MintState: {
  readonly envKey: string;
  readonly checkedAtMs: number;
  readonly value: boolean;
} | null = null;
let inflightF402Mint: Promise<boolean> | null = null;

const R2_DEFAULT_CACHE_TTL_MS = 5_000;
let cachedDefaultR2Kpis: {
  readonly checkedAtMs: number;
  readonly kpis: R2PipelineKpis;
} | null = null;
let inflightDefaultR2Kpis: Promise<R2PipelineKpis> | null = null;

export function resetDeskHealthProbeCaches(): void {
  cachedF402MintState = null;
  inflightF402Mint = null;
  cachedDefaultR2Kpis = null;
  inflightDefaultR2Kpis = null;
}

async function defaultHasF402MintCredentials(): Promise<boolean> {
  const envAgent = (Bun.env.F402_AGENT_ID ?? "").trim() !== "";
  const envPass = (Bun.env.F402_PASSWORD ?? "").trim() !== "";
  if (envAgent && envPass) return true;

  const envKey = `${envAgent ? "1" : "0"}:${envPass ? "1" : "0"}`;
  const nowMs = Date.now();
  if (
    cachedF402MintState !== null &&
    cachedF402MintState.envKey === envKey &&
    nowMs - cachedF402MintState.checkedAtMs < F402_MINT_CACHE_TTL_MS
  ) {
    return cachedF402MintState.value;
  }
  if (inflightF402Mint !== null) return inflightF402Mint;

  inflightF402Mint = (async () => {
    const [agentOk, passOk] = await Promise.all([
      envAgent ? Promise.resolve(true) : secretPresent("F402_AGENT_ID"),
      envPass ? Promise.resolve(true) : secretPresent("F402_PASSWORD"),
    ]);
    const value = agentOk && passOk;
    cachedF402MintState = { envKey, checkedAtMs: Date.now(), value };
    return value;
  })().finally(() => {
    inflightF402Mint = null;
  });
  return inflightF402Mint;
}

async function readDefaultR2PipelineKpis(now: Date): Promise<R2PipelineKpis> {
  const realNowMs = Date.now();
  if (
    cachedDefaultR2Kpis !== null &&
    realNowMs - cachedDefaultR2Kpis.checkedAtMs < R2_DEFAULT_CACHE_TTL_MS
  ) {
    return cachedDefaultR2Kpis.kpis;
  }
  if (inflightDefaultR2Kpis !== null) return inflightDefaultR2Kpis;

  inflightDefaultR2Kpis = probeR2PipelineKpis(now)
    .then((kpis) => {
      cachedDefaultR2Kpis = { checkedAtMs: Date.now(), kpis };
      return kpis;
    })
    .finally(() => {
      inflightDefaultR2Kpis = null;
    });
  return inflightDefaultR2Kpis;
}

function f402Remediation(
  status: F402AuthStatus,
  mintCapable: boolean,
): string | null {
  if (status === "ok") return null;
  if (status === "expired" || status === "missing") {
    return mintCapable
      ? "Auto-mint queued"
      : "Manual F402_LIVE_LOGIN=1 required";
  }
  return null;
}

function gsliveRemediation(
  status: GsliveAuthCore["status"],
  mintLoop: boolean,
): string | null {
  if (mintLoop) {
    return `${GSLIVE_MANUAL_DUAL_AUTH_ACTION} (stop automated mint retries)`;
  }
  if (status === "ok") return null;
  return GSLIVE_MANUAL_DUAL_AUTH_ACTION;
}

function withF402MintFields(
  core: F402AuthCore,
  mintCapable: boolean,
): F402AuthProbe {
  return {
    ...core,
    mintCapable,
    remediation: f402Remediation(core.status, mintCapable),
  };
}

function gsliveIdentityFromMeta(): Pick<GsliveAuthProbe, "user" | "partner"> {
  const meta = readGsliveSessionMeta();
  if (meta === null) {
    return { user: null, partner: null };
  }
  const user =
    typeof meta.adminUserName === "string" && meta.adminUserName.trim() !== ""
      ? meta.adminUserName.trim()
      : null;
  const partner =
    meta.partner === undefined || meta.partner === null ? null : meta.partner;
  return { user, partner };
}

function withGsliveMintFields(
  core: GsliveAuthCore,
  mintLoop: boolean,
): GsliveAuthProbe {
  return {
    ...core,
    ...gsliveIdentityFromMeta(),
    mintCapable: false,
    automintBlocked: core.status === "ok" ? null : "cloudflare",
    remediation: gsliveRemediation(core.status, mintLoop),
  };
}

export async function buildDeskEnhancedHealth(
  input: DeskEnhancedHealthInput,
): Promise<DeskEnhancedHealthPayload> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const readSession = input.readF402 ?? readF402Session;
  const probeR2 = input.probeR2 ?? probeR2PipelineKpis;
  const resolveGitSha = input.resolveGitSha ?? defaultGitSha;

  const f402Core = probeF402Auth(nowMs, readSession);
  const [gsliveHealth, hasF402Mint, kpis] = await Promise.all([
    input.readGsliveHealth === undefined
      ? Promise.resolve(null)
      : input.readGsliveHealth().catch(() => null),
    input.hasF402MintCredentials === undefined
      ? defaultHasF402MintCredentials()
      : input.hasF402MintCredentials(),
    (input.probeR2 !== undefined
      ? probeR2(now)
      : readDefaultR2PipelineKpis(now)
    ).catch(() => ({}) as R2PipelineKpis),
  ]);
  const gsliveCore: GsliveAuthCore =
    gsliveHealth === null
      ? {
          status: "unconfigured",
          source: "none",
          probeStatus: null,
        }
      : gsliveAuthFromHealth(gsliveHealth);

  const mintLoop =
    (input.gsliveMintFailureStreak ?? gsliveConsecutiveMintFailures)() >= 3;
  const f402 = withF402MintFields(f402Core, hasF402Mint);
  const gslive = withGsliveMintFields(gsliveCore, mintLoop);

  const pipelines = summarizePipelines(kpis);

  const degradedReasons: DegradedReason[] = [];

  const authFailed =
    f402.status !== "ok" ||
    gslive.status === "unconfigured" ||
    gslive.status === "missing" ||
    gslive.status === "expired" ||
    gslive.status === "degraded";

  if (f402.status === "missing" || f402.status === "expired") {
    pushDegradedReason(
      degradedReasons,
      f402.status === "expired"
        ? "F402 session expired"
        : "F402 credentials missing",
      "auth",
      {
        action:
          f402.remediation ??
          "F402_LIVE_LOGIN=1 bun run session:login --from-keychain",
      },
    );
  }
  if (mintLoop) {
    pushDegradedReason(
      degradedReasons,
      "GSLive automated mint failed repeatedly (Cloudflare blocks auto-mint)",
      "auth",
      {
        action: gslive.remediation ?? GSLIVE_MANUAL_DUAL_AUTH_ACTION,
        severity: "error",
      },
    );
  }
  if (gslive.status === "unconfigured" || gslive.status === "missing") {
    pushDegradedReason(
      degradedReasons,
      "GSLive session missing (provision GSID manually)",
      "auth",
      { action: gslive.remediation ?? GSLIVE_MANUAL_DUAL_AUTH_ACTION },
    );
  } else if (gslive.status === "expired") {
    pushDegradedReason(
      degradedReasons,
      "GSLive session expired (Cloudflare blocks auto-mint)",
      "auth",
      { action: gslive.remediation ?? GSLIVE_MANUAL_DUAL_AUTH_ACTION },
    );
  } else if (gslive.status === "degraded") {
    pushDegradedReason(
      degradedReasons,
      `GSLive session probe: ${gsliveHealth?.probe.status ?? "degraded"} (Cloudflare blocks auto-mint)`,
      "auth",
      { action: gslive.remediation ?? GSLIVE_MANUAL_DUAL_AUTH_ACTION },
    );
  }

  for (const key of pipelines.r2StaleKeys) {
    const action = R2_PUBLISH_ACTION[key];
    pushDegradedReason(
      degradedReasons,
      `R2 sink '${key}' publish is stale`,
      "publish",
      action === undefined ? {} : { action },
    );
  }
  for (const key of pipelines.dataStaleKeys) {
    const action = R2_PUBLISH_ACTION[key];
    pushDegradedReason(
      degradedReasons,
      `R2 sink '${key}' has stale data (>24h)`,
      "data",
      action === undefined ? {} : { action },
    );
  }

  const publishFailed = pipelines.r2StaleKeys.length > 0;
  const dataStatus: DeskDataStatus =
    pipelines.dataStaleKeys.length > 0 ? "stale" : "ok";

  let operational: DeskOperationalStatus = "ok";
  if (f402.status !== "ok" && gslive.status !== "ok") {
    operational = "down";
  } else if (authFailed || publishFailed) {
    operational = "degraded";
  }

  const finalReasons: DegradedReason[] =
    operational === "down"
      ? degradedReasons.map((reason) =>
          reason.kind === "auth" ? { ...reason, severity: "error" } : reason,
        )
      : degradedReasons;

  return {
    status: legacyStatus(operational),
    operationalStatus: operational,
    dataStatus,
    httpStatus: httpStatusFor(operational),
    timestamp: now.toISOString(),
    port: input.port,
    hostname: input.hostname,
    url: input.url,
    uptimeSeconds: input.uptimeSeconds,
    runtime: input.runtime,
    ingress: input.ingress,
    nodeEnv: input.nodeEnv,
    version: {
      gitSha: resolveGitSha(),
      buildTime: defaultBuildTime(),
      nodeEnv: input.nodeEnv,
    },
    checks: {
      daemon: "ok",
      auth: { f402, gslive },
      pipelines,
    },
    sources: {
      auth: { f402, gslive },
    },
    degradedReasons: finalReasons,
  };
}
