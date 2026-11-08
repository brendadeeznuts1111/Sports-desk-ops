#!/usr/bin/env bun
/**
 * @file scripts/check_doc_sentinels.ts
 * @description CI gate & operator tool to audit documents and templates for unresolved sentinels
 * and leaked production account handles.
 */

import { parseArgs } from "node:util";
import {
  checkUnresolvedSentinels,
  DEFAULT_SENSITIVE_PATTERNS,
} from "../lib/doc_template_hydrator.ts";

function printHelp(exitCode = 0): never {
  console.log(`
Usage:
  bun scripts/check_doc_sentinels.ts <file-or-doc-id> [OPTIONS]

Options:
  --template-mode       Verify that the file is a valid template (must use sentinels, no live PII)
  --strict-template     Fail with exit code 1 if template lacks placeholders/sentinels
  --doc-id              Treat input as a Google Doc ID rather than a local file path
  --help                Show this help message

Examples:
  bun scripts/check_doc_sentinels.ts docs/my-runbook.md
  bun scripts/check_doc_sentinels.ts 1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc --doc-id
  bun scripts/check_doc_sentinels.ts template.md --template-mode --strict-template
  gdocs readonly read <docId> --comments=false | bun scripts/check_doc_sentinels.ts -
  `);
  process.exit(exitCode);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "template-mode": { type: "boolean", default: false },
      "strict-template": { type: "boolean", default: false },
      "doc-id": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp(0);
  }

  const target = positionals[0];
  if (!target) {
    printHelp(0);
  }

  let content = "";

  if (target === "-") {
    content = await Bun.stdin.text();
  } else if (values["doc-id"]) {
    const agyAccount = Bun.env.AGY_ACCOUNT;
    if (!agyAccount) {
      console.error(
        "[check-doc-sentinels] Error: AGY_ACCOUNT environment variable is required to read Google Docs via CLI.",
      );
      process.exit(1);
    }

    console.log(`[check-doc-sentinels] Reading Google Doc ${target}...`);
    const proc = Bun.spawnSync(
      ["gdocs", "readonly", "read", target, "--comments=false"],
      {
        env: {
          PATH: Bun.env.PATH || "",
          HOME: Bun.env.HOME || "",
          AGY_ACCOUNT: agyAccount,
        },
      },
    );
    if (proc.exitCode !== 0) {
      console.error(
        "[check-doc-sentinels] Failed to read doc via gdocs directly:",
        proc.stderr?.toString() || proc.stdout?.toString(),
      );
      console.log(
        "[TIP] In Antigravity, use pipeline: gdocs readonly read <docID> | bun scripts/check_doc_sentinels.ts -",
      );
      process.exit(1);
    }
    content = proc.stdout ? proc.stdout.toString() : "";
  } else {
    const file = Bun.file(target);
    if (!(await file.exists())) {
      console.error(`[check-doc-sentinels] File not found: ${target}`);
      process.exit(1);
    }
    content = await file.text();
  }

  if (values["template-mode"]) {
    // Template mode: template MUST contain sentinels and MUST NOT contain raw secrets
    console.log(
      `[check-doc-sentinels] Auditing template hygiene for ${target}...`,
    );
    const check = checkUnresolvedSentinels(content, {
      allowUnresolved: true,
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    });

    if (!check.valid) {
      console.error(
        `\n❌ [FAILED] Template contains prohibited secrets/patterns:`,
      );
      for (const err of check.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    if (
      check.unresolvedPlaceholders.length === 0 &&
      check.sentinelsFound.length === 0
    ) {
      if (values["strict-template"]) {
        console.error(
          `\n❌ [FAILED] Template does not contain any {{PLACEHOLDER}} or SENTINEL_* tokens (--strict-template enabled).`,
        );
        process.exit(1);
      } else {
        console.warn(
          `[ADVISORY] Template does not appear to contain any {{PLACEHOLDER}} or SENTINEL_* tokens.`,
        );
      }
    } else {
      console.log(
        `✓ Template correctly uses ${check.unresolvedPlaceholders.length} placeholder(s) and ${check.sentinelsFound.length} sentinel token(s).`,
      );
    }
  } else {
    // Live / Instantiated mode: MUST NOT contain any unresolved sentinels or placeholders
    console.log(
      `[check-doc-sentinels] Auditing instantiated document hygiene for ${target}...`,
    );
    const check = checkUnresolvedSentinels(content, {
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    });

    if (!check.valid) {
      console.error(
        `\n❌ [FAILED] Document contains unresolved sentinels or security policy violations:`,
      );
      for (const err of check.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    console.log(
      `\n✅ [PASSED] Zero unresolved sentinels or placeholders found in ${target}.`,
    );
  }
}

main().catch((err) => {
  console.error("[ERROR]", err);
  process.exit(1);
});
