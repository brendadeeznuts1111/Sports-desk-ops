#!/usr/bin/env bun
/**
 * Recompute manifest entries from on-disk capture records (hashes + tier projection + counts).
 */
import { join } from "node:path";
import {
  assertCaptureRecord,
  CaptureStore,
  readCaptureManifest,
} from "./recorder.ts";

const root = process.argv[2]?.trim() || "docs/evidence/captures";

const existing = await readCaptureManifest(root);
if (existing === null) {
  console.error(`repair_manifest_hashes: no manifest under ${root}`);
  process.exit(1);
}

const store = new CaptureStore({ root });
for (const entry of existing.captures) {
  const absolutePath = join(root, ...entry.file.split("/"));
  const parsed = (await Bun.file(absolutePath).json()) as unknown;
  const record = assertCaptureRecord(parsed);
  await store.write(record);
}
await store.finalize();
console.error(
  `repair_manifest_hashes: refreshed ${existing.captures.length} entries under ${root}`,
);
