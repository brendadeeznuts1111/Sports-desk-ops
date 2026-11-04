/**
 * Regression: a PTY probe must release the terminal master, not just kill the child.
 * `Bun.spawn(..., { terminal })` allocates a `/dev/ptmx` descriptor and exposes it as
 * `proc.terminal`; a `finally` that only calls `proc.kill()` leaks one descriptor per probe.
 * `closePtyProcess` is the single cleanup path `probePty` uses, so it is tested directly here.
 *
 * The PTY assertions skip (with the probe's reason) on hosts where the sandbox denies PTY
 * allocation; the no-PTY assertions still exercise the helper's missing-process/reaped-child paths.
 */
import { describe, expect, test } from "bun:test";

import {
  capabilityDiagnostics,
  closePtyProcess,
} from "./support/capabilities.ts";

const pty = capabilityDiagnostics.pty;

if (!pty.available) {
  console.log(`[pty_terminal_cleanup] skipping PTY assertions: ${pty.reason}`);
}

describe("closePtyProcess", () => {
  test("is a no-op for a missing process and a reaped non-PTY child", async () => {
    await expect(closePtyProcess(undefined)).resolves.toBeUndefined();
    const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(proc.terminal).toBeUndefined();
    await proc.exited;
    expect(proc.exitCode).not.toBeNull();
    await expect(closePtyProcess(proc)).resolves.toBeUndefined();
    expect(proc.exitCode).not.toBeNull();
  });

  test.skipIf(!pty.available)(
    "closes the terminal master and reaps an already-exited child",
    async () => {
      const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
        terminal: { cols: 80, rows: 24, data() {} },
        stdout: "ignore",
        stderr: "ignore",
      });
      const terminal = proc.terminal;
      expect(terminal).toBeDefined();
      await proc.exited;
      expect(proc.exitCode).not.toBeNull();

      await expect(closePtyProcess(proc)).resolves.toBeUndefined();
      expect(proc.exitCode).not.toBeNull();
      expect(terminal?.closed).toBe(true);

      // Idempotent: the probe's `finally` must stay safe if it runs a second time.
      await expect(closePtyProcess(proc)).resolves.toBeUndefined();
    },
  );

  test.skipIf(!pty.available)(
    "kills and reaps a child that is still running",
    async () => {
      const proc = Bun.spawn(
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 10_000)"],
        {
          terminal: { cols: 80, rows: 24, data() {} },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode).toBeNull();

      await expect(closePtyProcess(proc)).resolves.toBeUndefined();
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
      expect(proc.terminal?.closed).toBe(true);
    },
  );
});
