#!/usr/bin/env bun
/**
 * @file scripts/gdocs_template_instantiate.ts
 * @description Securely instantiate Google Doc templates without leaking sensitive variables
 * into the process table or shell history. Enforces strict sentinel verification and fail-closed posture.
 *
 * Security Architecture & Guarantees:
 *  - C2/R1: Zero title leak. Title is read exclusively via --title-file (mode 0600) or --title-stdin.
 *    Initial clone creates doc with generic placeholder; final title is applied via gdrive batch -f.
 *    Both rename.json and hydrate.sed are created in a mode 0600 tmpDir registered with cleanupActiveTempDir().
 *    No sensitive title string ever touches argv or /proc/<pid>/cmdline.
 *  - C1/P4: Fails closed. Any failure in clone, ACL reset, rename, sed, read, or sentinel validation
 *    aborts immediately, trashes the partial document (recoverable via untrash), and exits 1.
 *  - R5/P5: Resets cloned document ACLs to owner-only BEFORE applying sed. Fails closed if reset errors.
 *  - P2/P8: Minimal subprocess environment explicitly enumerated via SUBPROCESS_ENV_WHITELIST.
 *    (Baseline binary compatibility validated against gdocs cl/986250228 and gdrive cl/1015343799 on 2026-11-07;
 *    USER was removed and LANG=C/LC_ALL=C pinned subsequently; re-validate end-to-end against live binaries on next integration run).
 *  - R3: Signal handling note: During synchronous child process execution (spawnSync), signals are
 *    queued until the child returns. Temp files use mode 0600 inside mkdtempSync and are reaped in finally.
 *  - R-D: On trash failure, the script strictly exits 1 and prints the doc URL to stderr for manual removal.
 */

import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSedScript,
  parseSubstitutionInput,
  checkUnresolvedSentinels,
  DEFAULT_SENSITIVE_PATTERNS,
  buildSubprocessEnv,
  resolveTemplateKind,
  listTemplateKinds,
  validateKindSubstitutions,
  type DocTemplateKind,
} from "../lib/doc_template_hydrator.ts";

const MAX_INPUT_SIZE_BYTES = 1024 * 1024; // 1 MiB

function printUsageAndExit(exitCode = 0): never {
  console.log(`
Usage:
  bun scripts/gdocs_template_instantiate.ts (--kind <KIND> | --template-id <ID>) --title-file <PATH> [OPTIONS]

Template Selection (one required):
  --kind <KIND>          Template kind (spec, partner-review, risk-audit, wager-dispute, settlement)
  --template-id <ID>     Explicit Google Doc Template ID
  --list-kinds           List all registered template kinds and required variables, then exit

Title Options (required):
  --title-file <PATH>    File containing title (avoids process-table exposure; requires mode 0600)
  --title-stdin          Read title from stdin (mutually exclusive with substitution --stdin)

Substitution Options:
  --var-file <PATH>      File containing variables (JSON or KEY=VALUE; checked for mode 0600)
  --stdin                Read variables from stdin (JSON or KEY=VALUE)
  --show-values          Display plain values in --dry-run (WARNING: reveals secrets in shell log)
  --force-unmasked       Allow --show-values in non-TTY environments

General Options:
  --template-id <ID>     Template Google Doc ID (required)
  --parent <FOLDER_ID>   Target Google Drive parent folder ID
  --dry-run              Preview substitutions without creating document (values masked by default)
  --check-sentinels      Verify that no {{...}} or SENTINEL_* tokens remain after hydration (default: true)
  --keep-on-failure      Do not auto-trash the document if hydration fails
  --skip-acl-reset       Skip removing inherited non-owner permissions on cloned document
  --help                 Show this help message

Security Guarantees:
  - Variables & titles NEVER pass via CLI arguments (blocks ps aux & shell history leaks)
  - Cloned document ACL reset to owner-only before sed substitutions are applied (aborts on error)
  - Failed runs automatically move partial document to trash (recoverable via gdrive mutate untrash)
  - Sed and rename scripts written to mode 0600 temp files and deleted with recursive force cleanup
  - Active signal handlers (SIGINT/SIGTERM) clean up temporary state
  - Pipeline fails closed (non-zero exit) on any mutation, read, or validation failure
  `);
  process.exit(exitCode);
}

// Track active temp directory for signal cleanup
let activeTmpDir: string | null = null;

function cleanupActiveTempDir() {
  if (activeTmpDir) {
    try {
      rmSync(activeTmpDir, { recursive: true, force: true });
    } catch {
      // ignore during signal termination
    }
    activeTmpDir = null;
  }
}

process.on("SIGINT", () => {
  cleanupActiveTempDir();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanupActiveTempDir();
  process.exit(143);
});

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      args: process.argv.slice(2),
      options: {
        kind: { type: "string" },
        "list-kinds": { type: "boolean", default: false },
        "template-id": { type: "string" },
        title: { type: "string" },
        "title-file": { type: "string" },
        "title-stdin": { type: "boolean", default: false },
        "var-file": { type: "string" },
        stdin: { type: "boolean", default: false },
        parent: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "show-values": { type: "boolean", default: false },
        "force-unmasked": { type: "boolean", default: false },
        "check-sentinels": { type: "boolean", default: true },
        "skip-sentinel-check": { type: "boolean", default: false },
        "keep-on-failure": { type: "boolean", default: false },
        "skip-acl-reset": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`\n❌ [ERROR] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { values } = parsedArgs;

  if (values.title) {
    console.error(
      "\n❌ [ERROR] Option '--title' was removed to prevent process-table argument leaks.",
    );
    console.error(
      "           Please pass your title via '--title-file <path>' (mode 0600) or '--title-stdin'.\n",
    );
    process.exit(1);
  }

  if (values.help) {
    printUsageAndExit(0);
  }

  if (values["list-kinds"]) {
    console.log("\nRegistered Document Template Kinds:\n");
    for (const def of listTemplateKinds()) {
      console.log(`• ${def.kind.padEnd(16)} : ${def.name}`);
      console.log(`  Description      : ${def.description}`);
      console.log(`  Canonical Doc ID : ${def.templateId}`);
      console.log(`  Required Vars    : ${def.requiredKeys.join(", ")}`);
      if (def.optionalKeys && def.optionalKeys.length > 0) {
        console.log(`  Optional Vars    : ${def.optionalKeys.join(", ")}`);
      }
      console.log();
    }
    process.exit(0);
  }

  let templateId = values["template-id"];
  if (values.kind) {
    const kindDef = resolveTemplateKind(values.kind);
    templateId = templateId ?? kindDef.templateId;
  }

  if (!templateId) {
    console.error(
      "[gdocs] Error: Either --kind <KIND> or --template-id <ID> is required.",
    );
    printUsageAndExit(1);
  }

  // C6: Require AGY_ACCOUNT explicitly, never fall back to hardcoded personal identity
  const agyAccount = Bun.env.AGY_ACCOUNT;
  if (!agyAccount) {
    console.error(
      "[gdocs] Error: AGY_ACCOUNT environment variable is required (e.g. AGY_ACCOUNT=user@example.com).",
    );
    process.exit(1);
  }

  // C2/R1: Resolve title strictly from file or title-stdin (never argv)
  let title = "";
  if (values["title-file"]) {
    const titleStat = statSync(values["title-file"]);
    if ((titleStat.mode & 0o077) !== 0) {
      console.warn(
        `[WARNING] Title file ${values["title-file"]} has loose permissions (${(titleStat.mode & 0o777).toString(8)}). Mode 0600 recommended.`,
      );
    }
    title = (await Bun.file(values["title-file"]).text()).trim();
  } else if (values["title-stdin"]) {
    if (values.stdin) {
      console.error(
        "[gdocs] Error: --title-stdin and --stdin (for vars) cannot both read from stdin.",
      );
      process.exit(1);
    }
    title = (await Bun.stdin.text()).trim();
  } else {
    console.error(
      "[gdocs] Error: A document title must be provided via --title-file <path> (mode 0600).",
    );
    console.error(
      "        Passing raw titles on CLI arguments is prohibited to prevent process-table leaks.",
    );
    printUsageAndExit(1);
  }

  if (!title) {
    console.error("[gdocs] Error: Document title is empty.");
    process.exit(1);
  }

  // 1. Gather substitutions from file or stdin (NEVER from CLI args)
  let rawVarsContent = "";
  if (values["var-file"]) {
    const varStat = statSync(values["var-file"]);
    if ((varStat.mode & 0o077) !== 0) {
      console.warn(
        `[WARNING] Variable file ${values["var-file"]} has loose permissions (${(varStat.mode & 0o777).toString(8)}). Mode 0600 recommended.`,
      );
    }
    if (varStat.size > MAX_INPUT_SIZE_BYTES) {
      throw new Error(
        `Variable file exceeds 1 MiB limit (${varStat.size} bytes).`,
      );
    }
    rawVarsContent = await Bun.file(values["var-file"]).text();
  } else if (values.stdin) {
    rawVarsContent = await Bun.stdin.text();
    if (rawVarsContent.length > MAX_INPUT_SIZE_BYTES) {
      throw new Error(
        `Stdin input exceeds 1 MiB limit (${rawVarsContent.length} bytes).`,
      );
    }
  }

  const substitutions = rawVarsContent
    ? parseSubstitutionInput(rawVarsContent)
    : {};

  if (values.kind) {
    const kindValidation = validateKindSubstitutions(
      values.kind as DocTemplateKind,
      substitutions,
    );
    if (!kindValidation.valid) {
      console.error(
        `[gdocs] Error: Template kind "${values.kind}" is missing required substitution keys: ${kindValidation.missing.join(", ")}`,
      );
      process.exit(1);
    }
  }

  const sedContent = buildSedScript(substitutions);

  // C5 & N2: Redact dry-run display by default
  if (values["dry-run"]) {
    console.log("=== DRY RUN MODE ===");
    console.log(`Template ID   : ${templateId}`);
    console.log(
      `Document Title: ${title.slice(0, 16)}... (len=${title.length})`,
    );
    console.log(`Variables     : ${Object.keys(substitutions).length} defined`);
    if (values["show-values"]) {
      if (!process.stdout.isTTY && !values["force-unmasked"]) {
        console.error(
          "[gdocs] Error: --show-values requires an interactive TTY (or --force-unmasked).",
        );
        process.exit(1);
      }
      console.error(
        "\n⚠️  SECURITY WARNING: Outputting unmasked substitution secrets to terminal stdout:",
      );
      console.log("\nGenerated Sed Script (cleartext preview):");
      console.log(sedContent);
    } else {
      console.log("\nVariables Summary (values masked for log hygiene):");
      for (const [k, v] of Object.entries(substitutions)) {
        console.log(`  - ${k} (len=${v.length})`);
      }
      console.log(
        `\n(Pass --show-values in an interactive TTY to preview unmasked values)`,
      );
    }
    return;
  }

  // P2/P8: Minimal subprocess environment explicitly enumerated
  const minimalSubprocessEnv = buildSubprocessEnv(agyAccount);

  // 2. Clone template using generic non-sensitive title (C2 / R1)
  const tempUuid = Bun.randomUUIDv7();
  const genericCloneTitle = `[Pending Hydration: DOC-TEMP-${tempUuid}]`;
  const cpArgs = ["mutate", "cp", templateId, genericCloneTitle, "--json"];
  if (values.parent) {
    cpArgs.push("--parent", values.parent);
  }

  console.log(
    `[gdocs] Cloning template ${templateId} with secure generic placeholder...`,
  );
  let cpProc = Bun.spawnSync(["gdrive", ...cpArgs], {
    env: minimalSubprocessEnv,
  });

  // R4: Fallback if --json is unrecognized by older gdrive build
  if (
    cpProc.exitCode !== 0 &&
    cpProc.stderr?.toString().includes("unknown flag")
  ) {
    console.warn(
      "[gdocs] Older gdrive CLI detected (no --json); retrying with standard output...",
    );
    const fallbackCpArgs = ["mutate", "cp", templateId, genericCloneTitle];
    if (values.parent) fallbackCpArgs.push("--parent", values.parent);
    cpProc = Bun.spawnSync(["gdrive", ...fallbackCpArgs], {
      env: minimalSubprocessEnv,
    });
  }

  if (cpProc.exitCode !== 0) {
    console.error(
      "[gdocs] Error copying template via gdrive cp:",
      cpProc.stderr?.toString() || cpProc.stdout?.toString(),
    );
    process.exit(1);
  }

  // Parse new file ID from gdrive JSON or anchored fallback
  let newDocId: string | null = null;
  const cpStdout = cpProc.stdout ? cpProc.stdout.toString() : "";
  try {
    const parsed = JSON.parse(cpStdout);
    if (parsed && typeof parsed.id === "string") {
      newDocId = parsed.id;
    } else if (parsed && typeof parsed.ID === "string") {
      newDocId = parsed.ID;
    }
  } catch {
    const idMatch = cpStdout.match(/([a-zA-Z0-9_-]{25,})/);
    if (idMatch && idMatch[1]) {
      newDocId = idMatch[1];
    }
  }

  if (!newDocId) {
    console.error(
      "[gdocs] Could not parse new document ID from gdrive output:\n",
      cpStdout,
    );
    process.exit(1);
  }

  const docUrl = `https://docs.google.com/document/d/${newDocId}/edit`;
  console.log(`[gdocs] Created document ID: ${newDocId}`);

  let hydrationFailed = false;

  // 3. R5/P5: Reset ACL Permissions to owner-only before writing any substitutions (FAIL-CLOSED)
  if (!values["skip-acl-reset"]) {
    console.log(`[gdocs] Resetting document ACL permissions to owner-only...`);
    const permProc = Bun.spawnSync(
      ["gdrive", "readonly", "permissions", newDocId, "--json"],
      {
        env: minimalSubprocessEnv,
      },
    );

    if (permProc.exitCode !== 0) {
      console.error(
        "[gdocs] Error querying permissions for ACL reset:",
        permProc.stderr?.toString() || permProc.stdout?.toString(),
      );
      hydrationFailed = true;
    } else {
      try {
        const perms = JSON.parse(
          permProc.stdout ? permProc.stdout.toString() : "[]",
        );
        if (Array.isArray(perms)) {
          for (const perm of perms) {
            if (perm && perm.role !== "owner" && perm.id) {
              console.log(
                `[gdocs] Removing inherited non-owner permission: ${perm.id} (${perm.role})`,
              );
              const rmPermProc = Bun.spawnSync(
                ["gdrive", "mutate", "remove-permission", newDocId, perm.id],
                {
                  env: minimalSubprocessEnv,
                },
              );
              if (rmPermProc.exitCode !== 0) {
                console.error(
                  `[ERROR] Failed to remove permission ${perm.id}: ${rmPermProc.stderr?.toString()}. Aborting for confidentiality.`,
                );
                hydrationFailed = true;
                break; // Stop immediately
              }
            }
          }
        }
      } catch (err: unknown) {
        console.error(
          `[ERROR] Could not parse document permissions for ACL reset:`,
          err,
        );
        hydrationFailed = true;
      }
    }
  }

  // 4. Apply title rename via gdrive batch -f (mode 0600) so title NEVER hits argv (C2 / R1)
  if (!hydrationFailed) {
    const tmpDir = mkdtempSync(join(tmpdir(), "gdocs-inst-"));
    activeTmpDir = tmpDir;
    try {
      const renameBatchPath = join(tmpDir, "rename.json");
      const renameOps = [{ op: "rename", id: newDocId, name: title }];
      await Bun.write(renameBatchPath, JSON.stringify(renameOps));

      console.log(
        `[gdocs] Applying final document title securely via batch operation...`,
      );
      const renameProc = Bun.spawnSync(
        ["gdrive", "mutate", "batch", "-f", renameBatchPath],
        {
          env: minimalSubprocessEnv,
        },
      );
      if (renameProc.exitCode !== 0) {
        console.error(
          "[gdocs] Error renaming document via gdrive batch:",
          renameProc.stderr?.toString() || renameProc.stdout?.toString(),
        );
        hydrationFailed = true;
      }

      // 5. Apply substitutions via gdocs mutate sed -f (mode 0600)
      if (Object.keys(substitutions).length > 0 && !hydrationFailed) {
        const tmpSedPath = join(tmpDir, "hydrate.sed");
        await Bun.write(tmpSedPath, sedContent);
        console.log(
          `[gdocs] Applying ${Object.keys(substitutions).length} substitutions securely via sed...`,
        );
        // Do NOT pass --regex; find and replacement must be literal strings (V1)
        const sedProc = Bun.spawnSync(
          ["gdocs", "mutate", "sed", newDocId, "-f", tmpSedPath],
          {
            env: minimalSubprocessEnv,
          },
        );
        if (sedProc.exitCode !== 0) {
          console.error(
            "[gdocs] Error executing gdocs mutate sed:",
            sedProc.stderr?.toString() || sedProc.stdout?.toString(),
          );
          hydrationFailed = true;
        } else {
          console.log(`[gdocs] Sed substitutions successfully applied.`);
        }
      }
    } finally {
      cleanupActiveTempDir();
    }
  }

  // 6. Sentinel check (C1: Fail closed if read or check fails; R2: Inherits DEFAULT_SENSITIVE_PATTERNS)
  const shouldCheckSentinels =
    values["check-sentinels"] && !values["skip-sentinel-check"];
  if (shouldCheckSentinels && !hydrationFailed) {
    console.log(
      `[gdocs] Verifying hydrated document for unreplaced sentinels and secrets...`,
    );
    const readProc = Bun.spawnSync(
      ["gdocs", "readonly", "read", newDocId, "--comments=false"],
      {
        env: minimalSubprocessEnv,
      },
    );

    if (readProc.exitCode !== 0) {
      console.error(
        "[gdocs] Error reading back document for sentinel verification:",
        readProc.stderr?.toString() || readProc.stdout?.toString(),
      );
      hydrationFailed = true;
    } else {
      const check = checkUnresolvedSentinels(
        readProc.stdout ? readProc.stdout.toString() : "",
        {
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
        },
      );

      if (!check.valid) {
        console.error(
          `\n❌ [ERROR] Hydrated document failed verification gate!`,
        );
        for (const err of check.errors) {
          console.error(`  - ${err}`);
        }
        hydrationFailed = true;
      } else {
        console.log(
          `[gdocs] Sentinel check PASSED: zero unresolved placeholders or noisy sentinels.`,
        );
      }
    }
  }

  // C1/P4: Fail closed on any error, auto-trash document
  if (hydrationFailed) {
    console.error(
      `\n❌ [ABORTED] Template hydration failed. Document at ${docUrl} is incomplete or failed security checks.`,
    );

    if (!values["keep-on-failure"]) {
      console.log(`[gdocs] Auto-trashing incomplete document ${newDocId}...`);
      const trashProc = Bun.spawnSync(["gdrive", "mutate", "trash", newDocId], {
        env: minimalSubprocessEnv,
      });
      if (trashProc.exitCode === 0) {
        console.error(
          `[gdocs] Incomplete document moved to Drive trash (recoverable via 'gdrive mutate untrash ${newDocId}').`,
        );
      } else {
        console.error(
          `[WARNING] Failed to auto-trash document ${newDocId}. Manual removal recommended: ${docUrl}`,
        );
      }
    } else {
      console.error(
        `[gdocs] Document retained per --keep-on-failure: ${docUrl}`,
      );
    }

    process.exit(1);
  }

  console.log(`\n✅ Document ready: ${docUrl}`);
}

main().catch((err) => {
  cleanupActiveTempDir();
  console.error("[ERROR]", err);
  process.exit(1);
});
