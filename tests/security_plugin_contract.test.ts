/**
 * Contract conformance gate for the security/fraud CLI surface.
 *
 * Parses the `command_surface` block in `docs/security-plugin-contract.md` and checks it against
 * the frozen help registry (`cli/fraud_cli_commands.ts`, zero imports) and the declared
 * implementations. Bun-only and `node_modules`-free.
 *
 * Enforced here: command roster vs `HELP_COMMANDS`, per-command declaration completeness, the
 * networked command's S3 use and environment coverage (both directions), the envelope and
 * `schemaVersion`, aliases, the inlined help literals, and the contract pointer sites.
 *
 * Declared but NOT enforced here (contract rev 3 v2 item): the Host tool/UI restriction. This
 * gate covers the CLI surface and source files only.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { HELP_COMMANDS } from "../cli/fraud_cli_commands.ts";
import { FRAUD_CATEGORIES } from "../lib/fraud_patterns.ts";
import { WAGERS_BY_STATE_MANIFEST_KEY } from "../packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts";
import { SYNDICATE_RINGS_MANIFEST_KEY } from "../src/lib/syndicate_adjacency_rollup.ts";

const ROOT = resolve(import.meta.dir, "..");
const CONTRACT_PATH = join(ROOT, "docs/security-plugin-contract.md");
const CLI_PATH = join(ROOT, "cli/sportsdesk_fraud_cli.ts");

/** Files that must point at the tracked contract instead of the gitignored Scratch copy. */
const POINTER_FILES = [
  "cli/sportsdesk_fraud_cli.ts",
  "lib/fraud_patterns.ts",
  "dsh-plugin-security/index.js",
  "dsh-plugin-security/RESEARCH.md",
  // A symlink to cli/sportsdesk_fraud_cli.ts; read() follows it, so it passes with the CLI.
  "packages/sportsdesk-ops/bin/sportsdesk-fraud.ts",
] as const;

interface Line {
  readonly indent: number;
  readonly text: string;
}

interface NetworkedCommand {
  readonly summary: string;
  readonly implementation: string;
  readonly aliases: readonly string[];
  readonly envRequired: readonly string[];
  readonly envOptional: readonly string[];
  readonly readsSecrets: boolean;
  readonly destination: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly envelope: {
    readonly success: boolean;
    readonly schemaVersion: number;
    readonly generatedAt: boolean;
  };
  readonly exitCodes: Readonly<Record<string, number>>;
}

interface Surface {
  readonly roster: readonly string[];
  readonly networked: Readonly<Record<string, NetworkedCommand>>;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of source.split("\n")) {
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text });
  }
  return lines;
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  const quoted = text.match(/^"(.*)"$/) ?? text.match(/^'(.*)'$/);
  return quoted === null ? text : (quoted[1] ?? "");
}

function parseFlowList(text: string): unknown[] {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => {
    const value = part.trim();
    const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
    return quoted === null ? value : (quoted[1] ?? "");
  });
}

function parseSequence(
  lines: readonly Line[],
  index: number,
  indent: number,
): [unknown[], number] {
  const items: unknown[] = [];
  let cursor = index;
  while (
    cursor < lines.length &&
    lines[cursor]!.indent === indent &&
    lines[cursor]!.text.startsWith("- ")
  ) {
    items.push(parseScalar(lines[cursor]!.text.slice(2)));
    cursor += 1;
  }
  return [items, cursor];
}

function parseNode(
  lines: readonly Line[],
  index: number,
  indent: number,
): [unknown, number] {
  return lines[index]!.text.startsWith("- ")
    ? parseSequence(lines, index, indent)
    : parseMapping(lines, index, indent);
}

function parseMapping(
  lines: readonly Line[],
  index: number,
  indent: number,
): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let cursor = index;
  while (cursor < lines.length && lines[cursor]!.indent === indent) {
    const line = lines[cursor]!;
    if (line.text.startsWith("- ")) break;
    const colon = line.text.indexOf(":");
    if (colon === -1) {
      throw new Error(
        `contract block: expected "key: value", got "${line.text}"`,
      );
    }
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    cursor += 1;
    if (rest === "") {
      const hasChild = cursor < lines.length && lines[cursor]!.indent > indent;
      if (hasChild) {
        const [child, next] = parseNode(lines, cursor, lines[cursor]!.indent);
        out[key] = child;
        cursor = next;
      } else {
        out[key] = null;
      }
    } else if (rest === "[]") {
      out[key] = [];
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = parseFlowList(rest);
    } else {
      out[key] = parseScalar(rest);
    }
  }
  return [out, cursor];
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`contract ${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`contract ${where}: expected a string list`);
  }
  return value as string[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`contract ${where}: expected a non-empty string`);
  }
  return value;
}

function num(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`contract ${where}: expected a number`);
  }
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`contract ${where}: expected a boolean`);
  }
  return value;
}

function extractBlock(contract: string): string {
  const match = contract.match(
    /```yaml\r?\n(command_surface:[\s\S]*?)\r?\n```/,
  );
  if (match === null) {
    throw new Error(
      "contract has no ```yaml command_surface block (rev 3 required)",
    );
  }
  return match[1]!;
}

function readSurface(): Surface {
  const contract = read(CONTRACT_PATH);
  const [root] = parseMapping(tokenize(extractBlock(contract)), 0, 0);
  const surface = record(root.command_surface, "command_surface");
  const networkedRaw = record(
    surface.networked_commands,
    "command_surface.networked_commands",
  );
  const networked: Record<string, NetworkedCommand> = {};
  for (const [name, raw] of Object.entries(networkedRaw)) {
    const where = `networked_commands.${name}`;
    const command = record(raw, where);
    const env = record(command.env, `${where}.env`);
    const network = record(command.network, `${where}.network`);
    const envelope = record(command.envelope, `${where}.envelope`);
    const exitCodes = record(command.exit_codes, `${where}.exit_codes`);
    networked[name] = {
      summary: text(command.summary, `${where}.summary`),
      implementation: text(command.implementation, `${where}.implementation`),
      aliases: strings(command.aliases ?? [], `${where}.aliases`),
      envRequired: strings(env.required ?? [], `${where}.env.required`),
      envOptional: strings(env.optional ?? [], `${where}.env.optional`),
      readsSecrets: bool(command.reads_secrets, `${where}.reads_secrets`),
      destination: text(network.destination, `${where}.network.destination`),
      reads: strings(command.reads, `${where}.reads`),
      writes: strings(command.writes, `${where}.writes`),
      envelope: {
        success: bool(envelope.success, `${where}.envelope.success`),
        schemaVersion: num(
          envelope.schemaVersion,
          `${where}.envelope.schemaVersion`,
        ),
        generatedAt: bool(
          envelope.generatedAt,
          `${where}.envelope.generatedAt`,
        ),
      },
      exitCodes: Object.fromEntries(
        Object.entries(exitCodes).map(([code, value]) => [
          code,
          num(value, `${where}.exit_codes.${code}`),
        ]),
      ),
    };
  }
  return {
    roster: strings(surface.roster, "command_surface.roster"),
    networked,
  };
}

const surface = readSurface();
const crossRef = surface.networked["cross-ref"];

describe("contract command surface", () => {
  test("HELP_COMMANDS is unique and covered by roster ∪ networked_commands", () => {
    const helpNames = HELP_COMMANDS.map((command) => command.name);
    expect(new Set(helpNames).size).toBe(helpNames.length);
    const roster = new Set(surface.roster);
    const networked = new Set(Object.keys(surface.networked));
    for (const name of roster) expect(networked.has(name)).toBe(false);
    const undeclared = helpNames.filter(
      (name) => !roster.has(name) && !networked.has(name),
    );
    expect(undeclared).toEqual([]);
  });

  test("roster includes queue and explore (the drift this gate found)", () => {
    expect(surface.roster).toContain("queue");
    expect(surface.roster).toContain("explore");
  });

  test("cross-ref is the only networked command and declares its full contract", () => {
    expect(crossRef).toBeDefined();
    expect(Object.keys(surface.networked)).toEqual(["cross-ref"]);
    expect(crossRef!.implementation).toBe(
      "packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts",
    );
    expect(crossRef!.aliases).toContain("pairwise-cross-ref");
    expect(crossRef!.readsSecrets).toBe(true);
    expect(crossRef!.destination).toBe("r2:sportsdesk-ops-reports");
    expect(crossRef!.reads).toContain(WAGERS_BY_STATE_MANIFEST_KEY);
    expect(crossRef!.reads).toContain(SYNDICATE_RINGS_MANIFEST_KEY);
    expect(crossRef!.reads.some((key) => key.startsWith("chunks/"))).toBe(true);
    expect(crossRef!.writes).toEqual([]);
    expect(crossRef!.envelope).toEqual({
      success: true,
      schemaVersion: 1,
      generatedAt: true,
    });
    const codes = Object.values(crossRef!.exitCodes);
    for (const code of [65, 70, 74, 77, 78]) expect(codes).toContain(code);
  });
});

describe("networked command source conformance", () => {
  const implementation = join(ROOT, crossRef!.implementation);
  const source = read(implementation);

  test("declares S3 use and covers every env name it reads", () => {
    expect(source).toMatch(/new\s+Bun\.S3Client/);
    const reads = new Set<string>();
    for (const match of source.matchAll(
      /\benv\.((?:R2|AWS|CLOUDFLARE)_[A-Z0-9_]+)/g,
    )) {
      if (match[1] !== undefined) reads.add(match[1]);
    }
    for (const match of source.matchAll(
      /\b(?:Bun|process)\.env\.((?:R2|AWS|CLOUDFLARE)_[A-Z0-9_]+)/g,
    )) {
      if (match[1] !== undefined) reads.add(match[1]);
    }
    const declared = new Set([
      ...crossRef!.envRequired,
      ...crossRef!.envOptional,
    ]);
    expect([...reads].filter((name) => !declared.has(name))).toEqual([]);
    expect(crossRef!.envRequired).toContain("R2_ACCESS_KEY_ID");
    expect(crossRef!.envRequired).toContain("R2_SECRET_ACCESS_KEY");
  });

  test("emits the declared envelope and schemaVersion", () => {
    expect(source).toContain("success: true");
    expect(source).toContain("generatedAt:");
    expect(source).toContain("readonly schemaVersion: 1");
    expect(source).toContain("schemaVersion: 1");
    const cli = read(CLI_PATH);
    for (const alias of crossRef!.aliases) {
      expect(cli).toContain(`case "${alias}"`);
    }
  });

  test("no roster implementation constructs an S3 client or reads a secret env", () => {
    const sources = [
      CLI_PATH,
      ...readdirSync(join(ROOT, "lib"))
        .filter((file) => file.startsWith("fraud_") && file.endsWith(".ts"))
        .map((file) => join(ROOT, "lib", file)),
    ];
    for (const file of sources) {
      const body = read(file);
      expect(body).not.toMatch(
        /new\s+Bun\.S3Client|R2S3Client\b|fromEnvOrSecrets/,
      );
      expect(body).not.toMatch(
        /\b(?:Bun|process)\.env\.(?:R2|AWS|CLOUDFLARE)_[A-Z0-9_]+/,
      );
    }
  });
});

describe("help literals and pointers", () => {
  test("inlined help literals match their source constants", () => {
    const crossRefHelp = HELP_COMMANDS.find(
      (command) => command.name === "cross-ref",
    );
    const detail = crossRefHelp?.detail.join("\n") ?? "";
    expect(detail).toContain(WAGERS_BY_STATE_MANIFEST_KEY);
    expect(detail).toContain(SYNDICATE_RINGS_MANIFEST_KEY);
    const patternsHelp = HELP_COMMANDS.find(
      (command) => command.name === "patterns",
    );
    expect(
      patternsHelp?.options.some((option) =>
        option.description.includes(FRAUD_CATEGORIES.join(", ")),
      ),
    ).toBe(true);
  });

  test("contract is tracked at rev 3 and every pointer names the tracked path", () => {
    expect(read(CONTRACT_PATH)).toMatch(/^# .*\(rev 3\)$/m);
    for (const file of POINTER_FILES) {
      const body = read(join(ROOT, file));
      expect(body).toContain("docs/security-plugin-contract.md");
      expect(body).not.toContain(
        "Scratch/security/SECURITY-PLUGIN-CONTRACT.md",
      );
    }
  });
});
