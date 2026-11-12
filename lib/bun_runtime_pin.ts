/**
 * The repository's pinned Bun version, derived from the committed manifests.
 *
 * `.bun-version`, `package.json` `engines.bun`, `packageManager`, and
 * `devDependencies.@types/bun` must all name the same X.Y.Z. Workspace
 * `engines.bun` fields must match that pin. Callers must not hardcode the
 * version; if a source is missing or they disagree, this module throws a
 * named error instead of falling back to a default.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BUN_RUNTIME_PIN_CODES = {
  missing: "E_BUN_RUNTIME_PIN_MISSING",
  mismatch: "E_BUN_RUNTIME_PIN_MISMATCH",
  unreadable: "E_BUN_RUNTIME_PIN_UNREADABLE",
  workspaceDrift: "E_BUN_RUNTIME_PIN_WORKSPACE_DRIFT",
} as const;

export type BunRuntimePinCode =
  (typeof BUN_RUNTIME_PIN_CODES)[keyof typeof BUN_RUNTIME_PIN_CODES];

export class BunRuntimePinError extends Error {
  readonly code: BunRuntimePinCode;
  constructor(code: BunRuntimePinCode, message: string) {
    super(message);
    this.name = "BunRuntimePinError";
    this.code = code;
  }
}

const VERSION_RE = /^(\d+\.\d+\.\d+)$/;

/** Orientation docs that must state the current pin and no other X.Y.Z Bun pin. */
export const RUNTIME_PIN_DOCS = [
  "README.md",
  "AGENTS.md",
  "docs/runbooks/bun-pm-policy.md",
] as const;

export interface BunRuntimePinSources {
  readonly bunVersionFile: string | undefined;
  readonly enginesBun: string | undefined;
  readonly packageManager: string | undefined;
  readonly typesBun: string | undefined;
}

export interface WorkspaceEnginePin {
  readonly path: string;
  readonly version: string;
}

/** Mentions of a Bun X.Y.Z in operator prose (`Bun 1.4.4`, `bun@1.4.4`, …). */
const BUN_VERSION_MENTION_RE =
  /\b(?:bun-types\s+v|@types\/bun@?|bun@|bun(?:\s+runtime)?\s+\(v|bun(?:\s+runtime)?\s+v|stable\s+bun\s+|pinned(?:\s+to)?\s+|bun\s+)(\d+\.\d+\.\d+)\b/gi;

export function normalizeBunVersion(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const stripped = trimmed.replace(/^bun@/i, "").replace(/^v/i, "");
  const match = VERSION_RE.exec(stripped);
  return match?.[1];
}

function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export function readBunRuntimePinSources(root: string): BunRuntimePinSources {
  const bunVersionFile = normalizeBunVersion(
    readTextIfExists(join(root, ".bun-version"))?.split(/\r?\n/, 1)[0],
  );

  let enginesBun: string | undefined;
  let packageManager: string | undefined;
  let typesBun: string | undefined;
  const pkgPath = join(root, "package.json");
  const pkgText = readTextIfExists(pkgPath);
  if (pkgText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pkgText);
    } catch (error) {
      throw new BunRuntimePinError(
        BUN_RUNTIME_PIN_CODES.unreadable,
        `${pkgPath} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new BunRuntimePinError(
        BUN_RUNTIME_PIN_CODES.unreadable,
        `${pkgPath} is not a JSON object`,
      );
    }
    const record = parsed as Record<string, unknown>;
    const engines = record.engines;
    if (typeof engines === "object" && engines !== null) {
      enginesBun = normalizeBunVersion(
        (engines as Record<string, unknown>).bun as string | undefined,
      );
    }
    packageManager = normalizeBunVersion(
      typeof record.packageManager === "string"
        ? record.packageManager
        : undefined,
    );
    const devDeps = record.devDependencies;
    if (typeof devDeps === "object" && devDeps !== null) {
      typesBun = normalizeBunVersion(
        (devDeps as Record<string, unknown>)["@types/bun"] as
          string | undefined,
      );
    }
  }

  return { bunVersionFile, enginesBun, packageManager, typesBun };
}

/**
 * Resolve the pin from whatever sources are present. Throws a named error
 * when none can be read, or when the ones that are present disagree.
 */
export function resolveBunRuntimePin(sources: BunRuntimePinSources): string {
  const labeled: { name: string; version: string }[] = [];
  const candidates: { name: string; version: string | undefined }[] = [
    { name: ".bun-version", version: sources.bunVersionFile },
    { name: "package.json engines.bun", version: sources.enginesBun },
    { name: "package.json packageManager", version: sources.packageManager },
    {
      name: "package.json devDependencies.@types/bun",
      version: sources.typesBun,
    },
  ];
  for (const candidate of candidates) {
    if (candidate.version !== undefined) {
      labeled.push({ name: candidate.name, version: candidate.version });
    }
  }

  if (labeled.length === 0) {
    throw new BunRuntimePinError(
      BUN_RUNTIME_PIN_CODES.missing,
      "E_BUN_RUNTIME_PIN_MISSING: no Bun pin found in .bun-version or package.json (engines.bun, packageManager, devDependencies.@types/bun)",
    );
  }

  const versions = new Set(labeled.map((entry) => entry.version));
  if (versions.size > 1) {
    const detail = labeled
      .map((entry) => `${entry.name}=${entry.version}`)
      .join(", ");
    throw new BunRuntimePinError(
      BUN_RUNTIME_PIN_CODES.mismatch,
      `E_BUN_RUNTIME_PIN_MISMATCH: Bun pin sources disagree (${detail})`,
    );
  }
  const pin = labeled[0];
  if (pin === undefined) {
    throw new BunRuntimePinError(
      BUN_RUNTIME_PIN_CODES.missing,
      "E_BUN_RUNTIME_PIN_MISSING: no Bun pin found in .bun-version or package.json (engines.bun, packageManager, devDependencies.@types/bun)",
    );
  }
  return pin.version;
}

export function readBunRuntimePin(root: string): string {
  return resolveBunRuntimePin(readBunRuntimePinSources(root));
}

export function listWorkspaceEnginePins(root: string): WorkspaceEnginePin[] {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const pins: WorkspaceEnginePin[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `packages/${entry.name}/package.json`;
    const text = readTextIfExists(join(root, rel));
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BunRuntimePinError(
        BUN_RUNTIME_PIN_CODES.unreadable,
        `${rel} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const engines = (parsed as Record<string, unknown>).engines;
    if (typeof engines !== "object" || engines === null) continue;
    const version = normalizeBunVersion(
      (engines as Record<string, unknown>).bun as string | undefined,
    );
    if (version !== undefined) pins.push({ path: rel, version });
  }
  return pins.sort((a, b) => a.path.localeCompare(b.path));
}

export function assertWorkspaceBunPins(
  root: string,
  pin: string,
): WorkspaceEnginePin[] {
  const pins = listWorkspaceEnginePins(root);
  const drifted = pins.filter((entry) => entry.version !== pin);
  if (drifted.length > 0) {
    const detail = drifted
      .map((entry) => `${entry.path} engines.bun=${entry.version}`)
      .join(", ");
    throw new BunRuntimePinError(
      BUN_RUNTIME_PIN_CODES.workspaceDrift,
      `E_BUN_RUNTIME_PIN_WORKSPACE_DRIFT: workspace engines.bun must match pin ${pin} (${detail})`,
    );
  }
  return pins;
}

export interface BunPinMention {
  readonly version: string;
  readonly match: string;
  readonly line: number;
}

export function findBunVersionMentions(text: string): BunPinMention[] {
  const mentions: BunPinMention[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/[`*]/g, "");
    const regex = new RegExp(
      BUN_VERSION_MENTION_RE.source,
      BUN_VERSION_MENTION_RE.flags,
    );
    let match = regex.exec(line);
    while (match !== null) {
      const version = match[1];
      if (version !== undefined) {
        mentions.push({
          version,
          match: match[0],
          line: index + 1,
        });
      }
      match = regex.exec(line);
    }
  }
  return mentions;
}

export interface PinDocIssue {
  readonly file: string;
  readonly line: number;
  readonly code:
    "E_BUN_RUNTIME_PIN_DOC_DRIFT" | "E_BUN_RUNTIME_PIN_DOC_MISSING";
  readonly message: string;
}

export function checkRuntimePinDocs(
  docs: Readonly<Record<string, string>>,
  pin: string,
): PinDocIssue[] {
  const issues: PinDocIssue[] = [];
  for (const [file, text] of Object.entries(docs)) {
    const mentions = findBunVersionMentions(text);
    if (mentions.length === 0) {
      issues.push({
        file,
        line: 1,
        code: "E_BUN_RUNTIME_PIN_DOC_MISSING",
        message: `${file} does not mention the current Bun pin ${pin}; derive it from .bun-version / package.json engines.bun`,
      });
      continue;
    }
    for (const mention of mentions) {
      if (mention.version !== pin) {
        issues.push({
          file,
          line: mention.line,
          code: "E_BUN_RUNTIME_PIN_DOC_DRIFT",
          message: `${file}:${mention.line} pins ${JSON.stringify(mention.match)}, but the derived Bun pin is ${pin}`,
        });
      }
    }
  }
  return issues;
}
