#!/usr/bin/env bun
/**
 * @file packages/sportsdesk-ops/src/scripts/check_spec_citations.ts
 * @description GATE-BUN-DOC-BLOB-SHA-01 (pinned bun-types blob URLs in markdown).
 *
 *   bun run --cwd packages/sportsdesk-ops check:spec-citations-blob
 *   bun run check:spec-citations   # root: this gate + evidence anchor audit
 */
import { resolve } from "node:path";
import {
  resolveRepoRoot,
  runGateBunDocBlobSha,
} from "../lib/gate_bun_doc_blob_sha.ts";

export async function run(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(
      `check_spec_citations (package) — GATE-BUN-DOC-BLOB-SHA-01 only\n`,
    );
    return 0;
  }

  const repoRoot = resolveRepoRoot(resolve(import.meta.dir, "../../.."));
  const result = await runGateBunDocBlobSha({
    repoRoot,
    moduleDir: resolve(import.meta.dir, "../lib"),
  });

  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return 65;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.main) {
  run()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(message.includes("ERR_CF_TOKEN_BLEED_10000") ? 77 : 65);
    });
}
