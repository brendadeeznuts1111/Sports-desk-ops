/**
 * @file src/utils/hardened_yaml.ts
 * @description Hardened single-document YAML parser built on native `Bun.YAML.parse`.
 *
 * Defends R2 manifest ingestion against multi-document streams, alias bombs,
 * cyclic anchor graphs, deep nesting, node/key flooding, oversized payloads,
 * duplicate keys (overriding Bun.YAML's last-wins behavior), explicit tags,
 * C0 control characters, and prototype-polluting keys (`__proto__`,
 * `constructor`, `prototype`).
 */

export type YamlGuardErrorCode =
  | "ERR_YAML_EMPTY_INPUT"
  | "ERR_YAML_BYTE_LIMIT"
  | "ERR_YAML_MULTI_DOCUMENT"
  | "ERR_YAML_ALIAS_LIMIT"
  | "ERR_YAML_DISALLOWED_TAG"
  | "ERR_YAML_DUPLICATE_KEY"
  | "ERR_YAML_CONTROL_CHAR"
  | "ERR_YAML_PARSE_ERROR"
  | "ERR_YAML_ROOT_NOT_OBJECT"
  | "ERR_YAML_CYCLIC_GRAPH"
  | "ERR_YAML_ALIAS_BOMB"
  | "ERR_YAML_MAX_DEPTH"
  | "ERR_YAML_NODE_LIMIT"
  | "ERR_YAML_FORBIDDEN_KEY";

export class YamlGuardError extends Error {
  readonly code: YamlGuardErrorCode;

  constructor(code: YamlGuardErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = "YamlGuardError";
    this.code = code;
  }
}

export interface HardenedYamlOptions {
  /** Hard UTF-8 byte ceiling before parsing. Default: 1 MiB. */
  readonly maxBytes?: number | undefined;
  /** Maximum nested container/value depth from document root (0). Default: 32. */
  readonly maxDepth?: number | undefined;
  /** Maximum total traversed nodes including shared DAG expansions. Default: 10,000. */
  readonly maxNodes?: number | undefined;
  /** Maximum unique mapping keys across the document. Default: 2,048. */
  readonly maxKeys?: number | undefined;
  /** Maximum unquoted `*alias` tokens permitted in input. Default: 64. */
  readonly maxAliases?: number | undefined;
  /** Whether YAML aliases / shared anchor references are permitted. Default: true. */
  readonly allowAliases?: boolean | undefined;
  /** Whether explicit YAML tags (`!tag`, `!!binary`, `!!js/...`) are permitted. Default: false. */
  readonly allowTags?: boolean | undefined;
  /** Whether duplicate keys in the same mapping are permitted. Default: false. */
  readonly allowDuplicateKeys?: boolean | undefined;
  /** Whether decoded strings may contain C0/DEL control characters (excluding \t, \n, \r). Default: false. */
  readonly allowControlChars?: boolean | undefined;
  /** Deeply freeze the returned manifest object graph. Default: false. */
  readonly freeze?: boolean | undefined;
}

interface BlockScope {
  readonly indent: number;
  readonly keys: Set<string>;
}

interface FlowFrame {
  readonly kind: "{" | "[";
  readonly keys: Set<string>;
  expectKey: boolean;
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_KEYS = 2_048;
const DEFAULT_MAX_ALIASES = 64;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const TOKEN_STOP_RE = /[\s,[\]{}#]/;
const BLOCK_SCALAR_HEADER_RE =
  /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*|[ \t]*)$/;

function assertNonNegativeInt(
  value: number,
  name: string,
  code: YamlGuardErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new YamlGuardError(
      code,
      `${name} must be a non-negative safe integer, got ${value}`,
    );
  }
  return value;
}

function hasDisallowedControlChar(value: string): boolean {
  if (!value.isWellFormed()) return true;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function stripTrailingComment(rest: string): string {
  const trimmed = rest.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed;
}

function skipWhitespace(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch !== " " && ch !== "\t") break;
    i++;
  }
  return i;
}

function readSingleQuoted(
  line: string,
  start: number,
): { readonly value: string; readonly nextIndex: number } {
  let out = "";
  let i = start + 1;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === "'") {
      if (i + 1 < line.length && line.charAt(i + 1) === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, nextIndex: i + 1 };
    }
    out += ch;
    i++;
  }
  return { value: out, nextIndex: i };
}

function readDoubleQuoted(
  line: string,
  start: number,
): { readonly value: string; readonly nextIndex: number } {
  let out = "";
  let i = start + 1;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === "\\") {
      const next = i + 1 < line.length ? line.charAt(i + 1) : "";
      if (next === "0") out += "\0";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next.length > 0) out += next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: out, nextIndex: i + 1 };
    }
    out += ch;
    i++;
  }
  return { value: out, nextIndex: i };
}

function isTokenBoundaryChar(ch: string): boolean {
  return (
    ch === "" ||
    ch === " " ||
    ch === "\t" ||
    ch === "," ||
    ch === "[" ||
    ch === "]" ||
    ch === "{" ||
    ch === "}" ||
    ch === ":"
  );
}

/**
 * Scan line for unquoted/uncommented `*alias` tokens and `!tag` prefixes,
 * while tracking flow `{...}` / `[...]` frames and flow mapping duplicate keys.
 */
function scanLineTokens(
  line: string,
  startPos: number,
  lineNum: number,
  flowStack: FlowFrame[],
  state: { aliasCount: number },
  options: {
    readonly allowAliases: boolean;
    readonly allowTags: boolean;
    readonly allowDuplicateKeys: boolean;
  },
): void {
  let i = startPos;
  const len = line.length;

  while (i < len) {
    const ch = line.charAt(i);

    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    if (ch === "#") {
      const prev = i === 0 ? " " : line.charAt(i - 1);
      if (prev === " " || prev === "\t") {
        break;
      }
    }

    if (ch === "{") {
      flowStack.push({ kind: "{", keys: new Set(), expectKey: true });
      i++;
      continue;
    }

    if (ch === "[") {
      flowStack.push({ kind: "[", keys: new Set(), expectKey: false });
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      const top = flowStack.at(-1);
      if (top !== undefined && top.kind === expected) {
        flowStack.pop();
      }
      i++;
      continue;
    }

    const topFlow = flowStack.at(-1);
    if (ch === "," && topFlow !== undefined) {
      if (topFlow.kind === "{") {
        topFlow.expectKey = true;
      }
      i++;
      continue;
    }

    if (ch === ":" && topFlow !== undefined && topFlow.kind === "{") {
      const next = i + 1 < len ? line.charAt(i + 1) : "";
      if (next === "" || next === " " || next === "\t" || next === ",") {
        topFlow.expectKey = false;
        i++;
        continue;
      }
    }

    const prevCh = i === 0 ? "" : line.charAt(i - 1);

    // Explicit YAML tags (`!tag`, `!!js/function`, `!<tag:...>`) outside quotes/comments
    if (ch === "!" && isTokenBoundaryChar(prevCh)) {
      const next = i + 1 < len ? line.charAt(i + 1) : "";
      if (next.length === 1 && !/\s/.test(next)) {
        if (!options.allowTags) {
          throw new YamlGuardError(
            "ERR_YAML_DISALLOWED_TAG",
            `Explicit YAML tag at line ${lineNum} is not permitted`,
          );
        }
        i += 2;
        while (i < len && !TOKEN_STOP_RE.test(line.charAt(i))) {
          i++;
        }
        continue;
      }
    }

    // Aliases (`*ref`) outside quotes/comments
    if (ch === "*" && isTokenBoundaryChar(prevCh)) {
      const next = i + 1 < len ? line.charAt(i + 1) : "";
      if (next.length === 1 && !TOKEN_STOP_RE.test(next)) {
        state.aliasCount++;
        if (!options.allowAliases) {
          throw new YamlGuardError(
            "ERR_YAML_ALIAS_LIMIT",
            `YAML alias token at line ${lineNum} rejected because allowAliases is false`,
          );
        }
        i += 2;
        while (i < len && !TOKEN_STOP_RE.test(line.charAt(i))) {
          i++;
        }
        continue;
      }
    }

    // Handle flow mapping keys (quoted or unquoted `key:`)
    if (
      topFlow !== undefined &&
      topFlow.kind === "{" &&
      topFlow.expectKey &&
      ch !== "&"
    ) {
      if (ch === "'" || ch === '"') {
        const quoted =
          ch === "'" ? readSingleQuoted(line, i) : readDoubleQuoted(line, i);
        const afterWs = skipWhitespace(line, quoted.nextIndex);
        if (afterWs < len && line.charAt(afterWs) === ":") {
          if (!options.allowDuplicateKeys) {
            if (topFlow.keys.has(quoted.value)) {
              throw new YamlGuardError(
                "ERR_YAML_DUPLICATE_KEY",
                `Duplicate YAML key "${quoted.value}" at line ${lineNum}`,
              );
            }
            topFlow.keys.add(quoted.value);
          }
          topFlow.expectKey = false;
          i = afterWs + 1;
          continue;
        }
        i = quoted.nextIndex;
        continue;
      }

      // Unquoted flow mapping key before `:`
      let end = i;
      while (end < len) {
        const c = line.charAt(end);
        if (c === "}" || c === "]" || c === ",") break;
        if (
          c === ":" &&
          (end + 1 === len || /[\s,]/.test(line.charAt(end + 1)))
        ) {
          const keyText = line.slice(i, end).trimEnd();
          if (keyText.length > 0 && !options.allowDuplicateKeys) {
            if (topFlow.keys.has(keyText)) {
              throw new YamlGuardError(
                "ERR_YAML_DUPLICATE_KEY",
                `Duplicate YAML key "${keyText}" at line ${lineNum}`,
              );
            }
            topFlow.keys.add(keyText);
          }
          topFlow.expectKey = false;
          end += 1;
          break;
        }
        end++;
      }
      if (end > i) {
        i = end;
        continue;
      }
    }

    if (ch === "'") {
      i = readSingleQuoted(line, i).nextIndex;
      continue;
    }

    if (ch === '"') {
      i = readDoubleQuoted(line, i).nextIndex;
      continue;
    }

    i++;
  }
}

/**
 * Extract a mapping key from the current block-context offset, if this line starts
 * a `key: value` mapping entry. Returns `{ key, valueStart }` or `null`.
 */
function tryParseBlockMappingKey(
  line: string,
  startPos: number,
): { readonly key: string; readonly valueStart: number } | null {
  let pos = startPos;

  // Skip leading anchor or tag annotations before key if present (e.g. `&k key: 1`)
  while (pos < line.length) {
    const ch = line.charAt(pos);
    if (ch === "&" || ch === "!") {
      pos++;
      while (pos < line.length && !/\s/.test(line.charAt(pos))) {
        pos++;
      }
      pos = skipWhitespace(line, pos);
      continue;
    }
    break;
  }

  if (pos >= line.length) return null;
  const first = line.charAt(pos);
  if (
    first === "-" ||
    first === "?" ||
    first === "{" ||
    first === "[" ||
    first === "*" ||
    first === "#"
  ) {
    return null;
  }

  if (first === "'" || first === '"') {
    const quoted =
      first === "'" ? readSingleQuoted(line, pos) : readDoubleQuoted(line, pos);
    const afterWs = skipWhitespace(line, quoted.nextIndex);
    if (
      afterWs < line.length &&
      line.charAt(afterWs) === ":" &&
      (afterWs + 1 === line.length ||
        line.charAt(afterWs + 1) === " " ||
        line.charAt(afterWs + 1) === "\t")
    ) {
      return { key: quoted.value, valueStart: afterWs + 1 };
    }
    return null;
  }

  let end = pos;
  while (end < line.length) {
    const ch = line.charAt(end);
    if (ch === "#") {
      const prev = end === pos ? " " : line.charAt(end - 1);
      if (prev === " " || prev === "\t") return null;
    }
    if (
      ch === ":" &&
      (end + 1 === line.length ||
        line.charAt(end + 1) === " " ||
        line.charAt(end + 1) === "\t")
    ) {
      const rawKey = line.slice(pos, end).trimEnd();
      if (rawKey.length === 0) return null;
      return { key: rawKey, valueStart: end + 1 };
    }
    end++;
  }
  return null;
}

/**
 * Block-scalar-, quote-, comment-, flow-, and indentation-aware structural YAML pre-scan.
 * Enforces single-document framing, duplicate-key rejection, explicit-tag rejection,
 * and alias ceilings prior to `Bun.YAML.parse`.
 */
function scanYamlStructure(
  text: string,
  options: {
    readonly maxAliases: number;
    readonly allowAliases: boolean;
    readonly allowTags: boolean;
    readonly allowDuplicateKeys: boolean;
  },
): void {
  const rawLines = text.split("\n");
  let sawStartMarker = false;
  let sawEndMarker = false;
  let sawContent = false;
  let blockScalarParentIndent: number | null = null;

  const blockScopes: BlockScope[] = [];
  const flowStack: FlowFrame[] = [];
  const tokenState = { aliasCount: 0 };

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    let line = rawLines[i] ?? "";
    if (i === 0 && line.startsWith("\uFEFF")) {
      line = line.slice(1);
    }
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (/^---(?:[ \t]|$)/.test(line)) {
      if (sawStartMarker || sawContent || sawEndMarker) {
        throw new YamlGuardError(
          "ERR_YAML_MULTI_DOCUMENT",
          `Unexpected multi-document separator "---" at line ${lineNum}`,
        );
      }
      sawStartMarker = true;
      blockScalarParentIndent = null;
      const tail = stripTrailingComment(line.slice(3));
      if (tail.length > 0) {
        sawContent = true;
        scanLineTokens(line, 3, lineNum, flowStack, tokenState, options);
      }
      continue;
    }

    if (/^\.\.\.(?:[ \t]|$)/.test(line)) {
      if (sawEndMarker || (!sawStartMarker && !sawContent)) {
        throw new YamlGuardError(
          "ERR_YAML_MULTI_DOCUMENT",
          `Unexpected document end marker "..." at line ${lineNum}`,
        );
      }
      sawEndMarker = true;
      blockScalarParentIndent = null;
      continue;
    }

    const indent = skipWhitespace(line, 0);
    if (indent >= line.length) {
      continue;
    }

    // Inside multiline block scalar (`|` or `>`), more-indented lines are raw text
    if (blockScalarParentIndent !== null) {
      if (indent > blockScalarParentIndent) {
        sawContent = true;
        continue;
      }
      blockScalarParentIndent = null;
    }

    if (line.charAt(indent) === "#") {
      continue;
    }

    if (
      indent === 0 &&
      line.startsWith("%") &&
      !sawStartMarker &&
      !sawContent &&
      !sawEndMarker
    ) {
      continue;
    }

    if (sawEndMarker) {
      throw new YamlGuardError(
        "ERR_YAML_MULTI_DOCUMENT",
        `Unexpected trailing YAML content after "..." at line ${lineNum}`,
      );
    }

    sawContent = true;

    // Inside flow collections, track flow tokens/keys without changing block scopes
    if (flowStack.length > 0) {
      scanLineTokens(line, indent, lineNum, flowStack, tokenState, options);
      continue;
    }

    // Advance through any block sequence item dashes (`- ...`) on this line
    let pos = indent;
    let lowestDashIndent: number | null = null;
    while (
      pos < line.length &&
      line.charAt(pos) === "-" &&
      (pos + 1 === line.length ||
        line.charAt(pos + 1) === " " ||
        line.charAt(pos + 1) === "\t")
    ) {
      if (lowestDashIndent === null) {
        lowestDashIndent = pos;
      }
      while (blockScopes.length > 0 && blockScopes.at(-1)!.indent > pos) {
        blockScopes.pop();
      }
      pos = skipWhitespace(line, pos + 1);
    }

    if (pos >= line.length || line.charAt(pos) === "#") {
      continue;
    }

    const mappingEntry = tryParseBlockMappingKey(line, pos);
    if (mappingEntry !== null) {
      while (blockScopes.length > 0 && blockScopes.at(-1)!.indent > pos) {
        blockScopes.pop();
      }
      let scope = blockScopes.at(-1);
      if (scope === undefined || scope.indent < pos) {
        scope = { indent: pos, keys: new Set() };
        blockScopes.push(scope);
      }
      if (!options.allowDuplicateKeys) {
        if (scope.keys.has(mappingEntry.key)) {
          throw new YamlGuardError(
            "ERR_YAML_DUPLICATE_KEY",
            `Duplicate YAML key "${mappingEntry.key}" at line ${lineNum}`,
          );
        }
        scope.keys.add(mappingEntry.key);
      }

      const afterColon = skipWhitespace(line, mappingEntry.valueStart);
      if (
        afterColon < line.length &&
        BLOCK_SCALAR_HEADER_RE.test(line.slice(afterColon))
      ) {
        blockScalarParentIndent = pos;
        continue;
      }

      scanLineTokens(line, afterColon, lineNum, flowStack, tokenState, options);
      continue;
    }

    if (
      lowestDashIndent !== null &&
      BLOCK_SCALAR_HEADER_RE.test(line.slice(pos))
    ) {
      blockScalarParentIndent = lowestDashIndent;
      continue;
    }

    scanLineTokens(line, pos, lineNum, flowStack, tokenState, options);
  }

  if (!sawContent) {
    throw new YamlGuardError(
      "ERR_YAML_EMPTY_INPUT",
      "YAML document contains no content",
    );
  }

  if (tokenState.aliasCount > options.maxAliases) {
    throw new YamlGuardError(
      "ERR_YAML_ALIAS_BOMB",
      `Found ${tokenState.aliasCount} YAML alias token(s), exceeding maxAliases limit of ${options.maxAliases}`,
    );
  }
}

function inspectParsedGraph(
  root: Record<string, unknown>,
  limits: {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxKeys: number;
    readonly allowAliases: boolean;
    readonly allowControlChars: boolean;
    readonly freeze: boolean;
  },
): void {
  const ancestors = new Set<object>();
  const seenObjects = new Set<object>();
  let visitedNodes = 0;
  let totalKeys = 0;
  let sawSharedRef = false;

  function visit(value: unknown, depth: number): void {
    if (depth > limits.maxDepth) {
      throw new YamlGuardError(
        "ERR_YAML_MAX_DEPTH",
        `YAML nesting depth ${depth} exceeds maxDepth ${limits.maxDepth}`,
      );
    }

    visitedNodes += 1;
    if (visitedNodes > limits.maxNodes) {
      if (sawSharedRef) {
        throw new YamlGuardError(
          "ERR_YAML_ALIAS_BOMB",
          `Expanded YAML graph exceeded maxNodes ${limits.maxNodes} via alias expansion`,
        );
      }
      throw new YamlGuardError(
        "ERR_YAML_NODE_LIMIT",
        `YAML node count exceeded maxNodes ${limits.maxNodes}`,
      );
    }

    if (typeof value === "string") {
      if (!limits.allowControlChars && hasDisallowedControlChar(value)) {
        throw new YamlGuardError(
          "ERR_YAML_CONTROL_CHAR",
          "Disallowed control character or unpaired surrogate in YAML string value",
        );
      }
      return;
    }

    if (value === null || typeof value !== "object") {
      return;
    }

    if (ancestors.has(value)) {
      throw new YamlGuardError(
        "ERR_YAML_CYCLIC_GRAPH",
        "Cyclic YAML anchor reference detected",
      );
    }

    if (seenObjects.has(value)) {
      if (!limits.allowAliases) {
        throw new YamlGuardError(
          "ERR_YAML_ALIAS_LIMIT",
          "YAML alias/shared reference rejected because allowAliases is false",
        );
      }
      sawSharedRef = true;
    } else {
      seenObjects.add(value);
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          visit(value[i], depth + 1);
        }
      } else {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (FORBIDDEN_KEYS.has(key)) {
            throw new YamlGuardError(
              "ERR_YAML_FORBIDDEN_KEY",
              `Forbidden YAML key "${key}" rejected`,
            );
          }
          if (!limits.allowControlChars && hasDisallowedControlChar(key)) {
            throw new YamlGuardError(
              "ERR_YAML_CONTROL_CHAR",
              "Disallowed control character in YAML mapping key",
            );
          }
          totalKeys += 1;
          if (totalKeys > limits.maxKeys) {
            throw new YamlGuardError(
              "ERR_YAML_NODE_LIMIT",
              `YAML mapping key count exceeded maxKeys ${limits.maxKeys}`,
            );
          }
          visit(record[key], depth + 1);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  }

  visit(root, 0);

  if (limits.freeze) {
    for (const obj of seenObjects) {
      Object.freeze(obj);
    }
  }
}

/**
 * Parse a single YAML document into a plain object with pre- and post-parse
 * structural and semantic safety checks.
 */
export function parseHardenedYaml(
  text: string,
  options?: HardenedYamlOptions,
): Record<string, unknown> {
  const maxBytes = assertNonNegativeInt(
    options?.maxBytes ?? DEFAULT_MAX_BYTES,
    "maxBytes",
    "ERR_YAML_BYTE_LIMIT",
  );
  if (maxBytes === 0) {
    throw new YamlGuardError(
      "ERR_YAML_BYTE_LIMIT",
      "maxBytes must be greater than 0",
    );
  }
  const maxDepth = assertNonNegativeInt(
    options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    "maxDepth",
    "ERR_YAML_MAX_DEPTH",
  );
  const maxNodes = assertNonNegativeInt(
    options?.maxNodes ?? DEFAULT_MAX_NODES,
    "maxNodes",
    "ERR_YAML_NODE_LIMIT",
  );
  const maxKeys = assertNonNegativeInt(
    options?.maxKeys ?? DEFAULT_MAX_KEYS,
    "maxKeys",
    "ERR_YAML_NODE_LIMIT",
  );
  const maxAliases = assertNonNegativeInt(
    options?.maxAliases ?? DEFAULT_MAX_ALIASES,
    "maxAliases",
    "ERR_YAML_ALIAS_LIMIT",
  );
  const allowAliases = options?.allowAliases ?? true;
  const allowTags = options?.allowTags ?? false;
  const allowDuplicateKeys = options?.allowDuplicateKeys ?? false;
  const allowControlChars = options?.allowControlChars ?? false;
  const freeze = options?.freeze ?? false;

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0 || text.trim().length === 0) {
    throw new YamlGuardError(
      "ERR_YAML_EMPTY_INPUT",
      "YAML document must not be empty",
    );
  }
  if (byteLength > maxBytes) {
    throw new YamlGuardError(
      "ERR_YAML_BYTE_LIMIT",
      `YAML payload of ${byteLength} bytes exceeds maxBytes ceiling of ${maxBytes}`,
    );
  }

  scanYamlStructure(text, {
    maxAliases,
    allowAliases,
    allowTags,
    allowDuplicateKeys,
  });

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    throw new YamlGuardError(
      "ERR_YAML_PARSE_ERROR",
      err instanceof Error ? err.message : String(err),
      err,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new YamlGuardError(
      "ERR_YAML_ROOT_NOT_OBJECT",
      "YAML root value must be a mapping object",
    );
  }

  const root = parsed as Record<string, unknown>;
  inspectParsedGraph(root, {
    maxDepth,
    maxNodes,
    maxKeys,
    allowAliases,
    allowControlChars,
    freeze,
  });
  return root;
}
