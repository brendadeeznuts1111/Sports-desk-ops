/**
 * @file tests/pty_injection.test.ts
 * @description PTY command execution and shell injection regression suite.
 * Proves that TerminalSession and executeTerminalQuery use direct array-form
 * execve without intermediate shell invocation (sh -c / bash -c), making
 * shell metacharacter injections (; | && ` $() < >) completely inert.
 */

import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import { TerminalSession } from "../lib/bun_terminal.ts";

const createProbePath = () =>
  `/tmp/pty_injection_exploit_probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;

const cleanFile = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
};

describe("PTY Shell Injection Defense (lib/terminal_emulator.ts & lib/bun_terminal.ts)", () => {
  it("treats semicolons as literal arguments, preventing chained command injection", async () => {
    const probe = createProbePath();
    try {
      // If passed to a shell (sh -c), touch would create probe
      const result = await executeTerminalQuery(`echo test; touch ${probe}`);

      // Verify file was never created
      const probeFile = Bun.file(probe);
      expect(await probeFile.exists()).toBe(false);

      // Verify stdout printed literal semicolon as argv argument
      expect(result.stdout).toContain("test;");
    } finally {
      cleanFile(probe);
    }
  });

  it("prevents pipe hijacking in customer query inputs", async () => {
    const probe = createProbePath();
    try {
      const result = await executeTerminalQuery(
        `profile GP301 | touch ${probe}`,
      );

      const probeFile = Bun.file(probe);
      expect(await probeFile.exists()).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      cleanFile(probe);
    }
  });

  it("prevents backtick command substitution from executing subcommands", async () => {
    const probe = createProbePath();
    try {
      const result = await executeTerminalQuery(`echo \`touch ${probe}\``);

      const probeFile = Bun.file(probe);
      expect(await probeFile.exists()).toBe(false);
      expect(result.stdout).toContain("`touch");
    } finally {
      cleanFile(probe);
    }
  });

  it("prevents $(...) command substitution", async () => {
    const probe = createProbePath();
    try {
      const result = await executeTerminalQuery(`echo $(touch ${probe})`);

      const probeFile = Bun.file(probe);
      expect(await probeFile.exists()).toBe(false);
      expect(result.stdout).toContain("$(touch");
    } finally {
      cleanFile(probe);
    }
  });

  it("TerminalSession.start uses direct array-form execve without shell wrapper", async () => {
    const probe = createProbePath();
    try {
      await using session = await TerminalSession.start([
        "echo",
        `safe; touch ${probe}`,
      ]);

      await session.wait();

      const probeFile = Bun.file(probe);
      expect(await probeFile.exists()).toBe(false);
      expect(session.raw).toContain("safe;");
    } finally {
      cleanFile(probe);
    }
  });
});
