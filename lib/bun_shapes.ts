/**
 * @file bun_shapes.ts
 * @description The Bun shapes this repository actually calls, and the evidence that
 * keeps each one's contract honest.
 *
 * Single source of truth, by layer: names and signatures come from `bun-types@1.4.4`
 * (the declarations the bun.com/reference site renders), behaviour comes from probes
 * against the local 1.4.4 binary (`tests/bun_baseline.json`), and property attributes
 * come from the pinned Bun commit. This module quotes no upstream text — it points at
 * the sources so there is only ever one copy to drift.
 *
 * The table is hand-maintained; `analyzeBunShapes` is pure and the coverage test feeds
 * it the real repository. Adding a `Bun.*` call without an entry here fails that test.
 */

import * as ts from "typescript";

/** The exact upstream artifacts this table is written against. */
export const BUN_SHAPE_PINS = {
  bunVersion: "1.4.4",
  bunCommit: "38afee6c84fcf48c0edb2466aa4b27d287a59c30",
  typesVersion: "1.4.4",
} as const;

export const SHAPE_SUBSYSTEMS = [
  "process",
  "text",
  "data",
  "storage",
  "crypto",
  "network",
  "image",
  "meta",
] as const;

export type ShapeSubsystem = (typeof SHAPE_SUBSYSTEMS)[number];

/** Catalog `##` section title each subsystem's shapes must appear under. */
export const SHAPE_SECTIONS: Readonly<Record<ShapeSubsystem, string>> = {
  process: "Process, filesystem and shell",
  text: "Text and terminal rendering",
  data: "Data formats and parsing",
  storage: "Storage and scheduling",
  crypto: "Crypto, hashing and compression",
  network: "Network and serving",
  image: "Image and WebView",
  meta: "Runtime metadata and environment",
};

/**
 * `value` — a runtime property of `Bun`; `type` — declared in bun-types but not a
 * runtime value (`typeof Bun.X === "undefined"`), so it may only be used in type
 * positions.
 */
export type ShapeKind = "value" | "type";

export interface BunShape {
  /** Dotless member name, e.g. `mmap` or `$` — the name used in `Bun.<name>`. */
  readonly name: string;
  readonly kind: ShapeKind;
  readonly subsystem: ShapeSubsystem;
  /** Exact `####` heading text in docs/runbooks/bun_shape_contracts_runbook.md. */
  readonly heading: string;
  /**
   * `declared-only`: part of the declared surface we have not called yet, kept in
   * the catalog on purpose. It must NOT appear in source usage, and the gate flips
   * the entry to a normal one the moment it does.
   */
  readonly status?: "declared-only";
  /** `probe:<id>` | `test:<path>` | `surface:<check-name>`. */
  readonly evidence: readonly string[];
}

/**
 * Shapes the binary exposes but bun-types does not declare. Empty today: every shape
 * below is declared. An entry here must name the source anchor that justifies it, or
 * `analyzeBunShapes` reports `runtime-only-without-source`.
 */
export const RUNTIME_ONLY_SHAPES: ReadonlyMap<string, string> = new Map([
  [
    "CSRF",
    "bun-types@1.4.4 has no Bun.CSRF declaration; probed by bin/bun_surface.ts",
  ],
  [
    "isStandaloneExecutable",
    "bun-types@1.4.4 has no Bun.isStandaloneExecutable declaration; probed by bin/bun_surface.ts",
  ],
  [
    "sliceAnsi",
    "bun-types@1.4.4 has no Bun.sliceAnsi declaration; probed by bin/bun_surface.ts",
  ],
]);

/**
 * Shapes whose members depend on the caller, so they are not snapshotted: the
 * environment, the argv vector and the stdio streams.
 */
export const VOLATILE_SHAPES: ReadonlySet<string> = new Set([
  "env",
  "argv",
  "stdin",
  "stdout",
]);

/** Properties every function inherits that say nothing about the API surface. */
const FUNCTION_INTERNALS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
  "constructor",
  "apply",
  "bind",
  "call",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  // The legacy accessors are Object.prototype members too. A chain that ends in another realm's
  // Object.prototype is not stopped by the identity check below, and reported them as "added"
  // on Bun.s3 (CI, 2026-11-04).
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Own names plus the prototype chain, minus function internals. The same walk
 * `bin/bun_types.ts` uses for declaration drift, so a member list means the same
 * thing in both places.
 */
export function surfaceMembers(value: unknown): string[] {
  const names = new Set<string>();
  let current: unknown = value;
  while (
    current !== null &&
    current !== Object.prototype &&
    current !== Function.prototype &&
    current !== Array.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (!FUNCTION_INTERNALS.has(name)) names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names].sort();
}

export const BUN_SHAPES: readonly BunShape[] = [
  // process & filesystem
  {
    name: "FileSink",
    kind: "type",
    subsystem: "process",
    heading: "Bun.FileSink (type)",
    evidence: ["probe:proc.terminal", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "Terminal",
    kind: "value",
    subsystem: "process",
    heading: "Bun.Terminal",
    evidence: ["surface:Terminal", "probe:proc.terminal"],
  },
  {
    name: "argv",
    kind: "value",
    subsystem: "process",
    heading: "Bun.argv",
    evidence: ["probe:proc.shell"],
  },
  {
    name: "$",
    kind: "value",
    subsystem: "process",
    heading: "Bun.$",
    evidence: ["test:tests/bun_shapes_coverage.test.ts"],
  },
  {
    name: "file",
    kind: "value",
    subsystem: "process",
    heading: "Bun.file",
    evidence: ["surface:file"],
  },
  {
    name: "fileURLToPath",
    kind: "value",
    subsystem: "process",
    heading: "Bun.fileURLToPath",
    evidence: ["probe:proc.paths"],
  },
  {
    name: "gc",
    kind: "value",
    subsystem: "process",
    heading: "Bun.gc",
    evidence: ["probe:proc.spawn"],
  },
  {
    name: "main",
    kind: "value",
    subsystem: "process",
    heading: "Bun.main",
    evidence: ["probe:proc.shell"],
  },
  {
    name: "nanoseconds",
    kind: "value",
    subsystem: "process",
    heading: "Bun.nanoseconds",
    evidence: ["probe:proc.timing"],
  },
  {
    name: "openInEditor",
    kind: "value",
    subsystem: "process",
    heading: "Bun.openInEditor",
    evidence: ["probe:proc.paths"],
  },
  {
    name: "resolveSync",
    kind: "value",
    subsystem: "process",
    heading: "Bun.resolveSync",
    evidence: ["probe:proc.paths"],
  },
  {
    name: "sleep",
    kind: "value",
    subsystem: "process",
    heading: "Bun.sleep",
    evidence: ["surface:sleep", "probe:proc.timing"],
  },
  {
    name: "sleepSync",
    kind: "value",
    subsystem: "process",
    heading: "Bun.sleepSync",
    evidence: ["probe:proc.timing"],
  },
  {
    name: "spawn",
    kind: "value",
    subsystem: "process",
    heading: "Bun.spawn",
    evidence: ["surface:spawn"],
  },
  {
    name: "spawnSync",
    kind: "value",
    subsystem: "process",
    heading: "Bun.spawnSync",
    evidence: ["probe:proc.spawn"],
  },
  {
    name: "stdin",
    kind: "value",
    subsystem: "process",
    heading: "Bun.stdin",
    evidence: ["probe:proc.stdio"],
  },
  {
    name: "stdout",
    kind: "value",
    subsystem: "process",
    heading: "Bun.stdout",
    evidence: ["probe:proc.stdio"],
  },
  {
    name: "which",
    kind: "value",
    subsystem: "process",
    heading: "Bun.which",
    evidence: ["surface:which", "probe:proc.paths"],
  },
  {
    name: "write",
    kind: "value",
    subsystem: "process",
    heading: "Bun.write",
    evidence: ["surface:write"],
  },
  // text & terminal
  {
    name: "color",
    kind: "value",
    subsystem: "text",
    heading: "Bun.color",
    evidence: ["probe:text.ansi"],
  },
  {
    name: "enableANSIColors",
    kind: "value",
    subsystem: "text",
    heading: "Bun.enableANSIColors",
    evidence: ["probe:text.ansi"],
  },
  {
    name: "escapeHTML",
    kind: "value",
    subsystem: "text",
    heading: "Bun.escapeHTML",
    evidence: ["probe:text.ansi"],
  },
  {
    name: "inspect",
    kind: "value",
    subsystem: "text",
    heading: "Bun.inspect",
    evidence: ["surface:inspect.table", "probe:text.inspect"],
  },
  {
    name: "markdown",
    kind: "value",
    subsystem: "text",
    heading: "Bun.markdown",
    evidence: ["surface:markdown"],
  },
  {
    name: "stringWidth",
    kind: "value",
    subsystem: "text",
    heading: "Bun.stringWidth",
    evidence: ["probe:text.width"],
  },
  {
    name: "wrapAnsi",
    kind: "value",
    subsystem: "text",
    heading: "Bun.wrapAnsi",
    evidence: ["probe:text.width"],
  },
  // data formats & parsing
  {
    name: "Cookie",
    kind: "value",
    subsystem: "data",
    heading: "Bun.Cookie",
    evidence: ["probe:data.cookies"],
  },
  {
    name: "CookieMap",
    kind: "value",
    subsystem: "data",
    heading: "Bun.CookieMap",
    evidence: ["surface:CookieMap", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "Glob",
    kind: "value",
    subsystem: "data",
    heading: "Bun.Glob",
    evidence: ["probe:data.glob"],
  },
  {
    name: "JSON5",
    kind: "value",
    subsystem: "data",
    heading: "Bun.JSON5",
    evidence: ["surface:JSON5", "probe:data.parse"],
  },
  {
    name: "JSONC",
    kind: "value",
    subsystem: "data",
    heading: "Bun.JSONC",
    evidence: ["probe:data.json"],
  },
  {
    name: "JSONL",
    kind: "value",
    subsystem: "data",
    heading: "Bun.JSONL",
    evidence: [
      "surface:JSONL.parse",
      "surface:JSONL.parseChunk",
      "test:tests/bun_capabilities.test.ts",
      "probe:data.parse",
    ],
  },
  {
    name: "TOML",
    kind: "value",
    subsystem: "data",
    heading: "Bun.TOML",
    evidence: ["surface:TOML", "probe:data.parse"],
  },
  {
    name: "XML",
    kind: "value",
    subsystem: "data",
    heading: "Bun.XML",
    evidence: ["surface:XML", "probe:data.parse"],
  },
  {
    name: "YAML",
    kind: "value",
    subsystem: "data",
    heading: "Bun.YAML",
    evidence: ["surface:YAML", "probe:data.parse"],
  },
  {
    name: "deepEquals",
    kind: "value",
    subsystem: "data",
    heading: "Bun.deepEquals",
    evidence: ["probe:data.compare"],
  },
  {
    name: "semver",
    kind: "value",
    subsystem: "data",
    heading: "Bun.semver",
    evidence: ["surface:semver.satisfies", "probe:data.semver"],
  },
  // data formats & parsing
  {
    name: "ImportKind",
    kind: "type",
    subsystem: "data",
    heading: "Bun.ImportKind (type, declared-only)",
    evidence: ["test:tests/bun_shapes_types.test-d.ts"],
    status: "declared-only",
  },
  // storage & scheduling
  {
    name: "CSRF",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.CSRF",
    evidence: ["surface:CSRF"],
  },
  {
    name: "isStandaloneExecutable",
    kind: "value",
    subsystem: "process",
    heading: "Bun.isStandaloneExecutable",
    evidence: ["surface:isStandaloneExecutable"],
  },
  {
    name: "sliceAnsi",
    kind: "value",
    subsystem: "text",
    heading: "Bun.sliceAnsi",
    evidence: ["surface:sliceAnsi"],
  },
  {
    name: "Archive",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.Archive",
    evidence: ["surface:Archive", "probe:storage.archive"],
  },
  {
    name: "CronController",
    kind: "type",
    subsystem: "storage",
    heading: "Bun.CronController (type)",
    evidence: ["test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "RedisClient",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.RedisClient",
    evidence: ["surface:RedisClient", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "S3Client",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.S3Client",
    evidence: ["surface:S3Client"],
  },
  {
    name: "s3",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.s3",
    evidence: ["surface:s3", "test:tests/bun_s3client_contract.test.ts"],
  },
  {
    name: "S3File",
    kind: "type",
    subsystem: "storage",
    heading: "Bun.S3File (type)",
    evidence: ["test:tests/bun_s3client_contract.test.ts"],
  },
  {
    name: "S3Options",
    kind: "type",
    subsystem: "storage",
    heading: "Bun.S3Options (type)",
    evidence: ["test:tests/bun_s3client_contract.test.ts"],
  },
  {
    name: "S3Stats",
    kind: "type",
    subsystem: "storage",
    heading: "Bun.S3Stats (type)",
    evidence: ["test:tests/bun_s3client_contract.test.ts"],
  },
  {
    name: "SQL",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.SQL",
    evidence: ["surface:SQL", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "cron",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.cron",
    evidence: ["surface:cron", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "secrets",
    kind: "value",
    subsystem: "storage",
    heading: "Bun.secrets",
    evidence: ["surface:secrets.get", "test:tests/bun_capabilities.test.ts"],
  },
  // crypto & binary
  {
    name: "ArrayBufferSink",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.ArrayBufferSink",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "CryptoHasher",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.CryptoHasher",
    evidence: ["probe:crypto.hash"],
  },
  {
    name: "concatArrayBuffers",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.concatArrayBuffers",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "readableStreamToArrayBuffer",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.readableStreamToArrayBuffer",
    evidence: [
      "surface:readableStreamToArrayBuffer",
      "test:tests/jsonl_stream_replay.test.ts",
    ],
  },
  {
    name: "allocUnsafe",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.allocUnsafe",
    evidence: ["surface:allocUnsafe", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "gunzipSync",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.gunzipSync",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "gzipSync",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.gzipSync",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "hash",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.hash",
    evidence: ["probe:crypto.hash"],
  },
  {
    name: "randomUUIDv7",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.randomUUIDv7",
    evidence: ["probe:crypto.hash"],
  },
  {
    name: "zstdCompress",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.zstdCompress",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "zstdCompressSync",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.zstdCompressSync",
    evidence: ["probe:crypto.compress"],
  },
  {
    name: "zstdDecompressSync",
    kind: "value",
    subsystem: "crypto",
    heading: "Bun.zstdDecompressSync",
    evidence: ["probe:crypto.compress"],
  },
  // network
  {
    name: "FetchProxyOption",
    kind: "type",
    subsystem: "network",
    heading: "Bun.FetchProxyOption (type)",
    evidence: ["test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "FetchSession",
    kind: "value",
    subsystem: "network",
    heading: "Bun.FetchSession",
    evidence: ["surface:FetchSession", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "Server",
    kind: "type",
    subsystem: "network",
    heading: "Bun.Server (type)",
    evidence: ["test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "connect",
    kind: "value",
    subsystem: "network",
    heading: "Bun.connect",
    evidence: ["surface:connect", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "dns",
    kind: "value",
    subsystem: "network",
    heading: "Bun.dns",
    evidence: ["surface:dns.lookup"],
  },
  {
    name: "fetch",
    kind: "value",
    subsystem: "network",
    heading: "Bun.fetch",
    evidence: ["surface:fetch", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "listen",
    kind: "value",
    subsystem: "network",
    heading: "Bun.listen",
    evidence: ["surface:listen", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "serve",
    kind: "value",
    subsystem: "network",
    heading: "Bun.serve",
    evidence: ["surface:serve", "test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "udpSocket",
    kind: "value",
    subsystem: "network",
    heading: "Bun.udpSocket",
    evidence: ["surface:udpSocket", "test:tests/bun_capabilities.test.ts"],
  },
  // image & webview
  {
    name: "Image",
    kind: "value",
    subsystem: "image",
    heading: "Bun.Image",
    evidence: [
      "surface:Image",
      "test:tests/bun_capabilities.test.ts",
      "probe:image.metadata",
    ],
  },
  {
    name: "WebView",
    kind: "value",
    subsystem: "image",
    heading: "Bun.WebView",
    evidence: ["surface:WebView"],
  },
  // runtime metadata & environment
  {
    name: "Env",
    kind: "type",
    subsystem: "meta",
    heading: "Bun.Env (type)",
    evidence: ["test:tests/bun_capabilities.test.ts"],
  },
  {
    name: "env",
    kind: "value",
    subsystem: "meta",
    heading: "Bun.env",
    evidence: ["probe:proc.shell"],
  },
  {
    name: "revision",
    kind: "value",
    subsystem: "meta",
    heading: "Bun.revision",
    evidence: ["probe:proc.meta"],
  },
  {
    name: "version",
    kind: "value",
    subsystem: "meta",
    heading: "Bun.version",
    evidence: ["probe:proc.meta"],
  },
  {
    name: "version_with_sha",
    kind: "value",
    subsystem: "meta",
    heading: "Bun.version_with_sha",
    evidence: ["test:tests/bun_capabilities.test.ts"],
  },
];

/** `#### Title` lines, in file order. */
export function catalogHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^####\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined);
}

export interface ShapeUsage {
  /** Shape name → files that reference it in a value or type position. */
  readonly used: Map<string, Set<string>>;
  /** `Bun[` accesses, which this scanner cannot resolve and which must fail the gate. */
  readonly elementAccess: string[];
}

/**
 * Parse each source and collect `Bun.<name>` property accesses and `Bun.<name>`
 * qualified names (type positions). Comments and string literals are ignored by
 * construction — a docs mention is not a call site.
 */
export function collectBunShapeUsage(
  sources: ReadonlyMap<string, string>,
): ShapeUsage {
  const used = new Map<string, Set<string>>();
  const elementAccess: string[] = [];
  const note = (name: string, file: string) => {
    const set = used.get(name) ?? new Set<string>();
    set.add(file);
    used.set(name, set);
  };
  for (const [file, text] of sources) {
    const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      false,
      kind,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Bun"
        ) {
          note(node.name.text, file);
        }
      } else if (ts.isQualifiedName(node)) {
        if (ts.isIdentifier(node.left) && node.left.text === "Bun") {
          note(node.right.text, file);
        }
      } else if (ts.isElementAccessExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Bun"
        ) {
          elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { used, elementAccess };
}

export type ShapeRule =
  | "unknown-shape"
  | "unused-shape"
  | "duplicate-shape"
  | "heading-missing"
  | "heading-duplicate"
  | "kind-mismatch"
  | "evidence-unresolved"
  | "no-evidence"
  | "undeclared-shape"
  | "runtime-only-without-source"
  | "section-mismatch"
  | "member-drift"
  | "member-unbaselined"
  | "declared-only-in-use"
  | "element-access";

export interface ShapeProblem {
  readonly rule: ShapeRule;
  readonly detail: string;
}

export interface ShapeWorld {
  readonly usage: ShapeUsage;
  readonly shapes: readonly BunShape[];
  /** Catalog `####` headings. */
  readonly headings: readonly string[];
  /** Probe ids present in tests/bun_baseline.json. */
  readonly probes: ReadonlySet<string>;
  /** Test paths, as written in evidence refs. */
  readonly tests: ReadonlySet<string>;
  /** Check names declared in bin/bun_surface.ts. */
  readonly surfaces: ReadonlySet<string>;
  /** `typeof Bun.<name>` per manifest entry. */
  readonly runtimeTypeof: ReadonlyMap<string, string>;
  /** Member surface per shape, measured now. */
  readonly members: ReadonlyMap<string, readonly string[]>;
  /** Member surface per shape, from tests/bun_shape_members.json. */
  readonly memberBaseline: ReadonlyMap<string, readonly string[]>;
  /** Catalog section title → headings listed under it. */
  readonly sections: ReadonlyMap<string, ReadonlySet<string>>;
  /** Value members declared by bun-types@1.4.4. */
  readonly declaredValues: ReadonlySet<string>;
  /** Raw bun-types source text, used to confirm type-only declarations. */
  readonly typesSource: string;
  readonly runtimeOnly?: ReadonlyMap<string, string>;
}

const TYPE_DECLARATION =
  /(?:^|\s)(?:interface|class|type|namespace)\s+([A-Za-z_$][\w$]*)/gm;

function typeDeclarations(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(TYPE_DECLARATION))
    names.add(match[1] as string);
  return names;
}

export function analyzeBunShapes(world: ShapeWorld): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  const byName = new Map<string, BunShape>();
  const headingCount = new Map<string, number>();
  for (const heading of world.headings) {
    headingCount.set(heading, (headingCount.get(heading) ?? 0) + 1);
  }

  for (const shape of world.shapes) {
    if (byName.has(shape.name)) {
      problems.push({ rule: "duplicate-shape", detail: shape.name });
    }
    byName.set(shape.name, shape);
  }

  for (const [name, files] of world.usage.used) {
    if (!byName.has(name)) {
      problems.push({
        rule: "unknown-shape",
        detail: `${name} (${[...files].sort().join(", ")})`,
      });
    }
  }
  for (const line of world.usage.elementAccess) {
    problems.push({ rule: "element-access", detail: line });
  }

  const runtimeOnly = world.runtimeOnly ?? RUNTIME_ONLY_SHAPES;
  const declaredTypes = typeDeclarations(world.typesSource);

  for (const shape of world.shapes) {
    const declaredOnly = shape.status === "declared-only";
    const isUsed = world.usage.used.has(shape.name);
    if (!isUsed && !declaredOnly) {
      problems.push({ rule: "unused-shape", detail: shape.name });
    }
    if (isUsed && declaredOnly) {
      problems.push({ rule: "declared-only-in-use", detail: shape.name });
    }

    const count = headingCount.get(shape.heading) ?? 0;
    if (count === 0) {
      problems.push({ rule: "heading-missing", detail: shape.heading });
    } else if (count > 1) {
      problems.push({
        rule: "heading-duplicate",
        detail: `${shape.heading} ×${count}`,
      });
    }

    const actual = world.runtimeTypeof.get(shape.name) ?? "undefined";
    const defined = actual !== "undefined";
    if (shape.kind === "value" && !defined) {
      problems.push({
        rule: "kind-mismatch",
        detail: `${shape.name}: kind=value typeof=${actual}`,
      });
    }
    if (shape.kind === "type" && defined) {
      problems.push({
        rule: "kind-mismatch",
        detail: `${shape.name}: kind=type typeof=${actual}`,
      });
    }

    const baselineMembers = world.memberBaseline.get(shape.name);
    if (baselineMembers !== undefined) {
      const now = world.members.get(shape.name);
      if (now === undefined) {
        problems.push({
          rule: "member-drift",
          detail: `${shape.name}: no member surface in the binary now`,
        });
      } else {
        const added = now.filter((m) => !baselineMembers.includes(m));
        const removed = baselineMembers.filter((m) => !now.includes(m));
        if (added.length > 0 || removed.length > 0) {
          problems.push({
            rule: "member-drift",
            detail: `${shape.name}: added [${added.join(", ")}] removed [${removed.join(", ")}]`,
          });
        }
      }
    } else if (world.members.has(shape.name)) {
      problems.push({
        rule: "member-unbaselined",
        detail: shape.name,
      });
    }

    const section = SHAPE_SECTIONS[shape.subsystem];
    const inSection = world.sections.get(section);
    if (inSection === undefined || !inSection.has(shape.heading)) {
      problems.push({
        rule: "section-mismatch",
        detail: `${shape.heading} is not under "## ${section}"`,
      });
    }

    if (shape.evidence.length === 0) {
      problems.push({ rule: "no-evidence", detail: shape.name });
    }
    const hasTest = shape.evidence.some((ref) => ref.startsWith("test:"));
    if (shape.kind === "type" && !hasTest) {
      problems.push({
        rule: "no-evidence",
        detail: `${shape.name}: a type needs a test reference`,
      });
    }
    for (const ref of shape.evidence) {
      const [kind, id] = ref.split(":", 2) as [string, string];
      const ok =
        kind === "probe"
          ? world.probes.has(id)
          : kind === "test"
            ? world.tests.has(id)
            : kind === "surface"
              ? world.surfaces.has(id)
              : false;
      if (!ok) problems.push({ rule: "evidence-unresolved", detail: ref });
    }

    const runtimeOnlyAnchor = runtimeOnly.get(shape.name);
    if (shape.kind === "value" && !world.declaredValues.has(shape.name)) {
      if (runtimeOnlyAnchor === undefined) {
        problems.push({ rule: "undeclared-shape", detail: shape.name });
      } else if (runtimeOnlyAnchor.trim() === "") {
        problems.push({
          rule: "runtime-only-without-source",
          detail: shape.name,
        });
      }
    }
    if (shape.kind === "type" && !declaredTypes.has(shape.name)) {
      problems.push({
        rule: "undeclared-shape",
        detail: `${shape.name} (type)`,
      });
    }
  }

  for (const [name, anchor] of runtimeOnly) {
    if (!byName.has(name))
      problems.push({
        rule: "runtime-only-without-source",
        detail: `${name}: no manifest entry`,
      });
    if (anchor.trim() === "")
      problems.push({ rule: "runtime-only-without-source", detail: name });
  }

  return problems;
}
