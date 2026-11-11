#!/usr/bin/env bun
/**
 * Operator & CI CLI for `packages/nsh-desk` (`https://nsh.dev/docs/cli/`),
 * implemented natively on Bun's `Bun` global namespace (`/reference/globals/bun`):
 *   - `Bun.file(...)` async file probes & byte/JSON/text loading (zero `node:fs`)
 *   - `Bun.which(...)` binary discovery with explicit `PATH`
 *   - `Bun.spawn(...)` + `Bun.nanoseconds()` high-resolution step timing
 *   - `Bun.semver.satisfies(...)` / `Bun.semver.order(...)` runtime version checks
 *   - `Bun.CryptoHasher("sha256")` + `Bun.Glob` build/package artifact digests
 *   - `Bun.stripANSI(...)` output stream parser (`✓`, `→`, `•`, `warn`, `error`, logs)
 *   - `[Bun.inspect.custom]` + `Bun.inspect.table(...)` + `Bun.stringWidth` (`padDisplay`)
 *   - `import { YAML } from "bun"` (`YAML.parse` skill frontmatter & `YAML.stringify` `--yaml` reports)
 */

import { YAML } from "bun";
import path from "node:path";
import {
  type BunInspectOptions,
  cliInspectOptions,
  inspectReport,
  padDisplay,
} from "../lib/cli_inspect.ts";
import { resolveDeskOrigin } from "../packages/nsh-desk/desk_model.ts";

export interface ResolvedNshBinary {
  readonly bin: string;
  readonly source:
    "env:NSH_BIN" | "PATH" | "workspace:.agents/tools/nsh" | "home:.nsh";
}

export interface ParsedNshVersion {
  readonly raw: string;
  readonly semver: string | null;
  readonly gitSha: string | null;
}

export type NshProjectMode = "tsx" | "mixed" | "rust";

export interface NshManifestSummary {
  readonly name: string | null;
  readonly id: string | null;
  readonly version: string | null;
  readonly build: number | null;
  readonly minRuntime: string | null;
  readonly theme: string | null;
  readonly appearance: string | null;
  readonly mode: NshProjectMode;
  readonly hasRust: boolean;
  readonly hasRoot: boolean;
  readonly capabilityKeys: readonly string[];
}

export interface ParsedNshCliOutput {
  readonly steps: readonly string[];
  readonly urls: readonly string[];
  readonly events: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly logs: readonly string[];
}

export type NshArtifactKind =
  | "bytecode"
  | "js-bundle"
  | "sourcemap"
  | "capabilities"
  | "app-metadata"
  | "nshpkg"
  | "web-asset"
  | "other";

export interface NshBuildArtifactEntry {
  readonly relativePath: string;
  readonly kind: NshArtifactKind;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NshArtifactsInventory {
  readonly outDir: string;
  readonly exists: boolean;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly artifacts: readonly NshBuildArtifactEntry[];
}

export interface NshDoctorCheck {
  readonly check: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface NshDoctorReportData {
  readonly ok: boolean;
  readonly appDir: string;
  readonly binary: ResolvedNshBinary | null;
  readonly version: ParsedNshVersion | null;
  readonly bunVersion: string;
  readonly manifest: NshManifestSummary | null;
  readonly origin:
    | { readonly ok: true; readonly origin: string; readonly source: string }
    | { readonly ok: false; readonly error: string };
  readonly checks: readonly NshDoctorCheck[];
}

export interface NshVerifyStepResult {
  readonly step: "check" | "build" | "test";
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stepCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface NshVerifyLoopReportData {
  readonly ok: boolean;
  readonly allowWarnings: boolean;
  readonly totalDurationMs: number;
  readonly steps: readonly NshVerifyStepResult[];
}

export type CliReportFormat = "inspect" | "json" | "yaml";

export interface ParsedSkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

/**
 * Parses YAML 1.2 frontmatter (`--- ... ---`) from a `SKILL.md` document via
 * `import { YAML } from "bun"` (`YAML.parse`).
 */
export function parseSkillFrontmatterYaml(
  markdown: string,
): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || match[1] === undefined) {
    throw new Error("missing YAML frontmatter delimiter (---)");
  }
  const parsed: unknown = YAML.parse(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must parse to a key-value mapping");
  }
  const rec = parsed as Record<string, unknown>;
  const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
  const description =
    typeof rec["description"] === "string" ? rec["description"].trim() : "";
  if (name.length === 0 || description.length === 0) {
    throw new Error(
      "YAML frontmatter requires non-empty 'name' and 'description'",
    );
  }
  return { name, description };
}

export function resolveCliReportFormat(
  tokens: readonly string[],
): CliReportFormat {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--json" || tok === "--format=json") return "json";
    if (tok === "--yaml" || tok === "--format=yaml") return "yaml";
    if (tok === "--format=inspect") return "inspect";
    if (tok === "--format") {
      const next = tokens[i + 1];
      if (next === "json" || next === "yaml" || next === "inspect") {
        return next;
      }
    }
  }
  return "inspect";
}

export function formatCliReportOutput(
  data: object,
  inspectable: object,
  format: CliReportFormat,
): string {
  if (format === "json") {
    return JSON.stringify(data, null, 2);
  }
  if (format === "yaml") {
    return YAML.stringify(data, null, 2).trimEnd();
  }
  return inspectReport(inspectable, cliInspectOptions());
}

const MINIMUM_NSH_RUNTIME_RANGE = ">=0.4.0";

export function parseNshVersionOutput(raw: string): ParsedNshVersion {
  const clean = Bun.stripANSI(raw).trim();
  const match =
    /\bnsh\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(([0-9a-fA-F]+)\))?/.exec(
      clean,
    );
  if (!match) {
    return { raw: clean, semver: null, gitSha: null };
  }
  return {
    raw: clean,
    semver: match[1] ?? null,
    gitSha: match[2] ?? null,
  };
}

/**
 * Classifies an `nsh.json` manifest into one of the three NSH project modes
 * documented at `https://nsh.dev/docs/project-structure/`:
 *   - `"rust"`: `"rust"` and `"root"` are both set (Rust-only app, no `App.tsx`)
 *   - `"mixed"`: `"rust"` is set without `"root"` (TSX UI calling Rust `nsh/host`)
 *   - `"tsx"`: TypeScript/TSX app rooted at `App.tsx`
 */
export function detectNshProjectMode(manifest: unknown): NshProjectMode {
  if (typeof manifest !== "object" || manifest === null) {
    return "tsx";
  }
  const rec = manifest as Record<string, unknown>;
  const hasRust =
    (typeof rec["rust"] === "string" && rec["rust"].trim().length > 0) ||
    (typeof rec["rust"] === "object" && rec["rust"] !== null);
  const hasRoot =
    typeof rec["root"] === "string" && rec["root"].trim().length > 0;
  if (hasRust && hasRoot) return "rust";
  if (hasRust) return "mixed";
  return "tsx";
}

export function summarizeNshManifest(raw: unknown): NshManifestSummary {
  const rec =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const caps =
    typeof rec["capabilities"] === "object" && rec["capabilities"] !== null
      ? Object.keys(rec["capabilities"] as Record<string, unknown>).sort()
      : [];
  const mode = detectNshProjectMode(rec);
  return {
    name: typeof rec["name"] === "string" ? rec["name"] : null,
    id: typeof rec["id"] === "string" ? rec["id"] : null,
    version: typeof rec["version"] === "string" ? rec["version"] : null,
    build: typeof rec["build"] === "number" ? rec["build"] : null,
    minRuntime:
      typeof rec["minRuntime"] === "string" ? rec["minRuntime"] : null,
    theme: typeof rec["theme"] === "string" ? rec["theme"] : null,
    appearance:
      typeof rec["appearance"] === "string" ? rec["appearance"] : null,
    mode,
    hasRust: mode === "rust" || mode === "mixed",
    hasRoot: typeof rec["root"] === "string" && rec["root"].trim().length > 0,
    capabilityKeys: caps,
  };
}

/**
 * Parses `nsh` CLI output according to `https://nsh.dev/docs/cli/#output`:
 *   - `✓` — a step that finished
 *   - `→` — a server's URL
 *   - `•` — an event from a device
 *   - `warn` — a static-check warning
 *   - `error` — a failure
 *   - plain lines — the app's own `console` logs
 */
export function parseNshCliOutput(raw: string): ParsedNshCliOutput {
  const steps: string[] = [];
  const urls: string[] = [];
  const events: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const clean = Bun.stripANSI(rawLine).trim();
    if (clean.length === 0) continue;

    if (clean.startsWith("✓")) {
      steps.push(clean.slice(1).trim());
    } else if (clean.startsWith("→")) {
      urls.push(clean.slice(1).trim());
    } else if (clean.startsWith("•")) {
      events.push(clean.slice(1).trim());
    } else if (/^warn(?::|\b)/i.test(clean)) {
      warnings.push(clean);
    } else if (/^error(?::|\b|\[)/i.test(clean)) {
      errors.push(clean);
    } else {
      logs.push(clean);
    }
  }

  return { steps, urls, events, warnings, errors, logs };
}

function classifyArtifactKind(relativePath: string): NshArtifactKind {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized === "bundle.nshc" || normalized.endsWith(".nshc")) {
    return "bytecode";
  }
  if (normalized === "bundle.js") {
    return "js-bundle";
  }
  if (normalized === "bundle.js.map" || normalized.endsWith(".map")) {
    return "sourcemap";
  }
  if (normalized === "capabilities.json") {
    return "capabilities";
  }
  if (normalized === "app.json") {
    return "app-metadata";
  }
  if (normalized.endsWith(".nshpkg")) {
    return "nshpkg";
  }
  if (normalized.startsWith("web/")) {
    return "web-asset";
  }
  return "other";
}

export async function collectNshBuildArtifacts(
  outDir: string,
): Promise<NshArtifactsInventory> {
  const glob = new Bun.Glob("**/*");
  const artifacts: NshBuildArtifactEntry[] = [];
  let scannedAny = false;

  try {
    for await (const rel of glob.scan({
      cwd: outDir,
      onlyFiles: true,
      dot: false,
    })) {
      scannedAny = true;
      const normalizedRel = rel.replaceAll("\\", "/");
      const fullPath = path.join(outDir, rel);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) continue;
      const bytes = await file.bytes();
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      artifacts.push({
        relativePath: normalizedRel,
        kind: classifyArtifactKind(normalizedRel),
        bytes: bytes.byteLength,
        sha256: hasher.digest("hex"),
      });
    }
  } catch {
    return {
      outDir,
      exists: false,
      totalFiles: 0,
      totalBytes: 0,
      artifacts: [],
    };
  }

  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const totalBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);

  return {
    outDir,
    exists:
      scannedAny || (await Bun.file(path.join(outDir, "bundle.js")).exists()),
    totalFiles: artifacts.length,
    totalBytes,
    artifacts,
  };
}

export class InspectableNshDoctorReport {
  readonly data: NshDoctorReportData;

  constructor(data: NshDoctorReportData) {
    this.data = data;
  }

  [Bun.inspect.custom](_depth?: number, options?: BunInspectOptions): string {
    const colors = options?.colors === true;
    const verdict = this.data.ok ? "READY" : "FAILED";
    const binSummary = this.data.binary
      ? `${this.data.binary.bin} (${this.data.binary.source})`
      : "missing";
    const verSummary = this.data.version ? this.data.version.raw : "unknown";
    const modeSummary = this.data.manifest
      ? this.data.manifest.mode
      : "unknown";
    const originSummary = this.data.origin.ok
      ? `${this.data.origin.origin} [${this.data.origin.source}]`
      : `ERROR: ${this.data.origin.error}`;

    const header = [
      `${padDisplay("NSH Desk Doctor", 20)}: ${verdict}`,
      `${padDisplay("App directory", 20)}: ${this.data.appDir}`,
      `${padDisplay("NSH binary", 20)}: ${binSummary}`,
      `${padDisplay("NSH version", 20)}: ${verSummary} (Bun ${this.data.bunVersion})`,
      `${padDisplay("Project mode", 20)}: ${modeSummary}`,
      `${padDisplay("Sportsdesk origin", 20)}: ${originSummary}`,
    ].join("\n");

    const table = Bun.inspect.table(
      this.data.checks.map((row) => ({
        check: row.check,
        status: row.status.toUpperCase(),
        detail: row.detail,
      })),
      ["check", "status", "detail"],
      { colors },
    );

    return `${header}\n\n${table.trimEnd()}`;
  }
}

export class InspectableNshArtifactsReport {
  readonly data: NshArtifactsInventory;

  constructor(data: NshArtifactsInventory) {
    this.data = data;
  }

  [Bun.inspect.custom](_depth?: number, options?: BunInspectOptions): string {
    const colors = options?.colors === true;
    const header = [
      `${padDisplay("NSH Output Dir", 18)}: ${this.data.outDir}`,
      `${padDisplay("Artifact Count", 18)}: ${this.data.totalFiles} file(s) (${this.data.totalBytes.toLocaleString("en-US")} B)`,
    ].join("\n");

    if (this.data.artifacts.length === 0) {
      return `${header}\n\n(no build artifacts present — run 'bun run nsh:build' first)`;
    }

    const table = Bun.inspect.table(
      this.data.artifacts.map((item) => ({
        artifact: item.relativePath,
        kind: item.kind,
        bytes: item.bytes,
        sha256: item.sha256.slice(0, 16),
      })),
      ["artifact", "kind", "bytes", "sha256"],
      { colors },
    );
    return `${header}\n\n${table.trimEnd()}`;
  }
}

export class InspectableNshVerifyReport {
  readonly data: NshVerifyLoopReportData;

  constructor(data: NshVerifyLoopReportData) {
    this.data = data;
  }

  [Bun.inspect.custom](_depth?: number, options?: BunInspectOptions): string {
    const colors = options?.colors === true;
    const statusLabel = this.data.ok ? "PASS" : "FAIL";
    const header = `${padDisplay("NSH Verify Loop", 18)}: ${statusLabel} (${this.data.totalDurationMs.toFixed(1)} ms)`;
    const table = Bun.inspect.table(
      this.data.steps.map((s) => ({
        step: `nsh ${s.step}`,
        exit: s.exitCode,
        durationMs: Number(s.durationMs.toFixed(1)),
        steps: s.stepCount,
        warnings: s.warningCount,
        errors: s.errorCount,
      })),
      ["step", "exit", "durationMs", "steps", "warnings", "errors"],
      { colors },
    );
    return `${header}\n\n${table.trimEnd()}`;
  }
}

async function resolveGitCommonRoot(cwd: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([proc.stdout.text(), proc.exited]);
  if (code === 0) {
    const gitCommonDir = out.trim();
    if (gitCommonDir.length > 0) {
      return path.dirname(gitCommonDir);
    }
  }
  return cwd;
}

export async function resolveNshBinary(
  repoRoot: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<ResolvedNshBinary> {
  const explicit = env["NSH_BIN"]?.trim();
  if (explicit) {
    if (!(await Bun.file(explicit).exists())) {
      throw new Error(
        `[nsh-desk] NSH_BIN='${explicit}' does not exist on disk`,
      );
    }
    return { bin: explicit, source: "env:NSH_BIN" };
  }

  const fromPath = Bun.which("nsh", { PATH: env["PATH"] ?? "" });
  if (fromPath) {
    return { bin: fromPath, source: "PATH" };
  }

  const commonRoot = await resolveGitCommonRoot(repoRoot);
  const workspaceCandidates = [
    path.join(repoRoot, ".agents", "tools", "nsh", "bin", "nsh"),
    path.join(commonRoot, ".agents", "tools", "nsh", "bin", "nsh"),
  ];
  for (const candidate of workspaceCandidates) {
    if (await Bun.file(candidate).exists()) {
      return { bin: candidate, source: "workspace:.agents/tools/nsh" };
    }
  }

  const home = env["HOME"]?.trim();
  const homeCandidate = home ? path.join(home, ".nsh", "bin", "nsh") : null;
  if (homeCandidate && (await Bun.file(homeCandidate).exists())) {
    return { bin: homeCandidate, source: "home:.nsh" };
  }

  const tried = [
    "$NSH_BIN",
    "$PATH (nsh)",
    ...workspaceCandidates,
    ...(homeCandidate ? [homeCandidate] : []),
  ];
  throw new Error(
    `[nsh-desk] Native Shell CLI ('nsh') not found. Tried: ${tried.join(", ")}. Install via https://nsh.dev/docs/installation.`,
  );
}

const APP_ENTRY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "build",
  "test",
  "check",
  "dev",
  "run",
  "package",
  "publish",
]);

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-o",
  "--out",
  "--filter",
  "--junit",
  "--target",
  "--browser",
  "--web-host",
  "--display",
  "--tsc",
  "--port",
  "--device",
  "--name",
  "--window-size",
  "--id",
  "--app-version",
  "--build",
  "--icon",
  "--sign",
  "--profile",
  "--keystore",
  "--key-alias",
  "--keystore-password",
  "--abi",
  "--key",
  "--cert",
  "--source-map",
  "--min-runtime",
  "--template",
  "--url",
  "--valid-days",
  "--valid-hours",
  "--reason",
  "--from-version",
  "--to-version",
]);

function hasExplicitPositionalEntry(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--limits") {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-") && next.includes("=")) {
        i += 1;
      }
      continue;
    }
    if (FLAGS_WITH_VALUE.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith("-")) {
      continue;
    }
    return true;
  }
  return false;
}

function hasFlagOrInlineValue(
  tokens: readonly string[],
  shortFlag: string | null,
  longFlag: string,
): boolean {
  for (const tok of tokens) {
    if (shortFlag !== null && tok === shortFlag) return true;
    if (tok === longFlag || tok.startsWith(`${longFlag}=`)) return true;
  }
  return false;
}

/**
 * Builds the `nsh` CLI argument vector while preserving `nsh -V` / `--version`,
 * `nsh --help` / `help`, `nsh <command> --help`, non-entry signing/init subcommands
 * (`init`, `keygen`, `certify`, `verify`, `symbolicate`, `revoke`, `update-manifest`),
 * explicit `[ENTRY]` overrides (including `.nshpkg` re-signing in `publish`),
 * custom `-o` / `--out` in `package-web`, and `nsh check [ENTRY] -- <TSC ARGS>...`.
 */
export function buildNshArgv(
  appDir: string,
  argv: readonly string[],
): string[] {
  if (argv.length === 0) {
    return ["check", appDir];
  }

  const leadingFlags: string[] = [];
  let idx = 0;
  while (idx < argv.length) {
    const tok = argv[idx]!;
    if (tok === "-v" || tok === "--verbose") {
      leadingFlags.push(tok);
      idx += 1;
      continue;
    }
    if (
      tok === "-V" ||
      tok === "--version" ||
      tok === "-h" ||
      tok === "--help"
    ) {
      return [...argv];
    }
    break;
  }

  const subcommand = argv[idx];
  if (subcommand === undefined) {
    return [...leadingFlags, "check", appDir];
  }

  const rest = argv.slice(idx + 1);
  const dashDashIdx = rest.indexOf("--");
  const beforeDashDash = dashDashIdx >= 0 ? rest.slice(0, dashDashIdx) : rest;
  const fromDashDash = dashDashIdx >= 0 ? rest.slice(dashDashIdx) : [];

  const asksHelp = beforeDashDash.some((t) => t === "-h" || t === "--help");

  if (subcommand === "package-web") {
    if (asksHelp) {
      return [...leadingFlags, "package", ...beforeDashDash];
    }
    const entryArgs = hasExplicitPositionalEntry(beforeDashDash)
      ? []
      : [appDir];
    const targetArgs = hasFlagOrInlineValue(beforeDashDash, null, "--target")
      ? []
      : ["--target", "web"];
    const outArgs = hasFlagOrInlineValue(beforeDashDash, "-o", "--out")
      ? []
      : ["-o", path.join(appDir, ".nsh", "out", "web")];
    return [
      ...leadingFlags,
      "package",
      ...entryArgs,
      ...targetArgs,
      ...outArgs,
      ...beforeDashDash,
      ...fromDashDash,
    ];
  }

  if (asksHelp || !APP_ENTRY_SUBCOMMANDS.has(subcommand)) {
    return [...leadingFlags, subcommand, ...rest];
  }

  if (hasExplicitPositionalEntry(beforeDashDash)) {
    return [...leadingFlags, subcommand, ...rest];
  }

  const defaultBuildOutArgs =
    subcommand === "build" &&
    !hasFlagOrInlineValue(beforeDashDash, "-o", "--out")
      ? ["-o", path.join(appDir, ".nsh", "out")]
      : [];

  return [
    ...leadingFlags,
    subcommand,
    appDir,
    ...defaultBuildOutArgs,
    ...beforeDashDash,
    ...fromDashDash,
  ];
}

async function runCapturedNsh(
  bin: string,
  nshArgs: readonly string[],
  cwd: string,
  defaultCache: string,
): Promise<{
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly parsed: ParsedNshCliOutput;
}> {
  const startNs = Bun.nanoseconds();
  const child = Bun.spawn([bin, ...nshArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      NSH_CACHE: Bun.env["NSH_CACHE"] ?? defaultCache,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  const durationMs = (Bun.nanoseconds() - startNs) / 1_000_000;
  const combined = [stdout, stderr].filter((s) => s.length > 0).join("\n");
  return {
    exitCode,
    durationMs,
    stdout,
    stderr,
    parsed: parseNshCliOutput(combined),
  };
}

export async function runNshDoctor(
  repoRoot: string,
  appDir: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<NshDoctorReportData> {
  const checks: NshDoctorCheck[] = [];
  let binary: ResolvedNshBinary | null = null;
  let version: ParsedNshVersion | null = null;
  let manifest: NshManifestSummary | null = null;

  try {
    binary = await resolveNshBinary(repoRoot, env);
    checks.push({
      check: "nsh binary",
      status: "ok",
      detail: `${binary.bin} (${binary.source})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      check: "nsh binary",
      status: "fail",
      detail: msg,
    });
  }

  const commonRoot = await resolveGitCommonRoot(repoRoot);
  const defaultCache = path.join(commonRoot, ".agents", "tools", "nsh-cache");

  if (binary !== null) {
    const res = await runCapturedNsh(
      binary.bin,
      ["-V"],
      repoRoot,
      defaultCache,
    );
    if (res.exitCode === 0) {
      version = parseNshVersionOutput(`${res.stdout}\n${res.stderr}`);
      const semverOk =
        version.semver !== null &&
        Bun.semver.satisfies(version.semver, MINIMUM_NSH_RUNTIME_RANGE);
      checks.push({
        check: "nsh runtime semver",
        status: semverOk ? "ok" : "warn",
        detail:
          version.semver !== null
            ? `${version.raw} (${MINIMUM_NSH_RUNTIME_RANGE}: ${semverOk ? "satisfied" : "below baseline"})`
            : `unparsed version '${version.raw}'`,
      });
    } else {
      checks.push({
        check: "nsh runtime semver",
        status: "fail",
        detail: `nsh -V exited ${res.exitCode}`,
      });
    }
  }

  const manifestFile = Bun.file(path.join(appDir, "nsh.json"));
  if (await manifestFile.exists()) {
    try {
      const rawManifest: unknown = await manifestFile.json();
      manifest = summarizeNshManifest(rawManifest);
      const idOk = manifest.id === "ops.sportsdesk.desk";
      checks.push({
        check: "nsh.json manifest",
        status: idOk ? "ok" : "warn",
        detail: `id=${manifest.id ?? "unset"} mode=${manifest.mode} theme=${manifest.theme ?? "default"} caps=[${manifest.capabilityKeys.join(",")}]`,
      });

      if (
        manifest.minRuntime !== null &&
        version !== null &&
        version.semver !== null
      ) {
        const minRange = `>=${manifest.minRuntime}`;
        const minOk = Bun.semver.satisfies(version.semver, minRange);
        checks.push({
          check: "nsh.json minRuntime",
          status: minOk ? "ok" : "fail",
          detail: `installed ${version.semver} vs required ${minRange}`,
        });
      }

      if (manifest.hasRust) {
        const cargoBin = Bun.which("cargo", { PATH: env["PATH"] ?? "" });
        checks.push({
          check: "cargo toolchain",
          status: cargoBin ? "ok" : "fail",
          detail:
            cargoBin ?? "cargo missing on PATH for Rust/mixed NSH project",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        check: "nsh.json manifest",
        status: "fail",
        detail: `invalid JSON: ${msg}`,
      });
    }
  } else {
    checks.push({
      check: "nsh.json manifest",
      status: "fail",
      detail: `missing ${path.join(appDir, "nsh.json")}`,
    });
  }

  if (manifest?.mode !== "rust") {
    const appTsxFile = Bun.file(path.join(appDir, "App.tsx"));
    if (await appTsxFile.exists()) {
      const src = await appTsxFile.text();
      const mountMatches = src.match(/\bmount\s*\(/g) ?? [];
      checks.push({
        check: "App.tsx root mount",
        status: mountMatches.length === 1 ? "ok" : "fail",
        detail:
          mountMatches.length === 1
            ? "single mount(App) entry verified"
            : `expected exactly 1 mount(...) call in App.tsx, found ${mountMatches.length}`,
      });
    } else {
      checks.push({
        check: "App.tsx root mount",
        status: "fail",
        detail: `missing ${path.join(appDir, "App.tsx")}`,
      });
    }
  }

  const tsconfigFile = Bun.file(path.join(appDir, "tsconfig.json"));
  if (await tsconfigFile.exists()) {
    try {
      const tsJson = (await tsconfigFile.json()) as { extends?: unknown };
      const extendsOk = tsJson.extends === "./.nsh/tsconfig.json";
      checks.push({
        check: "tsconfig.json",
        status: extendsOk ? "ok" : "warn",
        detail: extendsOk
          ? 'extends "./.nsh/tsconfig.json"'
          : `extends=${String(tsJson.extends ?? "unset")}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        check: "tsconfig.json",
        status: "fail",
        detail: `invalid JSON: ${msg}`,
      });
    }
  } else {
    checks.push({
      check: "tsconfig.json",
      status: "warn",
      detail: "tsconfig.json missing (run nsh check to generate)",
    });
  }

  const generatedTypesPath = path.join(
    appDir,
    ".nsh",
    "types",
    "nsh",
    "index.d.ts",
  );
  const hasGeneratedTypes = await Bun.file(generatedTypesPath).exists();
  checks.push({
    check: ".nsh/types declarations",
    status: hasGeneratedTypes ? "ok" : "warn",
    detail: hasGeneratedTypes
      ? "generated declarations present"
      : "missing .nsh/types/nsh/index.d.ts (run bun run nsh:check)",
  });

  const requiredSkills = ["nsh", "nsh-design-guides"] as const;
  const parsedSkillNames: string[] = [];
  let skillFailure: string | null = null;
  for (const skillDirName of requiredSkills) {
    const skillCandidates = [
      path.join(repoRoot, ".agents", "skills", skillDirName, "SKILL.md"),
      path.join(commonRoot, ".agents", "skills", skillDirName, "SKILL.md"),
    ];
    let skillFileFound: string | null = null;
    for (const candidate of skillCandidates) {
      if (await Bun.file(candidate).exists()) {
        skillFileFound = candidate;
        break;
      }
    }
    if (skillFileFound === null) {
      skillFailure = `missing .agents/skills/${skillDirName}/SKILL.md`;
      break;
    }
    try {
      const md = await Bun.file(skillFileFound).text();
      const fm = parseSkillFrontmatterYaml(md);
      parsedSkillNames.push(fm.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skillFailure = `${skillDirName}/SKILL.md: ${msg}`;
      break;
    }
  }
  checks.push({
    check: "NSH skills YAML",
    status: skillFailure === null ? "ok" : "warn",
    detail:
      skillFailure === null
        ? `verified YAML frontmatter [${parsedSkillNames.join(", ")}]`
        : skillFailure,
  });

  let originResult: NshDoctorReportData["origin"];
  try {
    const resolved = resolveDeskOrigin(env["SPORTSDESK_ORIGIN"]);
    originResult = {
      ok: true,
      origin: resolved.origin,
      source: resolved.source,
    };
    checks.push({
      check: "SPORTSDESK_ORIGIN",
      status: "ok",
      detail: `${resolved.origin} [${resolved.source}]`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    originResult = { ok: false, error: msg };
    checks.push({
      check: "SPORTSDESK_ORIGIN",
      status: "fail",
      detail: msg,
    });
  }

  const ok = checks.every((c) => c.status !== "fail");

  return {
    ok,
    appDir,
    binary,
    version,
    bunVersion: Bun.version,
    manifest,
    origin: originResult,
    checks,
  };
}

export async function runNshVerifyLoop(
  repoRoot: string,
  appDir: string,
  options: { readonly allowWarnings: boolean; readonly quiet: boolean },
): Promise<NshVerifyLoopReportData> {
  const resolved = await resolveNshBinary(repoRoot);
  const commonRoot = await resolveGitCommonRoot(repoRoot);
  const defaultCache = path.join(commonRoot, ".agents", "tools", "nsh-cache");

  const runStep = async (
    step: "check" | "build" | "test",
  ): Promise<{
    readonly stepResult: NshVerifyStepResult;
    readonly stdout: string;
    readonly stderr: string;
    readonly ok: boolean;
  }> => {
    const nshArgs = buildNshArgv(appDir, [step]);
    if (!options.quiet) {
      console.error(
        `[nsh-desk] verify-loop -> 'nsh ${nshArgs.join(" ")}' via ${resolved.bin} (${resolved.source})`,
      );
    }
    const res = await runCapturedNsh(
      resolved.bin,
      nshArgs,
      repoRoot,
      defaultCache,
    );
    const failedWarningGate =
      !options.allowWarnings && res.parsed.warnings.length > 0;
    return {
      stepResult: {
        step,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        stepCount: res.parsed.steps.length,
        warningCount: res.parsed.warnings.length,
        errorCount: res.parsed.errors.length,
        warnings: res.parsed.warnings,
        errors: res.parsed.errors,
      },
      stdout: res.stdout,
      stderr: res.stderr,
      ok: res.exitCode === 0 && !failedWarningGate,
    };
  };

  const results: NshVerifyStepResult[] = [];
  const loopStartNs = Bun.nanoseconds();

  // `nsh check` and `nsh build` are independent; run them concurrently before `nsh test`.
  const [checkOut, buildOut] = await Promise.all([
    runStep("check"),
    runStep("build"),
  ]);
  for (const out of [checkOut, buildOut]) {
    if (!options.quiet) {
      if (out.stdout.length > 0) process.stderr.write(out.stdout);
      if (out.stderr.length > 0) process.stderr.write(out.stderr);
    }
    results.push(out.stepResult);
  }

  let allOk = checkOut.ok && buildOut.ok;
  if (allOk) {
    const testOut = await runStep("test");
    if (!options.quiet) {
      if (testOut.stdout.length > 0) process.stderr.write(testOut.stdout);
      if (testOut.stderr.length > 0) process.stderr.write(testOut.stderr);
    }
    results.push(testOut.stepResult);
    allOk = testOut.ok;
  }

  const totalDurationMs = (Bun.nanoseconds() - loopStartNs) / 1_000_000;
  return {
    ok: allOk && results.length === 3,
    allowWarnings: options.allowWarnings,
    totalDurationMs,
    steps: results,
  };
}

function printWrapperHelp(): void {
  console.log(`nsh-desk CLI — Sportsdesk Native Shell operator & CI wrapper

Usage:
  bun run scripts/nsh_desk_cli.ts <command> [flags...]
  ./bin/dx nsh <command> [flags...]

Wrapper commands (Bun-native diagnostics & verification):
  doctor [--json|--yaml]               Inspect nsh binary, semver, nsh.json mode/caps, skills YAML & origin
  artifacts [--json|--yaml]            Inventory .nsh/out bytecode/JS/web artifacts with SHA-256 digests
  verify-loop [--allow-warnings] [--json|--yaml]
                                       Run 'nsh check' -> 'nsh build' (0 warnings) -> 'nsh test' with timings
  package-web [-o <dir>] [flags...]    Package standalone web bundle (defaults to packages/nsh-desk/.nsh/out/web)

Forwarded NSH CLI commands (https://nsh.dev/docs/cli/):
  check | build | test | dev | run | package | publish
  init | keygen | certify | verify | symbolicate | revoke | update-manifest | help
  -V, --version | -h, --help | -v, --verbose`);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const appDir = path.join(repoRoot, "packages", "nsh-desk");
  const args = Bun.argv.slice(2);
  const first = args[0];

  if (first === "wrapper-help") {
    printWrapperHelp();
    return;
  }

  if (first === "doctor") {
    const rest = args.slice(1);
    if (rest.includes("-h") || rest.includes("--help")) {
      printWrapperHelp();
      return;
    }
    const format = resolveCliReportFormat(rest);
    const report = await runNshDoctor(repoRoot, appDir);
    console.log(
      formatCliReportOutput(
        report,
        new InspectableNshDoctorReport(report),
        format,
      ),
    );
    process.exit(report.ok ? 0 : 1);
  }

  if (first === "artifacts") {
    const rest = args.slice(1);
    if (rest.includes("-h") || rest.includes("--help")) {
      printWrapperHelp();
      return;
    }
    const format = resolveCliReportFormat(rest);
    const outDir = path.join(appDir, ".nsh", "out");
    const inventory = await collectNshBuildArtifacts(outDir);
    console.log(
      formatCliReportOutput(
        inventory,
        new InspectableNshArtifactsReport(inventory),
        format,
      ),
    );
    return;
  }

  if (first === "verify-loop") {
    const rest = args.slice(1);
    if (rest.includes("-h") || rest.includes("--help")) {
      printWrapperHelp();
      return;
    }
    const format = resolveCliReportFormat(rest);
    const allowWarnings = rest.includes("--allow-warnings");
    const report = await runNshVerifyLoop(repoRoot, appDir, {
      allowWarnings,
      quiet: format !== "inspect",
    });
    console.log(
      formatCliReportOutput(
        report,
        new InspectableNshVerifyReport(report),
        format,
      ),
    );
    process.exit(report.ok ? 0 : 1);
  }

  const resolved = await resolveNshBinary(repoRoot);
  const commonRoot = await resolveGitCommonRoot(repoRoot);
  const defaultCache = path.join(commonRoot, ".agents", "tools", "nsh-cache");
  const nshArgs = buildNshArgv(appDir, args);

  console.error(
    `[nsh-desk] running 'nsh ${nshArgs.join(" ")}' via ${resolved.bin} (${resolved.source})`,
  );

  const child = Bun.spawn([resolved.bin, ...nshArgs], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Bun.env,
      NSH_CACHE: Bun.env["NSH_CACHE"] ?? defaultCache,
    },
  });

  const exitCode = await child.exited;
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
