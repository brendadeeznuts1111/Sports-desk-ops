#!/usr/bin/env bun
/**
 * @file cli/bun_reference_cli.ts
 * @description CLI for the bun.sh/reference audit: fetch the reference tree, reconcile it against
 * the pinned runtime, and emit or verify the machine-readable contract (JSON manifest + JSON
 * Schema). Designed for headless agent use: every input is a flag, no writes without `--out`,
 * layered `--help`, and failures carry a copy-pasteable example.
 *
 *   bun cli/bun_reference_cli.ts audit
 *   bun cli/bun_reference_cli.ts audit --json --out scratch/bun-reference
 *   bun cli/bun_reference_cli.ts check --manifest scratch/bun-reference/reference-contract.json
 *   bun cli/bun_reference_cli.ts colours --manifest scratch/bun-reference/reference-contract.json
 *
 * Exit codes: 0 success/current, 1 drift or validation failure, 2 usage error, 3 network/audit error.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  renderReferenceMarkdown,
  runReferenceAudit,
  type ReferenceAuditResult,
  type ReferenceReport,
} from "../lib/bun_reference_audit.ts";
import {
  validateContractManifest,
  type ContractManifest,
} from "../lib/bun_reference_contract.ts";
import { REFERENCE_INDEX_URL } from "../lib/bun_reference_tree.ts";
import { bunRevisionComposite } from "../lib/bun_runtime.ts";

export const EXIT = {
  ok: 0,
  drift: 1,
  usage: 2,
  auditFailed: 3,
} as const;

const COMMAND_NAMES = [
  "audit",
  "check",
  "contract",
  "kinds",
  "colours",
  "help",
] as const;
export type Command = (typeof COMMAND_NAMES)[number];
/** Commands that carry data/options (everything except `help`). */
type DataCommand = Exclude<Command, "help">;

export class CliUsageError extends Error {}

/** Common to every action; `--version`, `--revision` and `--json` are global flags. */
interface ActionBase {
  readonly json: boolean;
  readonly version: boolean;
  readonly revision: boolean;
}

/**
 * Discriminated command model: each command carries exactly the options it accepts, so an invalid
 * combination (`check --out`, `contract` without a manifest) cannot be represented, and consumers
 * narrow on `command` instead of null-checking a shared bag of optional fields.
 */
export type CliAction =
  | (ActionBase & {
      readonly command: "help";
      readonly helpTopic: DataCommand | null;
    })
  | (ActionBase & {
      readonly command: "audit";
      readonly out: string | null;
      readonly noProbe: boolean;
      readonly quiet: boolean;
    })
  | (ActionBase & { readonly command: "check"; readonly manifest: string })
  | (ActionBase & {
      readonly command: "contract";
      readonly manifest: string | null;
      readonly schemaOnly: boolean;
    })
  | (ActionBase & { readonly command: "kinds"; readonly manifest: string })
  | (ActionBase & { readonly command: "colours"; readonly manifest: string });

/** Typed `--json` payloads (exported so tests and downstream tools can rely on the shape). */
export interface AuditJsonOutput {
  readonly report: ReferenceReport;
  readonly manifest: ContractManifest;
  readonly validation: { ok: boolean; errors: string[] };
  readonly schemaSelfTest: boolean;
  readonly sourceDigest: string;
}

export interface CheckJsonOutput {
  readonly current: boolean;
  readonly drift: string[];
  readonly digest: { manifest: string; fresh: string };
}
const HELP = {
  main: `bun-reference — audit bun.sh/reference against the pinned Bun runtime

Usage: bun cli/bun_reference_cli.ts <command> [options]

Commands:
  audit      Fetch and reconcile the reference tree; print a summary (writes only with --out)
  check      Re-fetch and compare against a contract manifest; exit 1 on drift
  contract   Validate a contract manifest, or print its JSON Schema
  kinds      Print the kind matrix from a contract manifest
  colours    Print the kind → badge colour contract from a contract manifest
  help       Show help (help <command> for one command)

Global options:
  --json      Machine-readable output on stdout
  --help, -h  This help, or a command's help
  --version   Print the CLI schema/version line
  --revision  Print the Bun runtime revision (same output as bun --revision)

Examples:
  bun cli/bun_reference_cli.ts audit
  bun cli/bun_reference_cli.ts audit --json --out scratch/bun-reference
  bun cli/bun_reference_cli.ts check --manifest scratch/bun-reference/reference-contract.json
  bun cli/bun_reference_cli.ts contract --schema
  bun cli/bun_reference_cli.ts --revision
  bun cli/bun_reference_cli.ts colours --manifest scratch/bun-reference/reference-contract.json`,

  audit: `audit — fetch the reference tree, reconcile against this Bun, derive the contract

Usage: bun cli/bun_reference_cli.ts audit [options]

Options:
  --out <dir>   Write reference-contract.json, reference-contract.schema.json,
                full-tree.json and full-tree.md into <dir> (created if absent)
  --json        Print { report, manifest, validation, schemaSelfTest, sourceDigest }
  --no-probe    Skip the bun:bundle child probe (faster; report says "probe disabled")
  --quiet       Only print the one-line result

Examples:
  bun cli/bun_reference_cli.ts audit
  bun cli/bun_reference_cli.ts audit --json
  bun cli/bun_reference_cli.ts audit --out scratch/bun-reference
  bun cli/bun_reference_cli.ts audit --no-probe --quiet`,

  check: `check — verify a contract manifest against a fresh audit (read-only)

Usage: bun cli/bun_reference_cli.ts check --manifest <path> [--json]

Options:
  --manifest <path>  Contract manifest to verify (required)
  --json             Print { current, drift: [keys], digest: { manifest, fresh } }

Exit codes: 0 current, 1 drift or invalid manifest, 2 usage error.

Examples:
  bun cli/bun_reference_cli.ts check --manifest scratch/bun-reference/reference-contract.json
  bun cli/bun_reference_cli.ts check --manifest ./reference-contract.json --json`,

  contract: `contract — validate a manifest, or print the JSON Schema (no network)

Usage: bun cli/bun_reference_cli.ts contract [--manifest <path>] [--schema] [--json]

Options:
  --manifest <path>  Contract manifest to validate (default: ./reference-contract.json)
  --schema           Print the JSON Schema generated from the same zod definition
  --json             Print the validated manifest (or schema) as JSON

Examples:
  bun cli/bun_reference_cli.ts contract
  bun cli/bun_reference_cli.ts contract --schema
  bun cli/bun_reference_cli.ts --revision
  bun cli/bun_reference_cli.ts contract --manifest scratch/bun-reference/reference-contract.json --json`,

  kinds: `kinds — print the kind matrix from a contract manifest (no network)

Usage: bun cli/bun_reference_cli.ts kinds --manifest <path> [--json]

Options:
  --manifest <path>  Contract manifest (required)
  --json             Print the kind matrix map as JSON

Examples:
  bun cli/bun_reference_cli.ts kinds --manifest scratch/bun-reference/reference-contract.json
  bun cli/bun_reference_cli.ts kinds --manifest ./reference-contract.json --json`,

  colours: `colours — print the kind → badge colour contract (no network)

Usage: bun cli/bun_reference_cli.ts colours --manifest <path> [--json]

Options:
  --manifest <path>  Contract manifest (required)
  --json             Print the kindColours object as JSON

Examples:
  bun cli/bun_reference_cli.ts colours --manifest scratch/bun-reference/reference-contract.json
  bun cli/bun_reference_cli.ts colours --manifest ./reference-contract.json --json`,
} as const;

const EXAMPLES: Record<string, string> = {
  audit: "bun cli/bun_reference_cli.ts audit --out scratch/bun-reference",
  check:
    "bun cli/bun_reference_cli.ts check --manifest scratch/bun-reference/reference-contract.json",
  contract:
    "bun cli/bun_reference_cli.ts contract --manifest ./reference-contract.json",
  kinds:
    "bun cli/bun_reference_cli.ts kinds --manifest ./reference-contract.json",
  colours:
    "bun cli/bun_reference_cli.ts colours --manifest ./reference-contract.json",
};

function fail(message: string, example: string): never {
  throw new CliUsageError(`${message}\n  ${example}`);
}

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(
      `${flag} needs a value`,
      `bun cli/bun_reference_cli.ts audit ${flag} <value>`,
    );
  }
  return value;
}

/** Parse argv into a validated action; throws CliUsageError with an example invocation. */
export function parseCliArgs(argv: readonly string[]): CliAction {
  let command: Command | null = null;
  let helpTopic: DataCommand | null = null;
  let out: string | null = null;
  let manifest: string | null = null;
  let json = false;
  let schemaOnly = false;
  let help = false;
  let noProbe = false;
  let quiet = false;
  let version = false;
  let revision = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--version") {
      version = true;
      continue;
    }
    if (token === "--revision") {
      revision = true;
      continue;
    }
    if (token === "--schema") {
      schemaOnly = true;
      continue;
    }
    if (token === "--no-probe") {
      noProbe = true;
      continue;
    }
    if (token === "--quiet") {
      quiet = true;
      continue;
    }
    if (token === "--out") {
      out = takeValue(argv, index, "--out");
      index += 1;
      continue;
    }
    if (token === "--manifest") {
      manifest = takeValue(argv, index, "--manifest");
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      fail(`unknown option: ${token}`, "bun cli/bun_reference_cli.ts --help");
    }
    if (command !== null) {
      if (command === "help" && helpTopic === null) {
        if (
          !(COMMAND_NAMES as readonly string[]).includes(token) ||
          token === "help"
        ) {
          fail(
            `unknown help topic: ${token}`,
            "bun cli/bun_reference_cli.ts help audit",
          );
        }
        helpTopic = token as DataCommand;
        continue;
      }
      fail(
        `unexpected argument: ${token}`,
        `bun cli/bun_reference_cli.ts ${command} --help`,
      );
    }
    if (!(COMMAND_NAMES as readonly string[]).includes(token)) {
      fail(
        `unknown command: ${token}`,
        `bun cli/bun_reference_cli.ts <${COMMAND_NAMES.join("|")}> (try --help)`,
      );
    }
    command = token as Command;
  }

  // `--help` wins over the command's normal action, but keeps its topic: `audit --help`.
  if (help || command === null || command === "help") {
    const topic =
      command === "help"
        ? helpTopic
        : command === null
          ? null
          : (command as DataCommand);
    return { command: "help", helpTopic: topic, json, version, revision };
  }

  if (version || revision) {
    // Both are global informational flags; normalize them to the help action so a data command
    // never carries them and the union stays consistent (`audit --version` vs `audit --revision`).
    return { command: "help", helpTopic: null, json, version, revision };
  }

  if (command !== "audit" && out !== null) {
    fail(
      `--out is only valid for audit`,
      "bun cli/bun_reference_cli.ts audit --out <dir>",
    );
  }
  if (command !== "contract" && schemaOnly) {
    fail(
      `--schema is only valid for contract`,
      "bun cli/bun_reference_cli.ts contract --schema",
    );
  }
  if (command !== "audit" && quiet) {
    fail(
      `--quiet is only valid for audit`,
      "bun cli/bun_reference_cli.ts audit --quiet",
    );
  }

  if (command === "audit") {
    return { command, json, version, revision, out, noProbe, quiet };
  }
  if (command === "contract") {
    return { command, json, version, revision, manifest, schemaOnly };
  }
  if (manifest === null) {
    fail(
      `--manifest <path> is required for ${command}`,
      EXAMPLES[command] ?? "bun cli/bun_reference_cli.ts --help",
    );
  }
  return { command, json, version, revision, manifest };
}

function helpFor(command: Command | "help" | null): string {
  if (command === null || command === "help") return HELP.main;
  return HELP[command];
}

export function renderAuditSummary(result: ReferenceAuditResult): string {
  const { report } = result;
  const contract = report.kindColours.contract
    .map((row) => `${row.name}=${row.alias}/${row.colour}`)
    .join(" ");
  return [
    `bun-reference audit · runtime ${report.runtime} · ${report.modules} modules · ${report.distinctPairs} (module, symbol) pairs · ${report.distinctNames} unique names`,
    `module index: /reference (${report.moduleSource.landing.length}) vs sidebar (${report.moduleSource.sidebar.length}) → ${report.moduleSource.match ? "identical" : "MISMATCH"}`,
    `kind contract: ${contract || "(none)"}`,
    `badges: ${report.badges.total} · matched ${report.badges.matched} · unmatched ${report.badges.unmatched} · kind/badge mismatches ${report.kindColours.mismatches.length}`,
    `contract: validated=${result.validation.ok} (${result.validation.errors.length} issue(s)) · schema self-test=${result.schemaSelfTest} · digest ${result.sourceDigest.slice(0, 16)}…`,
  ].join("\n");
}

function renderKinds(manifest: ContractManifest): string {
  const verdicts = Object.keys(manifest.counts);
  const header = ["kind", "documented", ...verdicts].join(" | ");
  const divider = `${"-".repeat(header.length)}`;
  const rows = Object.entries(manifest.kindMatrix)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, counts]) => {
      const documented = Object.values(counts).reduce(
        (total, n) => total + n,
        0,
      );
      return [
        kind,
        String(documented),
        ...verdicts.map((verdict) => String(counts[verdict] ?? 0)),
      ].join(" | ");
    });
  return [header, divider, ...rows].join("\n");
}

function renderColours(manifest: ContractManifest): string {
  const { contract, observed, conflicts, colourConflicts, mismatches } =
    manifest.kindColours;
  return [
    "kind (name) | alias | colour | count",
    "---|---|---|---",
    ...contract.map(
      (row) => `${row.name} | ${row.alias} | ${row.colour} | ${row.count}`,
    ),
    "",
    "observed: " +
      observed
        .map((row) => `${row.alias}/${row.colour}×${row.count}`)
        .join("  "),
    `alias conflicts: ${conflicts.length} · colour conflicts: ${colourConflicts.length} · kind/badge mismatches: ${mismatches.length}`,
  ].join("\n");
}

async function loadManifest(path: string): Promise<ContractManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    fail(
      `contract manifest not found: ${path}`,
      "bun cli/bun_reference_cli.ts audit --out scratch/bun-reference",
    );
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    fail(
      `contract manifest is not valid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`,
      "bun cli/bun_reference_cli.ts contract --manifest <path>",
    );
  }
  const validated = validateContractManifest(raw);
  if (!validated.ok) {
    throw new CliUsageError(
      `contract manifest is invalid:\n${validated.errors.map((error) => `  ${error}`).join("\n")}\n  ${EXAMPLES.contract}`,
    );
  }
  return validated.manifest;
}

/** Keys whose normalized value differs (generatedAt excluded — it changes every audit). */
export function manifestDrift(
  existing: ContractManifest,
  fresh: ContractManifest,
): string[] {
  const normalize = (manifest: ContractManifest) => {
    const copy = { ...manifest } as Record<string, unknown>;
    delete copy.generatedAt;
    return copy;
  };
  const left = normalize(existing) as Record<string, unknown>;
  const right = normalize(fresh) as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort();
}

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/** Run one CLI invocation; returns the process exit code (testable, no process.exit). */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  let action: CliAction;
  try {
    action = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`Error: ${error.message}`);
      return EXIT.usage;
    }
    throw error;
  }

  if (action.version) {
    io.stdout("bun-reference cli v1 · manifest schema draft 2020-12");
  }
  if (action.revision) {
    // Match `bun --revision` exactly, from the repo's single runtime-revision helper.
    const composite = bunRevisionComposite();
    if (action.json) {
      io.stdout(
        JSON.stringify(
          {
            version: Bun.version,
            revision: Bun.revision,
            composite,
          },
          null,
          2,
        ),
      );
    } else {
      io.stdout(composite);
    }
  }
  if (action.version || action.revision) return EXIT.ok;

  if (action.command === "help") {
    io.stdout(helpFor(action.helpTopic));
    return EXIT.ok;
  }

  /** loadManifest throws CliUsageError; convert it to exit 2 here, where io is available. */
  const load = async (path: string): Promise<ContractManifest | null> => {
    try {
      return await loadManifest(path);
    } catch (error) {
      if (error instanceof CliUsageError) {
        io.stderr(`Error: ${error.message}`);
        return null;
      }
      throw error;
    }
  };

  if (action.command === "contract") {
    if (action.schemaOnly) {
      const { contractSchema } =
        await import("../lib/bun_reference_contract.ts");
      const schema = contractSchema();
      io.stdout(
        action.json
          ? JSON.stringify(schema, null, 2)
          : `JSON Schema (draft 2020-12): ${String(schema.$id ?? "")}\nUse --json to print it.`,
      );
      return EXIT.ok;
    }
    const manifest = await load(action.manifest ?? "./reference-contract.json");
    if (manifest === null) return EXIT.usage;
    if (action.json) io.stdout(JSON.stringify(manifest, null, 2));
    else {
      io.stdout(
        `contract manifest valid · ${manifest.modules} modules · ${manifest.distinctPairs} pairs · ${manifest.source.digest.slice(0, 16)}…`,
      );
      io.stdout(renderAuditContractLine(manifest));
    }
    return EXIT.ok;
  }

  if (action.command === "kinds" || action.command === "colours") {
    const manifest = await load(action.manifest);
    if (manifest === null) return EXIT.usage;
    if (action.json) {
      io.stdout(
        JSON.stringify(
          action.command === "kinds"
            ? manifest.kindMatrix
            : manifest.kindColours,
          null,
          2,
        ),
      );
    } else {
      io.stdout(
        action.command === "kinds"
          ? renderKinds(manifest)
          : renderColours(manifest),
      );
    }
    return EXIT.ok;
  }

  // audit / check — the only commands that fetch.
  let result: ReferenceAuditResult;
  try {
    result = await runReferenceAudit({
      probe: action.command === "audit" ? !action.noProbe : false,
    });
  } catch (error) {
    io.stderr(
      `Error: audit failed: ${error instanceof Error ? error.message : String(error)}\n  Check network access to ${REFERENCE_INDEX_URL}`,
    );
    return EXIT.auditFailed;
  }

  if (!result.validation.ok) {
    if (action.json)
      io.stdout(JSON.stringify({ validation: result.validation }, null, 2));
    else {
      io.stderr(
        `contract manifest failed validation: ${result.validation.errors.join("; ")}`,
      );
    }
    return EXIT.drift;
  }

  if (action.command === "check") {
    const existing = await load(action.manifest);
    if (existing === null) return EXIT.usage;
    const drift = manifestDrift(existing, result.manifest);
    if (action.json) {
      io.stdout(
        JSON.stringify(
          {
            current: drift.length === 0,
            drift,
            digest: {
              manifest: existing.source.digest,
              fresh: result.sourceDigest,
            },
          },
          null,
          2,
        ),
      );
    } else if (drift.length === 0) {
      io.stdout(`current · digest ${result.sourceDigest.slice(0, 16)}…`);
    } else {
      const digestChanged = existing.source.digest !== result.sourceDigest;
      io.stderr(
        [
          `contract drift (${drift.length} key(s)): ${drift.join(", ")}`,
          digestChanged
            ? `  source digest: ${existing.source.digest.slice(0, 16)}… → ${result.sourceDigest.slice(0, 16)}…`
            : `  source digest unchanged (${result.sourceDigest.slice(0, 16)}…); the committed manifest content differs from a fresh audit`,
        ].join("\n"),
      );
    }
    return drift.length === 0 ? EXIT.ok : EXIT.drift;
  }

  // audit
  if (action.json) {
    const payload: AuditJsonOutput = {
      report: result.report,
      manifest: result.manifest,
      validation: result.validation,
      schemaSelfTest: result.schemaSelfTest,
      sourceDigest: result.sourceDigest,
    };
    io.stdout(JSON.stringify(payload, null, 2));
  } else if (!action.quiet) {
    io.stdout(renderAuditSummary(result));
  }

  if (action.out !== null) {
    const dir = action.out;
    await mkdir(dir, { recursive: true });
    const manifestPath = join(dir, "reference-contract.json");
    const schemaPath = join(dir, "reference-contract.schema.json");
    const reportPath = join(dir, "full-tree.json");
    const markdownPath = join(dir, "full-tree.md");
    await Bun.write(
      manifestPath,
      `${JSON.stringify(result.manifest, null, 2)}\n`,
    );
    await Bun.write(schemaPath, `${JSON.stringify(result.schema, null, 2)}\n`);
    await Bun.write(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
    await Bun.write(
      markdownPath,
      renderReferenceMarkdown(result, { manifestState: "written" }),
    );
    io.stdout(
      [
        `wrote: ${manifestPath}`,
        `       ${schemaPath}`,
        `       ${reportPath}`,
        `       ${markdownPath}`,
      ].join("\n"),
    );
  }
  return EXIT.ok;
}

function renderAuditContractLine(manifest: ContractManifest): string {
  return manifest.kindColours.contract
    .map((row) => `${row.name}=${row.alias}/${row.colour}`)
    .join(" ");
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
