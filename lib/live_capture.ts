/**
 * @file live_capture.ts
 * @description One capture plan for every read-only live Fantasy402 operation, plus the run
 * health the plugin reads.
 *
 * Why this exists: live capture used to be a set of per-source scripts (`capture:pending`,
 * `capture:bet-ticker`, the probe framework), each with its own auth path, its own output and no
 * shared record of what ran. This module turns the probe catalog (`PROBE_OPS`) into a single
 * plan, so every read-only operation is captured the same way, a failed or empty response can
 * never overwrite a good artifact, and one PII-free health snapshot records what was measured.
 *
 * Two operations rebuild a desk artifact from their body:
 *   Pending        -> data/live-bets.json   (lib/live_bets.buildArtifact)
 *   getBetTicker   -> data/live-wagers.json (lib/live_wagers.betTickerFile)
 * Every other operation writes its raw body to the (gitignored) capture directory only.
 *
 * Request bodies come from `buildProbeBody` / `buildJsonProbeBody`, which encode the field list
 * observed in the portal's own client JS. Nothing here invents a parameter.
 */

import {
  buildJsonProbeBody,
  buildProbeBody,
  PROBE_OPS,
  PROBE_PREFIXES,
  probeUrl,
  type ProbeBodyOptions,
  type ProbeOp,
} from "./f402_probe.ts";
import { buildArtifact, readPendingRows } from "./live_bets.ts";
import { betTickerFile } from "./live_wagers.ts";
import { extractContests } from "./contests.ts";
import { readBoardFile } from "./game_admin_board.ts";
import { readAnalysisReport } from "./analysis_report.ts";
import { readScoreboardFile } from "./scoreboard.ts";

export type LiveBuilder = "live-bets" | "live-wagers" | "raw";

/** One live source in the capture plan. */
export interface LiveCaptureSource {
  readonly operation: string;
  readonly builder: LiveBuilder;
  /** Artifact this source rebuilds, or null when the raw body is the output. */
  readonly artifact: string | null;
  /** Age after which the artifact is reported stale, in minutes. */
  readonly freshnessMinutes: number;
  readonly needsCustomer: boolean;
  readonly note: string;
}

/** Operations with a desk artifact builder, and the artifact each one owns. */
const ARTIFACT_BY_OPERATION: ReadonlyMap<
  string,
  { readonly builder: LiveBuilder; readonly artifact: string }
> = new Map([
  ["Pending", { builder: "live-bets", artifact: "data/live-bets.json" }],
  [
    "getBetTicker",
    { builder: "live-wagers", artifact: "data/live-wagers.json" },
  ],
]);

const FRESHNESS_BY_OPERATION: ReadonlyMap<string, number> = new Map([
  ["Pending", 120],
  ["getBetTicker", 120],
]);

/**
 * `getBetTicker` is not in `PROBE_OPS` (the probe suite captures it through its own script), but
 * it feeds `data/live-wagers.json`, so it belongs in the plan. Its wire fields are the ones
 * `scripts/capture/capture_bet_ticker.ts` sends: `wagerNumber=0` returns the whole current list.
 */
const BET_TICKER_OP: ProbeOp = {
  operation: "getBetTicker",
  method: "POST",
  readOnly: true,
  note: "ticker list read; wagerNumber=0 returns the whole list (capture_bet_ticker.ts)",
  params: ["agentID", "agentOwner", "wagerNumber", "operation", "RRO"],
  defaultPrefix: "/cloud/api/Manager",
};

/** The probe catalog plus the artifact sources it does not carry. */
const LIVE_OPS: readonly ProbeOp[] = [...PROBE_OPS, BET_TICKER_OP];

const DEFAULT_FRESHNESS_MINUTES = 360;

function sourceFor(op: ProbeOp): LiveCaptureSource {
  const artifact = ARTIFACT_BY_OPERATION.get(op.operation);
  return {
    operation: op.operation,
    builder: artifact?.builder ?? "raw",
    artifact: artifact?.artifact ?? null,
    freshnessMinutes:
      FRESHNESS_BY_OPERATION.get(op.operation) ?? DEFAULT_FRESHNESS_MINUTES,
    needsCustomer: op.params.includes("customerID"),
    note: op.note,
  };
}

/**
 * The capture plan: every read-only operation, destinations (operations with a builder) first so
 * a partial run still refreshes the artifacts. `only` narrows it by operation name; `includeRaw`
 * false keeps just the artifact sources.
 */
export function liveCapturePlan(
  options: {
    readonly only?: readonly string[];
    readonly includeRaw?: boolean;
  } = {},
): readonly LiveCaptureSource[] {
  const wanted = options.only === undefined ? null : new Set(options.only);
  const includeRaw = options.includeRaw ?? true;
  return LIVE_OPS.filter((op) => op.readOnly)
    .filter((op) => wanted === null || wanted.has(op.operation))
    .map(sourceFor)
    .filter((source) => includeRaw || source.builder !== "raw")
    .sort(
      (left, right) =>
        Number(right.builder !== "raw") - Number(left.builder !== "raw"),
    );
}

export function probeOpFor(operation: string): ProbeOp | null {
  return LIVE_OPS.find((op) => op.operation === operation) ?? null;
}

/** `/cloud/api/Report/Pending`: the operation path the artifacts record. */
export function liveOperationPath(op: ProbeOp): string {
  const prefix = op.defaultPrefix ?? PROBE_PREFIXES[0];
  return `${prefix.replace(/\/$/, "")}/${op.operation}`;
}

export interface BuiltCaptureRequest {
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
}

/** URL and wire body for one operation, from the probe catalog's observed fields. */
export function buildCaptureRequest(
  op: ProbeOp,
  options: {
    readonly base: string;
    readonly agentId: string;
    readonly customerId: string;
    readonly bodyOptions?: ProbeBodyOptions;
  },
): BuiltCaptureRequest {
  const json = op.wireContentType === "application/json";
  return {
    url: probeUrl(options.base, op, op.defaultPrefix ?? PROBE_PREFIXES[0]),
    contentType: json
      ? "application/json"
      : "application/x-www-form-urlencoded; charset=UTF-8",
    body: json
      ? buildJsonProbeBody(
          op,
          options.agentId,
          options.customerId,
          options.bodyOptions,
        )
      : buildProbeBody(
          op,
          options.agentId,
          options.customerId,
          options.bodyOptions,
        ),
  };
}

/** Row count when the body parses, else null. A zero means "parsed and empty". */
export function measuredRows(
  source: LiveCaptureSource,
  bodyText: string,
): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (source.builder === "live-bets") return readPendingRows(payload).length;
  if (source.builder === "live-wagers") {
    const list =
      typeof payload === "object" && payload !== null
        ? (payload as { LIST?: unknown }).LIST
        : undefined;
    return Array.isArray(list) ? list.length : null;
  }
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === "object" && payload !== null) {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) return value.length;
    }
    return 1;
  }
  return null;
}

/**
 * Usability rules. A body that parses but carries no rows for an artifact source is NOT usable:
 * it must never replace a good artifact. Raw sources only require a parseable JSON body, so a
 * login page or an error envelope is rejected before it lands in the capture directory.
 */
export function isUsableCapture(
  source: LiveCaptureSource,
  bodyText: string,
): boolean {
  const rows = measuredRows(source, bodyText);
  if (rows === null) return false;
  // A raw capture is evidence: parseable JSON is enough. An artifact source must carry rows,
  // or an empty successful response would erase the last good artifact.
  return source.builder === "raw" ? true : rows > 0;
}

/** The artifact text a source rebuilds, or null for raw sources. */
export function artifactTextFor(
  source: LiveCaptureSource,
  bodyText: string,
  capturedAt: string,
): string | null {
  if (source.builder === "raw") return null;
  const payload: unknown = JSON.parse(bodyText);
  if (source.builder === "live-bets") {
    const op = probeOpFor(source.operation);
    if (op === null)
      throw new Error(`unknown probe operation ${source.operation}`);
    const artifact = buildArtifact(readPendingRows(payload), {
      operation: liveOperationPath(op),
      capturedAt,
    });
    return `${JSON.stringify(artifact, null, 2)}\n`;
  }
  return `${JSON.stringify(betTickerFile(payload, capturedAt), null, 2)}\n`;
}

export type CaptureOutcome = "captured" | "failed";

/** One source's run, recorded PII-free (no body, no customer id). */
export interface LiveCaptureRecord {
  readonly source: string;
  readonly operation: string;
  readonly artifact: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: CaptureOutcome;
  readonly transport: string;
  readonly httpStatus: number | null;
  readonly rows: number | null;
  readonly bytes: number | null;
  readonly bodySha256: string | null;
  readonly artifactWritten: boolean;
  readonly keptPreviousArtifact: boolean;
  readonly error: string | null;
  /** How the artifact was refreshed: from the API, or by installing an operator paste. */
  readonly provenanceClass?: "api" | "paste";
  /** Paste installs only: SHA-256 and mtime of the input the artifact was installed from. */
  readonly inputSha256?: string | null;
  readonly inputMtime?: string | null;
}

/** The snapshot `data/capture-health.json`; one record per source, latest run wins. */
export interface LiveCaptureHealth {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly transport: string;
  readonly sources: Readonly<Record<string, LiveCaptureRecord>>;
}

export const CAPTURE_HEALTH_PATH = "data/capture-health.json";

export type LiveArtifactCapturePath = "api" | "paste";
export type PasteInputKind = "json" | "html";

/**
 * The six live desk artifacts, and how each one can be refreshed. This is the classification the
 * stale-artifact report was missing: two artifacts have an API builder, the other four are
 * operator pastes (the portal renders them; no API contract proves them), so no API capture can
 * ever make them fresh. Their reproducer is a validated paste install, not a request.
 */
export interface LiveArtifactSpec {
  readonly name: string;
  readonly path: string;
  readonly freshnessMinutes: number;
  readonly capturePath: LiveArtifactCapturePath;
  readonly pasteInput: PasteInputKind | null;
  /** File name expected in the paste input directory. */
  readonly pasteFileName: string | null;
  /** Operation that rebuilds it, for API artifacts. */
  readonly operation: string | null;
  readonly role: string;
}

export const REPO_LIVE_ARTIFACTS: readonly LiveArtifactSpec[] = [
  {
    name: "live-bets",
    path: "data/live-bets.json",
    freshnessMinutes: 120,
    capturePath: "api",
    pasteInput: null,
    pasteFileName: null,
    operation: "Pending",
    role: "Pending report -> scoreboard feed.",
  },
  {
    name: "live-wagers",
    path: "data/live-wagers.json",
    freshnessMinutes: 120,
    capturePath: "api",
    pasteInput: null,
    pasteFileName: null,
    operation: "getBetTicker",
    role: "getBetTicker list -> bet ticker feed.",
  },
  {
    name: "scoreboard",
    path: "data/scoreboard.json",
    freshnessMinutes: 360,
    capturePath: "paste",
    pasteInput: "json",
    pasteFileName: "scoreboard.json",
    operation: null,
    role: "Manager-page scoreboard, transcribed by the operator.",
  },
  {
    name: "game-admin-board",
    path: "data/game-admin-board.json",
    freshnessMinutes: 720,
    capturePath: "paste",
    pasteInput: "json",
    pasteFileName: "game-admin-board.json",
    operation: null,
    role: "Game Admin module (lines and money per side), pasted by the operator.",
  },
  {
    name: "contests",
    path: "data/contests.json",
    freshnessMinutes: 1_440,
    capturePath: "paste",
    pasteInput: "html",
    pasteFileName: "contests.html",
    operation: null,
    role: "Contest (futures) list extracted from the sports-nav markup.",
  },
  {
    name: "analysis-cp-baseball",
    path: "data/analysis-cp-baseball-2026-11-01.json",
    freshnessMinutes: 1_440,
    capturePath: "paste",
    pasteInput: "json",
    pasteFileName: "analysis-cp-baseball.json",
    operation: null,
    role: "Stored Customer Performance (CP) result, recomputed before serving.",
  },
];

export function artifactSpecFor(name: string): LiveArtifactSpec | null {
  return REPO_LIVE_ARTIFACTS.find((spec) => spec.name === name) ?? null;
}

/** Sources a paste can refresh: exactly the artifacts with no API builder. */
export function pasteArtifactPlan(
  options: { readonly only?: readonly string[] } = {},
): readonly LiveArtifactSpec[] {
  const wanted = options.only === undefined ? null : new Set(options.only);
  return REPO_LIVE_ARTIFACTS.filter(
    (spec) => spec.capturePath === "paste",
  ).filter((spec) => wanted === null || wanted.has(spec.name));
}

export interface PasteValidation {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly records: number | null;
  readonly observedAt: string | null;
  readonly artifactText: string | null;
  readonly inputKind: PasteInputKind;
}

/**
 * Validate one paste against its artifact's reader before it can be installed. A paste must
 * state when it was observed: the current artifacts carry date-only `observedAt` values, and a
 * refresh that silently kept that ambiguity would make the freshness report a guess.
 */
export function validatePaste(
  spec: LiveArtifactSpec,
  inputText: string,
  inputMtimeIso: string,
): PasteValidation {
  const inputKind = spec.pasteInput ?? "json";
  const invalid = (reason: string): PasteValidation => ({
    ok: false,
    reason,
    records: null,
    observedAt: null,
    artifactText: null,
    inputKind,
  });
  if (spec.pasteInput === null)
    return invalid("this artifact has no paste path");
  if (inputText.trim() === "") return invalid("the paste input is empty");

  if (spec.pasteInput === "html") {
    const entries = extractContests(inputText);
    if (entries.length === 0)
      return invalid("no contest entries found in the markup");
    const file = {
      schemaVersion: 1 as const,
      source: `markup:${spec.pasteFileName ?? "paste"}`,
      extractedAt: inputMtimeIso,
      entries,
    };
    return {
      ok: true,
      reason: null,
      records: entries.length,
      observedAt: inputMtimeIso,
      artifactText: `${JSON.stringify(file, null, 2)}\n`,
      inputKind,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(inputText);
  } catch {
    return invalid("the paste is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null) {
    return invalid("the paste is not a JSON object");
  }
  const record = payload as Record<string, unknown>;
  let records: number | null = null;
  if (spec.name === "scoreboard") {
    const file = readScoreboardFile(payload);
    if (file === null) return invalid("did not validate as a scoreboard file");
    records = file.games.length;
  } else if (spec.name === "game-admin-board") {
    const file = readBoardFile(payload);
    if (file === null)
      return invalid("did not validate as a game-admin board file");
    records = file.games.length;
  } else if (spec.name === "analysis-cp-baseball") {
    const report = readAnalysisReport(payload);
    if (report === null)
      return invalid("did not validate as an analysis report");
    records = report.rows.length;
  } else {
    return invalid(`no paste reader for artifact ${spec.name}`);
  }
  const observedAt = record.observedAt;
  if (typeof observedAt !== "string" || observedAt.trim() === "") {
    return invalid("the paste does not state observedAt");
  }
  return {
    ok: true,
    reason: null,
    records,
    observedAt,
    artifactText: `${JSON.stringify(payload, null, 2)}\n`,
    inputKind,
  };
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, text);
  const moved = Bun.spawnSync(["mv", "-f", temporary, path]);
  if (moved.exitCode !== 0) {
    throw new Error(`could not replace ${path} atomically`);
  }
}

/** Read the health snapshot; null means "no capture has run", not "zero sources". */
export async function readCaptureHealth(
  path: string,
): Promise<LiveCaptureHealth | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  if (text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text) as LiveCaptureHealth;
    if (parsed?.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCaptureHealth(
  path: string,
  health: LiveCaptureHealth,
): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(health, null, 2)}\n`);
}

/** Merge this run's records over the previous snapshot. */
export function mergeCaptureHealth(
  previous: LiveCaptureHealth | null,
  records: readonly LiveCaptureRecord[],
  updatedAt: string,
  transport: string,
): LiveCaptureHealth {
  const sources: Record<string, LiveCaptureRecord> = {};
  if (previous !== null) {
    for (const [source, record] of Object.entries(previous.sources)) {
      sources[source] = record;
    }
  }
  for (const record of records) sources[record.source] = record;
  return { schemaVersion: 1, updatedAt, transport, sources };
}

export interface CaptureHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** Everything `runCapturePlan` needs from the outside world, so tests need no network. */
export interface CaptureDeps {
  readonly transport: string;
  readonly request: (
    source: LiveCaptureSource,
    op: ProbeOp,
  ) => Promise<CaptureHttpResponse>;
  readonly writeRaw?: (
    source: LiveCaptureSource,
    body: string,
    at: string,
  ) => Promise<void>;
  readonly writeArtifact?: (
    source: LiveCaptureSource,
    text: string,
  ) => Promise<void>;
  readonly artifactExists?: (source: LiveCaptureSource) => Promise<boolean>;
  readonly now?: () => Date;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Run the plan. Never throws for one source's failure: each failure is recorded with the reason
 * and the previous artifact is left alone. Returns one record per source, in plan order.
 */
export async function runCapturePlan(
  plan: readonly LiveCaptureSource[],
  deps: CaptureDeps,
): Promise<readonly LiveCaptureRecord[]> {
  const records: LiveCaptureRecord[] = [];
  for (const source of plan) {
    const clock = deps.now ?? (() => new Date());
    const startedAt = clock().toISOString();
    const op = probeOpFor(source.operation);
    let httpStatus: number | null = null;
    let bytes: number | null = null;
    let bodySha256: string | null = null;
    let rows: number | null = null;
    let record: LiveCaptureRecord;
    try {
      if (op === null)
        throw new Error(`unknown probe operation ${source.operation}`);
      const response = await deps.request(source, op);
      httpStatus = response.status;
      bytes = response.body.length;
      bodySha256 = sha256Hex(response.body);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      rows = measuredRows(source, response.body);
      if (!isUsableCapture(source, response.body)) {
        throw new Error(
          "empty or non-JSON payload (kept the previous artifact)",
        );
      }
      const finishedAt = clock().toISOString();
      let artifactWritten = false;
      if (source.builder !== "raw") {
        const text = artifactTextFor(source, response.body, finishedAt);
        if (!(text === null || deps.writeArtifact === undefined)) {
          await deps.writeArtifact(source, text);
          artifactWritten = true;
        }
      }
      if (deps.writeRaw !== undefined) {
        await deps.writeRaw(source, response.body, finishedAt);
      }
      record = {
        source: source.operation,
        operation: source.operation,
        artifact: source.artifact,
        startedAt,
        finishedAt,
        outcome: "captured",
        transport: deps.transport,
        httpStatus,
        rows,
        bytes,
        bodySha256,
        artifactWritten,
        keptPreviousArtifact: false,
        error: null,
        provenanceClass: "api",
      };
    } catch (error) {
      const keptPreviousArtifact =
        source.artifact !== null &&
        deps.artifactExists !== undefined &&
        (await deps.artifactExists(source));
      record = {
        source: source.operation,
        operation: source.operation,
        artifact: source.artifact,
        startedAt,
        finishedAt: clock().toISOString(),
        outcome: "failed",
        transport: deps.transport,
        httpStatus,
        rows,
        bytes,
        bodySha256,
        artifactWritten: false,
        keptPreviousArtifact,
        error: safeError(error),
        provenanceClass: "api",
      };
    }
    records.push(record);
  }
  return records;
}
