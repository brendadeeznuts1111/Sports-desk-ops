#!/usr/bin/env bun
/**
 * Validate a DOD6 spine header through the format's OWN schema and accessor.
 *
 * This is deliberately not a second parser: magic, version, section count,
 * alignment and header length come from lib/dod6_v54_schema.ts, and section
 * offsets are read with the reader's exported sectionOffset(). A format with a
 * strict mount-time validator does not need a looser copy of it.
 *
 *   bun scripts/probe_dodbin.ts [--json] [file ...]
 *
 * Exit 0 when every file's header validates, 1 when any does not, 2 on a
 * missing/unreadable file.
 */
import { readFileSync, statSync } from "node:fs";

import {
  DOD6_ALIGNMENT_BYTES,
  DOD6_HEADER_BYTE_LENGTH,
  DOD6_SECTION_COUNT,
  isValidDod6Header,
} from "../lib/dod6_v54_schema.ts";
import { sectionOffset } from "../lib/dod6_v54_lifetime_reader.ts";

interface FileReport {
  readonly path: string;
  readonly size: number;
  readonly ok: boolean;
  readonly version: number | null;
  readonly sections: number;
  readonly firstOffset: number | null;
  readonly lastOffset: number | null;
  readonly problems: string[];
}

function probe(path: string): FileReport {
  const problems: string[] = [];
  const size = statSync(path).size;
  const head = readFileSync(path, { encoding: null, flag: "r" }).subarray(
    0,
    DOD6_HEADER_BYTE_LENGTH,
  );
  if (head.byteLength < DOD6_HEADER_BYTE_LENGTH) {
    return {
      path,
      size,
      ok: false,
      version: null,
      sections: 0,
      firstOffset: null,
      lastOffset: null,
      problems: [
        `header truncated: ${head.byteLength} of ${DOD6_HEADER_BYTE_LENGTH} bytes`,
      ],
    };
  }

  // The schema's own validator: word 0 magic, word 1 version.
  const words = new Uint32Array(
    head.buffer,
    head.byteOffset,
    head.byteLength / 4,
  );
  if (!isValidDod6Header(words)) {
    problems.push(
      `magic/version rejected (word0=0x${words[0]!.toString(16)}, word1=${words[1]})`,
    );
  }

  let sections = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (let index = 0; index < DOD6_SECTION_COUNT; index += 1) {
    const offset = sectionOffset(words, index);
    if (offset === 0) continue; // unused section
    sections += 1;
    if (first === null || offset < first) first = offset;
    if (last === null || offset > last) last = offset;
    if (offset % DOD6_ALIGNMENT_BYTES !== 0) {
      problems.push(
        `section ${index} offset ${offset} is not ${DOD6_ALIGNMENT_BYTES}-byte aligned`,
      );
    }
    if (offset < DOD6_HEADER_BYTE_LENGTH || offset >= size) {
      problems.push(
        `section ${index} offset ${offset} outside file body (header=${DOD6_HEADER_BYTE_LENGTH}, size=${size})`,
      );
    }
  }

  return {
    path,
    size,
    ok: problems.length === 0,
    version: words[1] ?? null,
    sections,
    firstOffset: first,
    lastOffset: last,
    problems,
  };
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const files = argv.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error(
    "usage: bun scripts/probe_dodbin.ts [--json] <file> [file ...]",
  );
  process.exit(2);
}

const reports: FileReport[] = [];
let failed = 0;
for (const file of files) {
  try {
    const report = probe(file);
    if (!report.ok) failed += 1;
    reports.push(report);
  } catch (error) {
    failed += 1;
    reports.push({
      path: file,
      size: 0,
      ok: false,
      version: null,
      sections: 0,
      firstOffset: null,
      lastOffset: null,
      problems: [
        `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: failed === 0, reports }, null, 2));
} else {
  for (const report of reports) {
    const span =
      report.firstOffset === null
        ? "no sections"
        : `${report.firstOffset}..${report.lastOffset}`;
    console.log(
      `${report.ok ? "ok  " : "FAIL"} ${report.path.split("/").pop()}  ` +
        `version=${report.version ?? "?"}  size=${report.size}  sections=${report.sections}  span=${span}`,
    );
    for (const problem of report.problems) console.log(`       ${problem}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
