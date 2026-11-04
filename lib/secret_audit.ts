/**
 * Pure core of `bun run audit:secrets`: find every environment variable the code reads, decide
 * which names look like credentials, and compare them with `lib/secret_manifest.ts`.
 *
 * Limits, stated so the gate is not mistaken for proof: it sees `process.env.NAME`,
 * `Bun.env.NAME`, `import.meta.env.NAME` and `env["NAME"]` reads. It does not see a name passed as
 * a string to a helper (`requireGsid` reads `GSLIVE_SESSION_ID` that way), and it cannot tell a
 * credential from a look-alike except by suffix.
 */

/** Always a credential: must be in the manifest, never allowlisted. */
export const HARD_SECRET_SUFFIXES = [
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_COOKIE",
  "_SESSION",
  "_API_KEY",
] as const;

/** Usually a credential: must be in the manifest or the allowlist, with a reason. */
export const SOFT_SECRET_SUFFIXES = ["_KEY_ID", "_KEY", "_ID"] as const;

export type SecretShape = "hard" | "soft" | "none";

export function classifyName(name: string): SecretShape {
  if (HARD_SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return "hard";
  }
  if (SOFT_SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return "soft";
  }
  return "none";
}

export interface EnvRead {
  readonly name: string;
  readonly line: number;
}

const DOT_READ =
  /\b(?:process\.env|Bun\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)\b/g;
const BRACKET_READ =
  /\b(?:process\.env|Bun\.env|import\.meta\.env)\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

/** Every `env.NAME` / `env["NAME"]` read in one file, with its 1-based line. */
export function scanEnvReads(text: string): EnvRead[] {
  const reads: EnvRead[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const pattern of [DOT_READ, BRACKET_READ]) {
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) reads.push({ name, line: index + 1 });
      }
    }
  }
  return reads;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface AuditInput {
  /** Production sources: where an unregistered read is a failure. */
  readonly sources: readonly SourceFile[];
  /** Every searched file (sources and tests), to judge a manifest entry dead. */
  readonly everything: readonly SourceFile[];
  /** Names the manifest accounts for: variable names and aliases. */
  readonly registered: ReadonlySet<string>;
  /** Variable and keychain names per manifest entry, for the dead-entry check. */
  readonly entries: readonly { readonly names: readonly string[] }[];
  readonly allowlist: Readonly<Record<string, string>>;
  /** Files that define the manifest itself: ignored for "is it referenced". */
  readonly manifestPaths: readonly string[];
}

export interface Unregistered {
  readonly name: string;
  readonly shape: "hard" | "soft";
  readonly where: readonly string[];
}

export interface AuditResult {
  readonly unregistered: readonly Unregistered[];
  /** Allowlisted names a file reads that no longer match a soft suffix, or hard names listed. */
  readonly badAllowlist: readonly string[];
  /** Manifest entries nothing outside the manifest files mentions. */
  readonly dead: readonly string[];
}

export function audit(input: AuditInput): AuditResult {
  const found = new Map<string, { shape: "hard" | "soft"; where: string[] }>();
  for (const file of input.sources) {
    for (const read of scanEnvReads(file.text)) {
      const shape = classifyName(read.name);
      if (shape === "none" || input.registered.has(read.name)) continue;
      if (shape === "soft" && read.name in input.allowlist) continue;
      const entry = found.get(read.name) ?? { shape, where: [] };
      entry.where.push(`${file.path}:${read.line}`);
      found.set(read.name, entry);
    }
  }
  const unregistered = [...found.entries()]
    .map(([name, { shape, where }]) => ({ name, shape, where }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const badAllowlist = Object.keys(input.allowlist).filter(
    (name) => classifyName(name) !== "soft" || input.registered.has(name),
  );

  const outside = input.everything.filter(
    (file) => !input.manifestPaths.includes(file.path),
  );
  const dead = input.entries
    .filter(
      (entry) =>
        !entry.names.some((name) =>
          outside.some((file) => new RegExp(`\\b${name}\\b`).test(file.text)),
        ),
    )
    .map((entry) => entry.names[0] ?? "");
  return { unregistered, badAllowlist, dead };
}

/** The actionable text for one unregistered name. */
export function explainUnregistered(item: Unregistered): string {
  const lines = [
    `Secret-like variable read but not registered: ${item.name}`,
    `  read at: ${item.where.join(", ")}`,
    "  fix it one of two ways:",
    `   (a) a credential: add it to SECRET_MANIFEST in lib/secret_manifest.ts, then store it with`,
    `       printf %s "$VALUE" | bun run secrets:env set ${item.name}`,
  ];
  if (item.shape === "soft") {
    lines.push(
      "   (b) not a credential: add it to NON_SECRET_ALLOWLIST in lib/secret_manifest.ts with the reason",
      "       it is safe to print.",
    );
  } else {
    lines.push(
      `   (b) none: a name ending in a hard suffix cannot be allowlisted. Register it, or rename it`,
      "       if it is not a credential.",
    );
  }
  return lines.join("\n");
}
