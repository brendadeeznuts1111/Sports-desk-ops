/**
 * @file examples/feature_flags/demo.ts
 * @description Executable showcase demonstrating:
 * 1. Compile-time feature flags in risk evaluation
 * 2. Background worker execution via Bun IPC with process.execPath
 * 3. Dead-code elimination in Bun.build with BUILD_FEATURES.prod
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_FEATURES } from "../../types/features.ts";
import {
  evaluateWagerRisk,
  type RiskAssessment,
  type Wager,
} from "./risk_engine.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));

async function runDemo(): Promise<void> {
  console.log("=== 1. In-Process Evaluation ===");
  const testWager: Wager = {
    ticketId: "TKT-402-9901",
    customerLogin: "agent_syn_bettor1",
    sport: "NFL",
    stake: 2500,
    odds: 4.5,
    isLive: true,
  };

  const localAssessment = evaluateWagerRisk(testWager);
  console.log(
    "In-process assessment:",
    JSON.stringify(localAssessment, null, 2),
  );

  console.log(
    "\n=== 2. IPC Subprocess Worker (process.execPath + serialization: json) ===",
  );
  const workerScript = join(currentDir, "ipc_worker.ts");

  let workerAssessment: RiskAssessment | undefined;
  // Spawn child worker process with flags derived from BUILD_FEATURES.dev
  const workerFeatureArgs = BUILD_FEATURES.dev.map((f) => `--feature=${f}`);
  const workerProc = Bun.spawn(
    [process.execPath, ...workerFeatureArgs, workerScript],
    {
      ipc(msg: { assessment?: RiskAssessment }) {
        if (msg.assessment) {
          workerAssessment = msg.assessment;
        }
      },
      serialization: "json",
    },
  );

  workerProc.send({ wager: testWager });

  // Await worker response
  let attempts = 0;
  while (!workerAssessment && attempts < 20) {
    await Bun.sleep(50);
    attempts++;
  }

  workerProc.send({ shutdown: true });
  await workerProc.exited;

  console.log(
    "Worker received via IPC:",
    JSON.stringify(workerAssessment, null, 2),
  );

  console.log(
    "\n=== 3. Bun.build Dead-Code Elimination (BUILD_FEATURES.prod) ===",
  );
  const entry = join(currentDir, "risk_engine.ts");

  const buildDev = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: true,
    features: [...BUILD_FEATURES.dev],
  });

  const buildProd = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: true,
    features: [...BUILD_FEATURES.prod],
  });

  const devCode = await buildDev.outputs[0]!.text();
  const prodCode = await buildProd.outputs[0]!.text();

  console.log(
    `Dev Bundle Size:  ${devCode.length} bytes (Includes telemetry, syndicate heuristics, trace)`,
  );
  console.log(
    `Prod Bundle Size: ${prodCode.length} bytes (Zero debug overhead, stripped bun:bundle)`,
  );

  const containsDebugInProd = prodCode.includes("DEBUG_TRACE");
  const containsSyndicateInProd = prodCode.includes(
    "EXPERIMENTAL_SYNDICATE_SUSPECT",
  );
  const containsImportInProd = prodCode.includes("bun:bundle");

  console.log("\nDead-Code Verification in Prod Bundle:");
  console.log(
    `- Debug trace stripped?      ${!containsDebugInProd ? "✓ YES" : "✗ NO"}`,
  );
  console.log(
    `- Experimental code stripped? ${!containsSyndicateInProd ? "✓ YES" : "✗ NO"}`,
  );
  console.log(
    `- bun:bundle import removed?  ${!containsImportInProd ? "✓ YES" : "✗ NO"}`,
  );
}

if (import.meta.main) {
  await runDemo();
}
