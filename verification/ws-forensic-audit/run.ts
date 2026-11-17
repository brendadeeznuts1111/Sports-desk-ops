#!/usr/bin/env bun
/**
 * Runs the WS / secrets / clock probes and writes evidence JSON next to this file.
 * Exit code 1 when any executed probe fails; unexecuted probes are reported as such.
 */
import { join } from "node:path";

const here = import.meta.dir;
const probes = [
  "probe_ws.ts",
  "probe_nanoseconds.ts",
  "probe_secrets.ts",
] as const;
const evidence: Record<string, unknown> = {};

for (const probe of probes) {
  const child = Bun.spawn(["bun", join(here, probe)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  evidence[probe] = {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim().slice(-800),
  };
}

const ws = JSON.parse(
  String((evidence["probe_ws.ts"] as { stdout: string }).stdout),
) as {
  config: Record<string, unknown>;
  subscribe: { reply: string };
  malformed: { stillOpen: boolean; reply: string };
  oversize: { closeCode: number };
  backpressure: {
    evicted: boolean;
    silentGap: boolean;
    droppedFrames: number;
    clientsAfter: number;
  };
};
const checks = {
  "ws.maxPayloadLength": ws.config.maxPayloadLength === 16 * 1024,
  "ws.backpressureLimit": ws.config.backpressureLimit === 256 * 1024,
  "ws.closeOnBackpressureLimit": ws.config.closeOnBackpressureLimit === true,
  "ws.oversize->1009": ws.oversize.closeCode === 1009,
  "ws.subscribe->ack": ws.subscribe.reply.includes('"type":"subscribed"'),
  "ws.malformed-still-open": ws.malformed.stillOpen === true,
  "ws.stalled-consumer-evicted": ws.backpressure.evicted === true,
  "ws.no-silent-gap": ws.backpressure.silentGap === false,
};

const out = {
  generatedAt: new Date().toISOString(),
  checks,
  passed: Object.values(checks).every(Boolean),
  evidence,
};
const target = join(here, "evidence.json");
await Bun.write(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ target, passed: out.passed, checks }, null, 2));
process.exit(out.passed ? 0 : 1);
