import { expect, test } from "bun:test";

import {
  driveBashScript,
  spawnInPty,
  spawnInPtyUntil,
} from "./bun_terminal.ts";
import { BUN_TERMINAL_PTY_TEST_NAME } from "./bun_terminal_test_names.ts";
import {
  capabilityDiagnostics,
  hasPty,
} from "../tests/support/capabilities.ts";

if (!hasPty) {
  console.log(
    `[bun_terminal_blog_programs] skipping PTY assertions: ${capabilityDiagnostics.pty.reason}`,
  );
}

const bashPath = Bun.which("bash");
const vimPath = Bun.which("vim");
const htopPath = Bun.which("htop");

test.skipIf(!hasPty || bashPath === null)(
  BUN_TERMINAL_PTY_TEST_NAME.blog.bashLcEcho,
  async () => {
    const result = await spawnInPty([
      bashPath!,
      "-lc",
      "echo Hello from bash PTY",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Hello from bash PTY");
  },
);

test.skipIf(!hasPty || bashPath === null)(
  BUN_TERMINAL_PTY_TEST_NAME.blog.bashTerminalWriteScript,
  async () => {
    const result = await driveBashScript(["echo scripted-input", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("scripted-input");
  },
);

test.skipIf(!hasPty || vimPath === null)(
  BUN_TERMINAL_PTY_TEST_NAME.blog.vimBatchQuit,
  async () => {
    const result = await spawnInPty([
      vimPath!,
      "-N",
      "-u",
      "NONE",
      "-n",
      "-c",
      "qa!",
    ]);
    expect(result.code).toBe(0);
  },
);

test.skipIf(!hasPty || vimPath === null)(
  BUN_TERMINAL_PTY_TEST_NAME.blog.vimIsattyStdout,
  async () => {
    const result = await spawnInPty([
      vimPath!,
      "-N",
      "-u",
      "NONE",
      "-n",
      "-c",
      "echo isatty(1)",
      "-c",
      "qa!",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/1|true/i);
  },
);

test.skipIf(!hasPty || htopPath === null)(
  BUN_TERMINAL_PTY_TEST_NAME.blog.htopTuiFooterThenKill,
  async () => {
    const htopUi = /F10Quit|F1Help|htoprc/i;
    const result = await spawnInPtyUntil([htopPath!], {
      cols: 120,
      rows: 40,
      untilOutput: htopUi,
      maxMs: 3000,
    });
    expect(result.rawBytes).toBeGreaterThan(100);
    expect(result.out).toMatch(htopUi);
    expect(result.killed).toBe(true);
  },
);
