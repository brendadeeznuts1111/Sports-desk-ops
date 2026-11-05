#!/usr/bin/env bun
/**
 * CI gate: domain ingestion fixture pins + strict replay verify (exit 4 on golden drift).
 * Does not require full replay exit 0 — domain JSONL intentionally triggers SLA exits.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  enrichIngestionJsonlRowWithXmlGoldenAst,
  exitCodeFromIngestionXmlGoldenAstStats,
  XML_GOLDEN_AST_REPLAY_DRIFT_EXIT,
} from "../lib/bun_xml_golden_ast_replay.ts";
import { goldenAstFingerprintFromXml } from "../lib/bun_xml_golden_ast.ts";
import { replaySportsdeskIngestionLog } from "../services/sportsdesk_ingestion_replay.ts";

const repoRoot = join(import.meta.dir, "..");
const domainJsonl = join(
  repoRoot,
  "tests/fixtures/ingestion-replay-domain.jsonl",
);
const manifestPath = join(
  repoRoot,
  "tests/fixtures/ingestion-replay-domain-xml-golden.json",
);

type Manifest = {
  bun_version: string;
  entries: { xml: string; sha256: string }[];
};

async function main(): Promise<number> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  for (const entry of manifest.entries) {
    const live = goldenAstFingerprintFromXml(entry.xml).sha256;
    if (live !== entry.sha256) {
      console.error(
        `[ingestion:replay-xml-golden-gate] manifest drift for xml ${entry.xml.slice(0, 24)}…`,
      );
      return XML_GOLDEN_AST_REPLAY_DRIFT_EXIT;
    }
  }

  // Intentional hand-rolled JSONL loop: the gate MUST throw on a malformed line; `Bun.JSONL.parse()`
  // would silently truncate the prefix. The non-string-xml branch also preserves the original line
  // text byte-for-byte (JSON.stringify would normalize). See
  // `docs/bun-upstream-reference.md` "When NOT to migrate to Bun.JSONL".
  const lines = readFileSync(domainJsonl, "utf8").trim().split("\n");
  const enriched = lines
    .filter((l) => l.trim())
    .map((line) => {
      const row = JSON.parse(line) as { xml?: string };
      if (typeof row.xml !== "string") return line;
      return JSON.stringify(
        enrichIngestionJsonlRowWithXmlGoldenAst(row as { xml: string }),
      );
    })
    .join("\n");

  const tmp = join(
    tmpdir(),
    `sportsdesk-ingestion-golden-gate-${process.pid}.jsonl`,
  );
  await Bun.write(tmp, `${enriched}\n`);

  const result = await replaySportsdeskIngestionLog({
    path: tmp,
    verifyXmlGoldenAst: true,
    strictXmlGoldenPins: true,
    // Match pins enriched on this runner (CI pins Bun via setup-bun; do not hardcode manifest.bun_version).
    expectedBunVersion: Bun.version,
    onXmlGoldenAstFailure: (message) => {
      console.error(message);
    },
  });

  const xmlRows = lines.filter((l) => {
    const row = JSON.parse(l) as { xml?: string };
    return typeof row.xml === "string";
  }).length;

  const goldenExit = exitCodeFromIngestionXmlGoldenAstStats(
    result.xmlGoldenAst,
  );
  if (goldenExit !== 0) {
    console.error(
      "[ingestion:replay-xml-golden-gate] xmlGoldenAst",
      JSON.stringify(result.xmlGoldenAst),
    );
    return goldenExit;
  }
  if (result.xmlGoldenAst.verified !== xmlRows) {
    console.error(
      `[ingestion:replay-xml-golden-gate] verified ${result.xmlGoldenAst.verified} !== ${xmlRows} xml rows`,
    );
    return XML_GOLDEN_AST_REPLAY_DRIFT_EXIT;
  }

  console.log(
    `ingestion:replay-xml-golden-gate: ok (${result.xmlGoldenAst.verified} pins, manifest ${manifest.entries.length} entries)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
