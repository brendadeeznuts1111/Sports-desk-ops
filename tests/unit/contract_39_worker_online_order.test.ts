import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

// https://github.com/oven-sh/bun/commit/9fdcf5af20726a8416349c2afb3d366908d6fd77
test("Contract #39: worker online precedes the first message", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.postMessage("first-message");
     parentPort.close();`,
    { eval: true },
  );
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  const events: string[] = [];
  worker.on("online", () => events.push("online"));
  worker.on("message", () => events.push("message"));
  try {
    await once(worker, "online", { signal: abort.signal });
    // A consumer installing its listener after online must receive the first message.
    const [message] = await once(worker, "message", { signal: abort.signal });
    expect(message).toBe("first-message");
    expect(events).toEqual(["online", "message"]);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await worker.terminate();
  }
});
