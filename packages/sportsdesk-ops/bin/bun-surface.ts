#!/usr/bin/env bun
/**
 * Workspace bin shim for `bun x bun-surface` (see src/bin/bun-surface.ts).
 */
import { run } from "../src/bin/bun-surface.ts";

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(message.includes("ERR_CF_TOKEN_BLEED_10000") ? 77 : 65);
});
