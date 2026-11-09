import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditBridgeReplayOutput,
  buildAgentCommand,
  extractCpuHotspots,
  extractTopRetainedTypes,
  pruneDiagnosticArtifacts,
  redactStackTrace,
  renderAgentFailureReport,
  runAgentWithDiagnostics,
  type AgentFailureRecord,
} from "../lib/agent_diagnostics.ts";

describe("Unified Bun Agent Diagnostics Layer", () => {
  test("buildAgentCommand enforces --no-orphans and --no-env-file before script path", () => {
    const { cmd, cpuProfilePath, heapProfilePath } = buildAgentCommand(
      "scripts/worker.ts",
      ["--task=sync"],
      {
        cpuProfile: true,
        heapProfile: true,
        correlationId: "test_corr_123",
      },
    );

    // Runtime executable is first
    expect(cmd[0]).toBe(process.execPath);

    // Flags precede script path
    const scriptIdx = cmd.indexOf("scripts/worker.ts");
    expect(scriptIdx).toBeGreaterThan(1);
    expect(cmd.indexOf("--no-orphans")).toBeLessThan(scriptIdx);
    expect(cmd.indexOf("--no-env-file")).toBeLessThan(scriptIdx);
    expect(cmd.indexOf("--cpu-prof-md")).toBeLessThan(scriptIdx);
    expect(cmd.indexOf("--heap-prof-md")).toBeLessThan(scriptIdx);

    // Script arguments follow script path
    expect(cmd[scriptIdx + 1]).toBe("--task=sync");

    expect(cpuProfilePath).toContain("agent_test_corr_123.cpuprofile.md");
    expect(heapProfilePath).toContain("agent_test_corr_123.heapprofile.md");
  });

  test("redactStackTrace sanitizes JWTs, Bearer tokens, and sensitive query params", () => {
    const publicSampleJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const rawTrace = `
Error: Request failed: 401 Unauthorized
    at async fetchWithAuth (https://api.fantasy402.com/v1/data?token=super_secret_998877&auth=secret123)
    at async runPipeline (app.ts:42:15)
Headers:
    Authorization: Bearer ${publicSampleJwt}
    Cookie: session_id=sess_abcdef123456; other=public
`;

    const sanitized = redactStackTrace(rawTrace);

    expect(sanitized).not.toContain("super_secret_998877");
    expect(sanitized).not.toContain("secret123");
    expect(sanitized).not.toContain("sess_abcdef123456");
    expect(sanitized).toContain("token=[REDACTED]");
    expect(sanitized).toContain("auth=[REDACTED]");
    expect(sanitized).toContain("Authorization: Bearer [REDACTED_JWT]");
    expect(sanitized).toContain("Cookie: session_id=[REDACTED]");
  });

  test("runAgentWithDiagnostics captures successful execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-diag-"));
    const script = join(dir, "success_worker.ts");
    try {
      await Bun.write(
        script,
        `
      console.log("WORKER_OK: Task finished");
      `,
      );

      const run = await runAgentWithDiagnostics(script, [], {
        workerId: "worker-01",
        operationId: "data-sync",
      });

      expect(run.success).toBe(true);
      if (run.success) {
        expect(run.result.exitCode).toBe(0);
        expect(run.result.stdout).toContain("WORKER_OK: Task finished");
        expect(run.result.workerId).toBe("worker-01");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runAgentWithDiagnostics captures native async stack traces and generates failure report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-diag-"));
    const script = join(dir, "failing_worker.ts");
    try {
      await Bun.write(
        script,
        `
      async function stepInner() {
        // Trigger native async failure (missing file)
        await Bun.file("/nonexistent/sportsdesk/data.json").text();
      }
      async function stepOuter() {
        await stepInner();
      }
      await stepOuter();
      `,
      );

      const run = await runAgentWithDiagnostics(script, [], {
        workerId: "worker-02",
        operationId: "file-ingest",
        checkpoint: "parsing-data-source",
        cpuProfile: true,
        heapProfile: true,
        profileDir: dir,
      });

      expect(run.success).toBe(false);
      if (!run.success) {
        expect(run.failure.exitCode).not.toBe(0);
        expect(run.failure.checkpoint).toBe("parsing-data-source");
        expect(run.failure.asyncStackTrace).toBeDefined();

        // Native async stack trace points back across await calls
        expect(run.failure.asyncStackTrace).toContain("stepInner");
        expect(run.failure.asyncStackTrace).toContain("stepOuter");

        // Renders structured Markdown failure report
        const report = renderAgentFailureReport(run.failure);
        expect(report).toContain("## Agent Failure Triage Report");
        expect(report).toContain("| **Operation ID** | `file-ingest` |");
        expect(report).toContain("| **Worker ID** | `worker-02` |");
        expect(report).toContain("stepInner");
        expect(report).toContain("Command Line Invocation");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renderAgentFailureReport produces expected GitHub Markdown structure", () => {
    const record: AgentFailureRecord = {
      timestamp: "2026-11-08T18:00:00Z",
      workerId: "agent-007",
      operationId: "risk-assessment",
      correlationId: "corr-xyz",
      checkpoint: "scoring-legs",
      exitCode: 1,
      signal: null,
      durationMs: 450,
      cpuProfileProduced: true,
      heapProfileProduced: true,
      error: "Error: Ticket risk exceeded bounds",
      asyncStackTrace:
        "Error: Ticket risk exceeded bounds\n    at evalLegs (eval.ts:25:5)",
      command: ["bun", "--no-orphans", "--no-env-file", "worker.ts"],
    };

    const md = renderAgentFailureReport(record);
    expect(md).toContain("## Agent Failure Triage Report");
    expect(md).toContain("| **Worker ID** | `agent-007` |");
    expect(md).toContain("| **Operation ID** | `risk-assessment` |");
    expect(md).toContain("Ticket risk exceeded bounds");
    expect(md).toContain("evalLegs (eval.ts:25:5)");
    expect(md).toContain("bun --no-orphans --no-env-file worker.ts");
  });

  test("extractCpuHotspots and extractTopRetainedTypes extract Markdown tables from engine profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-prof-"));
    const cpuFile = join(dir, "sample.cpuprofile.md");
    const heapFile = join(dir, "sample.heapprofile.md");

    try {
      await Bun.write(
        cpuFile,
        `# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 10.0ms | 5 | 1.0ms | 16 |

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 47.6% | 4.8ms | 47.6% | 4.8ms | \`DateTimeFormat\` | \`[native code]\` |
| 25.6% | 2.5ms | 25.6% | 2.5ms | \`ownKeys\` | \`[native code]\` |
| 13.9% | 1.4ms | 13.9% | 1.4ms | \`Map\` | \`[native code]\` |
`,
      );

      await Bun.write(
        heapFile,
        `# Bun Heap Profile

## Top 50 Types by Retained Size

| Rank | Type | Count | Self Size | Retained Size | Largest Instance |
|-----:|------|------:|----------:|--------------:|-----------------:|
| 1 | \`Structure\` | 1603 | 175.3 KB | 2.7 MB | 11.8 KB |
| 2 | \`<root>\` | 1 | 0 B | 879.8 KB | 879.8 KB |
| 3 | \`GlobalObject\` | 1 | 9.6 KB | 717.0 KB | 717.0 KB |
`,
      );

      const cpuHotspots = await extractCpuHotspots(cpuFile);
      expect(cpuHotspots).toBeDefined();
      expect(cpuHotspots).toContain("DateTimeFormat");
      expect(cpuHotspots).toContain("ownKeys");

      const topTypes = await extractTopRetainedTypes(heapFile);
      expect(topTypes).toBeDefined();
      expect(topTypes).toContain("Structure");
      expect(topTypes).toContain("GlobalObject");

      // Non-existent or invalid paths gracefully return undefined
      expect(await extractCpuHotspots("/nonexistent/file.md")).toBeUndefined();
      expect(
        await extractTopRetainedTypes("/nonexistent/file.md"),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auditBridgeReplayOutput audits bridge replay output and detects intentional sink skips", () => {
    const rawStdout = `
[bridge3a] published new=1 gone=0 changed=0 watermark=0 ws=skipped r2=skipped
{
  "status": "published",
  "event": {
    "schemaVersion": 1,
    "kind": "f402-bet-ticker",
    "watermark": "0",
    "newTickets": 1
  },
  "snapshot": {
    "schemaVersion": 1,
    "kind": "f402-bet-ticker"
  }
}
`;
    const audit = auditBridgeReplayOutput(rawStdout, "");
    expect(audit).toBeDefined();
    expect(audit?.replayCompleted).toBe(true);
    expect(audit?.projectionGenerated).toBe(true);
    expect(audit?.snapshotGenerated).toBe(true);
    expect(audit?.wsSkipped).toBe(true);
    expect(audit?.r2Skipped).toBe(true);
    expect(audit?.status).toBe("published");
    expect(audit?.newTickets).toBe(1);
    expect(audit?.watermark).toBe("0");

    // Non-bridge output yields undefined
    expect(auditBridgeReplayOutput("random console text", "")).toBeUndefined();
  });

  test("runAgentWithDiagnostics correctly isolates nonzero exits and does not confuse with success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-nonzero-"));
    const script = join(dir, "usage_error.ts");
    try {
      await Bun.write(
        script,
        `
      console.error("Usage: pass --agent <id>");
      process.exit(2);
      `,
      );

      const run = await runAgentWithDiagnostics(script, [], {
        workerId: "worker-nonzero",
        operationId: "cli-validation",
        cpuProfile: true,
        heapProfile: true,
        profileDir: dir,
      });

      // Assertions guarantee nonzero exit is never mistaken for success
      expect(run.success).toBe(false);
      if (!run.success) {
        expect(run.failure.exitCode).toBe(2);
        expect(run.failure.signal).toBeNull();
        expect(run.failure.cpuProfileProduced).toBe(true);
        expect(run.failure.heapProfileProduced).toBe(true);
        expect(run.failure.error).toContain("Usage: pass --agent <id>");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runAgentWithDiagnostics verifies successful end-to-end bridge replay with profile generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    try {
      const run = await runAgentWithDiagnostics(
        "scripts/f402_bet_ticker_bridge3a.ts",
        [
          "--once",
          "--dry-run",
          "--from-body",
          "tests/fixtures/captures/getBetTicker.mock.json",
        ],
        {
          workerId: "bridge3a-worker",
          operationId: "ticker-replay",
          cpuProfile: true,
          heapProfile: true,
          profileDir: dir,
        },
      );

      expect(run.success).toBe(true);
      if (run.success) {
        expect(run.result.exitCode).toBe(0);
        expect(run.result.signal).toBeNull();
        expect(run.result.cpuProfileProduced).toBe(true);
        expect(run.result.heapProfileProduced).toBe(true);
        expect(run.result.bridgeAudit).toBeDefined();
        expect(run.result.bridgeAudit?.replayCompleted).toBe(true);
        expect(run.result.bridgeAudit?.projectionGenerated).toBe(true);
        expect(run.result.bridgeAudit?.wsSkipped).toBe(true);
        expect(run.result.bridgeAudit?.r2Skipped).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruneDiagnosticArtifacts enforces maxFiles and maxAge retention limits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-prune-"));
    try {
      // Create 5 dummy profile artifacts
      for (let i = 1; i <= 5; i++) {
        await Bun.write(
          join(dir, `agent_test_${i}.cpuprofile.md`),
          `# CPU Profile ${i}`,
        );
      }

      // Prune with maxFiles = 3
      const result = await pruneDiagnosticArtifacts({
        profileDir: dir,
        maxFiles: 3,
      });

      expect(result.examined).toBe(5);
      expect(result.pruned).toBe(2);
      expect(result.retained).toBe(3);

      // Subsequent prune with unchanged limits prunes nothing
      const noopResult = await pruneDiagnosticArtifacts({
        profileDir: dir,
        maxFiles: 3,
      });
      expect(noopResult.pruned).toBe(0);
      expect(noopResult.retained).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
