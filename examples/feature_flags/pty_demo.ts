/**
 * @file examples/feature_flags/pty_demo.ts
 * @description Demonstrates Bun.Terminal PTY execution with compile-time feature flags.
 *
 * Runs the SportsDesk risk evaluation engine inside a real pseudo-terminal (PTY),
 * observing real TTY behavior, ANSI color sequences, and compile-time dead-code elimination.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnBunInPty, TerminalSession } from "../../lib/bun_terminal.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoScript = path.join(__dirname, "demo.ts");

console.log(
  "================================================================================",
);
console.log(
  "   SportsDesk: Bun.Terminal Native PTY Runner with Compile-Time Flags",
);
console.log(
  "================================================================================\n",
);

// 1. Run in Development PTY Session (DEBUG + ANALYTICS + EXPERIMENTAL enabled)
console.log(
  ">>> [1/2] Spawning PTY session with target: 'dev' (Cols: 100, Rows: 30)...",
);
const devResult = await spawnBunInPty(demoScript, [], {
  target: "dev",
  cols: 100,
  rows: 30,
});

console.log("PTY Exit Code:", devResult.code);
console.log("Captured Output Preview (First 8 lines):\n");
console.log(devResult.out.split("\n").slice(0, 8).join("\n"));

// 2. Run in Production PTY Session (DEBUG + EXPERIMENTAL eliminated)
console.log(
  "\n>>> [2/2] Spawning PTY session with target: 'prod' (Cols: 100, Rows: 30)...",
);
const prodResult = await spawnBunInPty(demoScript, [], {
  target: "prod",
  cols: 100,
  rows: 30,
});

console.log("PTY Exit Code:", prodResult.code);
console.log("Production Bundle Summary:\n");
const prodLines = prodResult.out
  .split("\n")
  .filter((line) => line.includes("Prod Bundle") || line.includes("stripped"));
console.log(prodLines.join("\n") || prodResult.out.slice(-200));

// 3. Interactive Agent TerminalSession (start, write, resize, wait, await using)
console.log(
  "\n>>> [3/3] Driving interactive TerminalSession (lifecycle + raw ANSI replay)...",
);
{
  await using session = await TerminalSession.start(["bash"], {
    cols: 80,
    rows: 24,
  });

  // Dynamic terminal sizing
  session.resize(100, 30);

  // Send input lines
  session.writeLine("echo -e '\\x1b[36m[AGENT_PROMPT]\\x1b[0m Terminal ready'");
  await session.waitForOutput("[AGENT_PROMPT]");

  session.writeLine("echo 'Executing risk evaluation step 1'");
  await session.waitForOutput("step 1");

  session.writeLine("exit 0");
  const exitCode = await session.wait();

  console.log("Session Subprocess Exit Code:", exitCode);
  console.log("Preserved Raw ANSI Chars:", session.rawBytes);
  console.log("Audit Events Logged:", session.auditEvents.length);
  console.log("Clean Plain Text Output Summary:");
  console.log(
    session.text
      .split("\n")
      .filter((l) => l.includes("[AGENT_PROMPT]") || l.includes("step 1"))
      .join("\n"),
  );
}

console.log(
  "\n✓ Native PTY execution with compile-time flags completed successfully.",
);
