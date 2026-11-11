/**
 * Unified Bun Agent Diagnostics and Execution Layer.
 *
 * Centralizes agent runner configuration, automated failure triage,
 * and dev-tooling integration across native Bun primitives:
 * - Orphan prevention (`--no-orphans`, PR #29930)
 * - Deterministic environment isolation (`--no-env-file`, PR #24767)
 * - Native async stack trace preservation (PR #28652)
 * - Engine-native CPU Markdown profiling (`--cpu-prof-md`, PR #24112, #26327)
 * - Engine-native Heap Markdown profiling (`--heap-prof-md`, PR #26326)
 *
 * @see docs/bun-upstream-reference.md
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Feature, BuildTarget } from "../types/features.ts";
import { BUILD_FEATURES } from "../types/features.ts";

/** Options for configuring an agent runner execution with Bun diagnostics. */
export interface AgentDiagnosticsOptions {
  /** Identifier for the worker running the task. */
  readonly workerId?: string | undefined;
  /** Logical operation being performed. */
  readonly operationId?: string | undefined;
  /** End-to-end tracing correlation ID. */
  readonly correlationId?: string | undefined;
  /** Checkpoint / execution stage description. */
  readonly checkpoint?: string | undefined;
  /** Working directory for child process. */
  readonly cwd?: string | undefined;
  /** Extra environment variables passed to child. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Timeout in milliseconds (0 for unlimited). */
  readonly timeoutMs?: number | undefined;
  /** Enable `--no-orphans` child termination guarantee (default: true). */
  readonly noOrphans?: boolean | undefined;
  /** Enable `--no-env-file` automatic .env loading isolation (default: true). */
  readonly noEnvFile?: boolean | undefined;
  /** Enable `--cpu-prof-md` Markdown CPU profiling. */
  readonly cpuProfile?: boolean | undefined;
  /** Enable `--heap-prof-md` Markdown Heap profiling. */
  readonly heapProfile?: boolean | undefined;
  /** Directory to store profiling artifacts (default: "scratch/profiles"). */
  readonly profileDir?: string | undefined;
  /** Compile-time feature flags to forward. */
  readonly features?: readonly Feature[] | undefined;
  /** Build target to forward. */
  readonly target?: BuildTarget | undefined;
}

/** Structured audit of a bet ticker bridge fixture replay or poll. */
export interface BridgeReplayAudit {
  /** Whether the replay completed without abnormal termination. */
  readonly replayCompleted: boolean;
  /** Whether a valid delta projection event was generated. */
  readonly projectionGenerated: boolean;
  /** Whether a valid snapshot event was generated. */
  readonly snapshotGenerated: boolean;
  /** Whether WebSocket delivery was intentionally skipped. */
  readonly wsSkipped: boolean;
  /** Whether R2 snapshot writing was intentionally skipped. */
  readonly r2Skipped: boolean;
  /** Published status emitted by the bridge (e.g., "published", "baseline", "noop"). */
  readonly status?: string | undefined;
  /** Number of new tickets projected in this replay. */
  readonly newTickets?: number | undefined;
  /** Watermark identifier established by the bridge. */
  readonly watermark?: string | undefined;
}

/** Complete structured failure record for automated issue triage. */
export interface AgentFailureRecord {
  readonly timestamp: string;
  readonly workerId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly checkpoint: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly cpuProfileProduced: boolean;
  readonly heapProfileProduced: boolean;
  readonly error?: string | undefined;
  readonly asyncStackTrace?: string | undefined;
  readonly cpuHotspots?: string | undefined;
  readonly topRetainedTypes?: string | undefined;
  readonly bridgeAudit?: BridgeReplayAudit | undefined;
  readonly command: readonly string[];
}

/** Result of a successful agent runner execution. */
export interface AgentSuccessRecord {
  readonly workerId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly exitCode: 0;
  readonly signal: null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cpuProfilePath?: string | undefined;
  readonly heapProfilePath?: string | undefined;
  readonly cpuProfileProduced: boolean;
  readonly heapProfileProduced: boolean;
  readonly bridgeAudit?: BridgeReplayAudit | undefined;
}

/**
 * Builds the canonical argv command array for Bun agent workers, ensuring
 * process containment, environment isolation, and diagnostic flags precede script paths.
 */
export function buildAgentCommand(
  scriptPath: string,
  scriptArgs: readonly string[] = [],
  options: AgentDiagnosticsOptions = {},
): {
  readonly cmd: readonly string[];
  readonly cpuProfilePath?: string | undefined;
  readonly heapProfilePath?: string | undefined;
} {
  const flags: string[] = [];

  // 1. Process containment: kill descendants when parent dies (PR #29930)
  if (options.noOrphans ?? true) {
    flags.push("--no-orphans");
  }

  // 2. Deterministic environment: prevent accidental .env autoload (PR #24767)
  if (options.noEnvFile ?? true) {
    flags.push("--no-env-file");
  }

  // 3. Compile-time feature flags
  let resolvedFeatures: readonly Feature[] = [];
  if (options.target && Object.hasOwn(BUILD_FEATURES, options.target)) {
    resolvedFeatures = BUILD_FEATURES[options.target];
  } else if (options.features) {
    resolvedFeatures = options.features;
  }
  for (const feat of resolvedFeatures) {
    flags.push(`--feature=${feat}`);
  }

  const profileDir = options.profileDir ?? "scratch/profiles";
  const idPrefix = options.correlationId ?? `${Date.now()}`;
  let cpuProfilePath: string | undefined;
  let heapProfilePath: string | undefined;

  // 4. Native Markdown CPU Profiling (PR #24112, #26327)
  if (options.cpuProfile) {
    const cpuName = `agent_${idPrefix}.cpuprofile.md`;
    cpuProfilePath = join(profileDir, cpuName);
    flags.push(
      "--cpu-prof-md",
      "--cpu-prof-dir",
      profileDir,
      "--cpu-prof-name",
      cpuName,
    );
  }

  // 5. Native Markdown Heap Profiling (PR #26326)
  if (options.heapProfile) {
    const heapName = `agent_${idPrefix}.heapprofile.md`;
    heapProfilePath = join(profileDir, heapName);
    flags.push(
      "--heap-prof-md",
      "--heap-prof-dir",
      profileDir,
      "--heap-prof-name",
      heapName,
    );
  }

  const cmd = [process.execPath, ...flags, scriptPath, ...scriptArgs];
  return { cmd, cpuProfilePath, heapProfilePath };
}

/**
 * Redacts secrets, JWTs, credentials, and sensitive auth tokens from stack traces.
 */
export function redactStackTrace(raw: string): string {
  return raw
    .replace(
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
      "[REDACTED_JWT]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:password|token|secret|api_key|auth|session)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Cookie:\s*[^;\n]*=)[^\s;\n]+/gi, "$1[REDACTED]");
}

/**
 * Extracts the top hot functions summary from an engine-generated `--cpu-prof-md` file.
 */
export async function extractCpuHotspots(
  filePath?: string,
): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");
    const hotSectionIdx = lines.findIndex((l) =>
      l.includes("Hot Functions (Self Time)"),
    );
    if (hotSectionIdx === -1) return undefined;
    // Extract table header and top 5 rows
    const tableLines = lines
      .slice(hotSectionIdx + 2, hotSectionIdx + 8)
      .filter((l) => l.trim().length > 0);
    return tableLines.join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Extracts top retained memory types from an engine-generated `--heap-prof-md` file.
 */
export async function extractTopRetainedTypes(
  filePath?: string,
): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");
    const topTypesIdx = lines.findIndex((l) =>
      l.includes("Top 50 Types by Retained Size"),
    );
    if (topTypesIdx === -1) return undefined;
    // Extract table header and top 5 rows
    const tableLines = lines
      .slice(topTypesIdx + 2, topTypesIdx + 8)
      .filter((l) => l.trim().length > 0);
    return tableLines.join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Audits stdout and stderr from a Bet Ticker Bridge process to verify whether
 * the fixture replay completed, valid delta and snapshot artifacts were projected,
 * and delivery sinks (WS/R2) were appropriately engaged or bypassed.
 */
export function auditBridgeReplayOutput(
  stdout: string,
  stderr: string,
): BridgeReplayAudit | undefined {
  const combined = `${stdout}\n${stderr}`;
  const isBridge =
    combined.includes("[bridge3a]") || combined.includes("f402-bet-ticker");
  if (!isBridge) return undefined;

  let projectionGenerated = false;
  let snapshotGenerated = false;
  let status: string | undefined;
  let newTickets: number | undefined;
  let watermark: string | undefined;

  try {
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        status?: string;
        event?: {
          schemaVersion?: number;
          kind?: string;
          newTickets?: number;
          watermark?: string;
        };
        snapshot?: { schemaVersion?: number; kind?: string };
      };
      if (parsed.event && parsed.event.kind === "f402-bet-ticker") {
        projectionGenerated = true;
        newTickets = parsed.event.newTickets;
        watermark = parsed.event.watermark;
      }
      if (parsed.snapshot && parsed.snapshot.kind === "f402-bet-ticker") {
        snapshotGenerated = true;
      }
      if (typeof parsed.status === "string") {
        status = parsed.status;
      }
    }
  } catch {
    // Non-fatal parse failure
  }

  const wsSkipped =
    combined.includes("ws=skipped") || combined.includes("no-ws");
  const r2Skipped =
    combined.includes("r2=skipped") || combined.includes("no-r2");
  const replayCompleted =
    combined.includes("[bridge3a] published") ||
    (projectionGenerated && snapshotGenerated);

  return {
    replayCompleted,
    projectionGenerated,
    snapshotGenerated,
    wsSkipped,
    r2Skipped,
    status,
    newTickets,
    watermark,
  };
}

/** Options for pruning diagnostic profiling artifacts to prevent storage bloat. */
export interface DiagnosticRetentionOptions {
  readonly profileDir?: string | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxAgeMs?: number | undefined;
}

/** Result of a diagnostic artifact pruning sweep. */
export interface PruneResult {
  readonly examined: number;
  readonly pruned: number;
  readonly retained: number;
}

/**
 * Prunes generated CPU and heap profiling artifacts under `profileDir`
 * to enforce bounded disk usage in local workflows and CI runners.
 */
export async function pruneDiagnosticArtifacts(
  options: DiagnosticRetentionOptions = {},
): Promise<PruneResult> {
  const profileDir = options.profileDir ?? "scratch/profiles";
  const maxFiles = options.maxFiles ?? 20;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours

  if (!existsSync(profileDir)) {
    return { examined: 0, pruned: 0, retained: 0 };
  }

  try {
    const entries = readdirSync(profileDir, { withFileTypes: true });
    const profileFiles: { path: string; mtimeMs: number }[] = [];
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (
        name.endsWith(".cpuprofile.md") ||
        name.endsWith(".heapprofile.md") ||
        name.startsWith("CPU.") ||
        name.startsWith("Heap.")
      ) {
        const fullPath = join(profileDir, name);
        try {
          const st = statSync(fullPath);
          profileFiles.push({ path: fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // File may have been deleted concurrently
        }
      }
    }

    // Sort newest to oldest
    profileFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let pruned = 0;
    for (let i = 0; i < profileFiles.length; i++) {
      const item = profileFiles[i]!;
      const isOverCount = i >= maxFiles;
      const isOverAge = now - item.mtimeMs > maxAgeMs;

      if (isOverCount || isOverAge) {
        try {
          unlinkSync(item.path);
          pruned++;
        } catch {
          // Non-fatal
        }
      }
    }

    return {
      examined: profileFiles.length,
      pruned,
      retained: profileFiles.length - pruned,
    };
  } catch {
    return { examined: 0, pruned: 0, retained: 0 };
  }
}

/**
 * Renders an automated GitHub-ready issue report from an AgentFailureRecord.
 */
export function renderAgentFailureReport(record: AgentFailureRecord): string {
  const parts: string[] = [];

  parts.push("## Agent Failure Triage Report");
  parts.push("");
  parts.push("| Field | Value |");
  parts.push("| :--- | :--- |");
  parts.push(`| **Timestamp** | \`${record.timestamp}\` |`);
  parts.push(`| **Operation ID** | \`${record.operationId}\` |`);
  parts.push(`| **Worker ID** | \`${record.workerId}\` |`);
  parts.push(`| **Correlation ID** | \`${record.correlationId}\` |`);
  parts.push(`| **Checkpoint** | \`${record.checkpoint}\` |`);
  parts.push(
    `| **Exit Code** | \`${record.exitCode ?? "null"}\`${record.signal ? ` (Signal: ${record.signal})` : ""} |`,
  );
  parts.push(`| **Duration** | \`${record.durationMs}ms\` |`);
  parts.push(
    `| **CPU Profile Produced** | \`${record.cpuProfileProduced ? "YES" : "NO"}\` |`,
  );
  parts.push(
    `| **Heap Profile Produced** | \`${record.heapProfileProduced ? "YES" : "NO"}\` |`,
  );

  if (record.bridgeAudit) {
    parts.push(
      `| **Bridge Replay Completed** | \`${record.bridgeAudit.replayCompleted ? "YES" : "NO"}\` |`,
    );
    parts.push(
      `| **Projection Generated** | \`${record.bridgeAudit.projectionGenerated ? "YES" : "NO"}\` |`,
    );
    parts.push(
      `| **Sinks Bypassed** | \`WS: ${record.bridgeAudit.wsSkipped ? "SKIPPED" : "LIVE"}, R2: ${record.bridgeAudit.r2Skipped ? "SKIPPED" : "LIVE"}\` |`,
    );
  }
  parts.push("");

  if (record.error) {
    parts.push("### Error Message");
    parts.push("```text");
    parts.push(record.error);
    parts.push("```");
    parts.push("");
  }

  if (record.asyncStackTrace) {
    parts.push("### Native Async Stack Trace (Redacted)");
    parts.push("```text");
    parts.push(record.asyncStackTrace);
    parts.push("```");
    parts.push("");
  }

  if (record.cpuHotspots) {
    parts.push("### Profiling: Top Hot Functions");
    parts.push(record.cpuHotspots);
    parts.push("");
  }

  if (record.topRetainedTypes) {
    parts.push("### Memory: Top Retained Heap Types");
    parts.push(record.topRetainedTypes);
    parts.push("");
  }

  parts.push("### Command Line Invocation");
  parts.push("```sh");
  parts.push(record.command.join(" "));
  parts.push("```");

  return parts.join("\n");
}

/**
 * Runs an agent worker script with centralized Bun dev-tooling diagnostics,
 * capturing structured failure reports with async stack traces and profiling upon error.
 */
export async function runAgentWithDiagnostics(
  scriptPath: string,
  scriptArgs: readonly string[] = [],
  options: AgentDiagnosticsOptions = {},
): Promise<
  | { readonly success: true; readonly result: AgentSuccessRecord }
  | { readonly success: false; readonly failure: AgentFailureRecord }
> {
  const startedAt = Date.now();
  const workerId = options.workerId ?? "agent-worker-default";
  const operationId = options.operationId ?? "unknown-operation";
  const correlationId =
    options.correlationId ??
    `corr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const checkpoint = options.checkpoint ?? "init";

  const { cmd, cpuProfilePath, heapProfilePath } = buildAgentCommand(
    scriptPath,
    scriptArgs,
    { ...options, correlationId },
  );

  const env = {
    ...Bun.env,
    ...options.env,
  };

  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutMs);
  }

  const exitCode = await proc.exited;
  if (timeoutTimer) clearTimeout(timeoutTimer);

  const durationMs = Date.now() - startedAt;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const cpuProfileProduced =
    typeof cpuProfilePath === "string" && existsSync(cpuProfilePath);
  const heapProfileProduced =
    typeof heapProfilePath === "string" && existsSync(heapProfilePath);
  const bridgeAudit = auditBridgeReplayOutput(stdout, stderr);

  if (exitCode === 0 && !timedOut) {
    return {
      success: true,
      result: {
        workerId,
        operationId,
        correlationId,
        exitCode: 0,
        signal: null,
        durationMs,
        stdout,
        stderr,
        cpuProfilePath,
        heapProfilePath,
        cpuProfileProduced,
        heapProfileProduced,
        bridgeAudit,
      },
    };
  }

  const cpuHotspots = await extractCpuHotspots(cpuProfilePath);
  const topRetainedTypes = await extractTopRetainedTypes(heapProfilePath);

  const failure: AgentFailureRecord = {
    timestamp: new Date().toISOString(),
    workerId,
    operationId,
    correlationId,
    checkpoint: timedOut ? `${checkpoint}:timeout` : checkpoint,
    exitCode,
    signal: timedOut ? "SIGTERM" : null,
    durationMs,
    cpuProfileProduced,
    heapProfileProduced,
    bridgeAudit,
    error: timedOut
      ? `Worker timed out after ${options.timeoutMs}ms`
      : stderr.trim() || stdout.trim() || undefined,
    asyncStackTrace: stderr ? redactStackTrace(stderr) : undefined,
    cpuHotspots,
    topRetainedTypes,
    command: cmd,
  };

  // Attach sanitized report to CI summary if running under GitHub Actions
  if (Bun.env.GITHUB_ACTIONS === "true" && Bun.env.GITHUB_STEP_SUMMARY) {
    try {
      const report = renderAgentFailureReport(failure);
      await Bun.write(Bun.env.GITHUB_STEP_SUMMARY, `\n\n${report}\n`, {
        createPath: true,
      });
    } catch {
      // Non-fatal attachment error
    }
  }

  // Automatic retention pruning to keep profile directory bounded
  await pruneDiagnosticArtifacts({
    profileDir: options.profileDir ?? "scratch/profiles",
  });

  return { success: false, failure };
}
