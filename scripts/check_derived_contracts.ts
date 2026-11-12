/**
 * Fail loudly when derived operator contracts drift from their source of truth:
 * the Bun runtime pin (manifests, workspaces, orientation docs) and the v1
 * R2 staleness SLA table.
 *
 *   bun run check:derived-contracts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_PIN_DOCS,
  assertWorkspaceBunPins,
  checkRuntimePinDocs,
  readBunRuntimePin,
} from "../lib/bun_runtime_pin.ts";
import {
  R2_SLA_RUNBOOK_PATH,
  checkR2SlaRunbook,
} from "../lib/derived_r2_sla_docs.ts";

const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));
const ROOT = join(MODULE_DIR, "..");

function main(): void {
  const pin = readBunRuntimePin(ROOT);
  const workspaces = assertWorkspaceBunPins(ROOT, pin);
  const docs: Record<string, string> = {};
  for (const file of RUNTIME_PIN_DOCS) {
    docs[file] = readFileSync(join(ROOT, file), "utf8");
  }
  const docIssues = checkRuntimePinDocs(docs, pin);
  if (docIssues.length > 0) {
    for (const issue of docIssues) {
      console.error(issue.message);
    }
    process.exit(1);
  }
  checkR2SlaRunbook(readFileSync(join(ROOT, R2_SLA_RUNBOOK_PATH), "utf8"));
  console.log(
    `check:derived-contracts: ok (bun ${pin}, ${workspaces.length} workspace engines, ${RUNTIME_PIN_DOCS.length} pin docs, ${R2_SLA_RUNBOOK_PATH})`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
