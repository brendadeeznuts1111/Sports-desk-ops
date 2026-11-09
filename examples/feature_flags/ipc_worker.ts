/**
 * @file examples/feature_flags/ipc_worker.ts
 * @description Background risk surveillance worker running via Bun IPC.
 */

import { evaluateWagerRisk, type Wager } from "./risk_engine.ts";

process.on("message", (msg: { wager?: Wager; shutdown?: boolean }) => {
  if (msg.shutdown) {
    process.exit(0);
  }
  if (msg.wager) {
    const assessment = evaluateWagerRisk(msg.wager);
    process.send?.({ assessment });
  }
});
