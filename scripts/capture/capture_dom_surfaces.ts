#!/usr/bin/env bun
/**
 * @file capture_dom_surfaces.ts
 * @description Install validated operator pastes as the desk artifacts that have no API builder.
 *
 * Why this exists: `capture:all` can only refresh artifacts an API operation rebuilds. Scoreboard,
 * Game Admin, Contests and the stored CP analysis are rendered by the portal, not served by a
 * proven API contract, so today a human edits `data/*.json` by hand — unvalidated and with no
 * record of what was installed. This validates each paste with that artifact's own reader,
 * requires it to state `observedAt`, installs the normalized content, and records the install
 * (input SHA-256 + mtime) in the same health journal as the API captures.
 *
 * A paste that does not validate is refused and the previous artifact is left alone.
 *
 * Input directory layout (names fixed by `REPO_LIVE_ARTIFACTS`):
 *   <dir>/scoreboard.json
 *   <dir>/game-admin-board.json
 *   <dir>/contests.html
 *   <dir>/analysis-cp-baseball.json
 *
 * Usage:
 *   bun run capture:dom --input scratch/pastes --dry-run
 *   bun run capture:dom --input scratch/pastes --only scoreboard,contests
 *   bun run capture:dom --input scratch/pastes
 */

import { join, resolve } from "node:path";
import {
  CAPTURE_HEALTH_PATH,
  mergeCaptureHealth,
  pasteArtifactPlan,
  readCaptureHealth,
  validatePaste,
  writeCaptureHealth,
  type LiveArtifactSpec,
  type LiveCaptureRecord,
} from "../../lib/live_capture.ts";

const root = join(import.meta.dir, "../..");

const HELP = [
  "Usage: bun run capture:dom --input <dir> [flags]",
  "",
  "  --input <dir>    directory holding the paste files (required)",
  "  --only <a,b>     install only these artifact pastes",
  "  --dry-run        validate and print, write nothing",
  "  --json           print the install records as JSON",
  "",
  "Paste files (fixed names):",
  ...pasteArtifactPlan().map(
    (spec) => `  ${spec.pasteFileName}  ->  ${spec.path}`,
  ),
  "",
  "Health: data/capture-health.json — an install records input SHA-256 and mtime.",
].join("\n");

function flagValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? "";
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function failedRecord(
  spec: LiveArtifactSpec,
  error: string,
): LiveCaptureRecord {
  const now = new Date().toISOString();
  return {
    source: spec.name,
    operation: spec.name,
    artifact: spec.path,
    startedAt: now,
    finishedAt: now,
    outcome: "failed",
    transport: "operator-paste",
    httpStatus: null,
    rows: null,
    bytes: null,
    bodySha256: null,
    artifactWritten: false,
    keptPreviousArtifact: true,
    error,
    provenanceClass: "paste",
    inputSha256: null,
    inputMtime: null,
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(HELP);
    return;
  }
  const inputFlag = flagValue(args, "--input");
  if (inputFlag === null || inputFlag.trim() === "") {
    throw new Error(`--input <dir> is required.\n\n${HELP}`);
  }
  const inputDir = resolve(root, inputFlag);
  const onlyFlag = flagValue(args, "--only");
  const only =
    onlyFlag === null
      ? undefined
      : onlyFlag
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
  const dryRun = hasFlag(args, "--dry-run");
  const plan = pasteArtifactPlan(only === undefined ? {} : { only });
  if (plan.length === 0) {
    throw new Error("no paste artifacts selected; check --only names.");
  }

  const records: LiveCaptureRecord[] = [];
  let validatedPastes = 0;
  for (const spec of plan) {
    const fileName = spec.pasteFileName;
    if (fileName === null) continue;
    const inputPath = resolve(inputDir, fileName);
    const file = Bun.file(inputPath);
    if (!(await file.exists())) {
      const record = failedRecord(spec, `input missing: ${fileName}`);
      records.push(record);
      console.error(
        `[capture:dom] ${spec.name.padEnd(20)} FAILED ${record.error}`,
      );
      continue;
    }
    const inputText = await file.text();
    const inputMtime = new Date(file.lastModified).toISOString();
    const validation = validatePaste(spec, inputText, inputMtime);
    if (!validation.ok || validation.artifactText === null) {
      const record = failedRecord(
        spec,
        validation.reason ?? "paste did not validate",
      );
      records.push(record);
      console.error(
        `[capture:dom] ${spec.name.padEnd(20)} FAILED ${record.error}`,
      );
      continue;
    }
    if (dryRun) {
      validatedPastes += 1;
      console.log(
        `  ${spec.name.padEnd(20)} VALID ${String(validation.records).padEnd(5)} observedAt ${validation.observedAt} -> ${spec.path}${dryRun ? " (dry run, not written)" : ""}`,
      );
      continue;
    }
    const now = new Date().toISOString();
    await Bun.write(join(root, spec.path), validation.artifactText);
    const record: LiveCaptureRecord = {
      source: spec.name,
      operation: spec.name,
      artifact: spec.path,
      startedAt: now,
      finishedAt: new Date().toISOString(),
      outcome: "captured",
      transport: "operator-paste",
      httpStatus: null,
      rows: validation.records,
      bytes: validation.artifactText.length,
      bodySha256: sha256Hex(validation.artifactText),
      artifactWritten: true,
      keptPreviousArtifact: false,
      error: null,
      provenanceClass: "paste",
      inputSha256: sha256Hex(inputText),
      inputMtime,
    };
    records.push(record);
    console.log(
      `[capture:dom] ${spec.name.padEnd(20)} installed ${String(validation.records).padEnd(5)} observedAt ${validation.observedAt} -> ${spec.path}`,
    );
  }

  if (dryRun) {
    const failed = records.filter((record) => record.outcome === "failed");
    console.log(
      `[capture:dom] dry run: validated ${validatedPastes}/${plan.length} paste(s), refused ${failed.length}, nothing written`,
    );
    return;
  }

  const healthPath = resolve(root, CAPTURE_HEALTH_PATH);
  const previous = await readCaptureHealth(healthPath);
  const updatedAt = new Date().toISOString();
  await writeCaptureHealth(
    healthPath,
    mergeCaptureHealth(previous, records, updatedAt, "operator-paste"),
  );

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ updatedAt, records }, null, 2));
  }
  const failed = records.filter((record) => record.outcome === "failed");
  console.log(
    `[capture:dom] captured ${records.length - failed.length}/${records.length}, failed ${failed.length}; health -> ${CAPTURE_HEALTH_PATH}`,
  );
  if (failed.length > 0 && failed.length === records.length) {
    throw new Error(
      "every paste failed; the previous artifacts were left in place.",
    );
  }
}

await main();
