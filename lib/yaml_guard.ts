/**
 * @file yaml_guard.ts
 * @description Hardened YAML parse for untrusted bytes.
 *
 * `Bun.YAML.parse` (Bun 1.4.4) accepts a multi-document stream as an array, returns
 * cyclic objects for anchor cycles, and expands aliases before the caller can refuse
 * them. This module rejects those three shapes, then delegates the value parse to
 * `Bun.YAML.parse`. A document with no anchors skips the graph walk.
 */

export type YamlGuardErrorCode =
  | "ERR_YAML_CYCLIC_GRAPH"
  | "ERR_YAML_ALIAS_BOMB"
  | "ERR_YAML_MULTI_DOC"
  | "ERR_YAML_PARSE";

/** Expansion above this many nodes is refused even when the source is small. */
const ALIAS_HARD_CAP = 2_000_000;
/**
 * A document whose expanded graph is both larger than this and more than
 * {@link ALIAS_BOMB_RATIO} times its source skeleton is an alias bomb.
 * Linear documents (expanded === skeleton) stay under the ratio.
 */
const ALIAS_BOMB_MIN_EXPANDED = 10_000;
const ALIAS_BOMB_RATIO = 100;

export class YamlGuardError extends Error {
  readonly code: YamlGuardErrorCode;

  constructor(
    code: YamlGuardErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "YamlGuardError";
    this.code = code;
  }
}

interface YamlNode {
  anchors: readonly string[];
  alias: string | null;
  children: readonly YamlNode[];
}

function leaf(alias: string | null = null): YamlNode {
  return { anchors: [], alias, children: [] };
}

function withAnchors(anchors: readonly string[], body: YamlNode): YamlNode {
  if (anchors.length === 0) return body;
  return {
    anchors: anchors.concat(body.anchors),
    alias: body.alias,
    children: body.children,
  };
}

function collection(children: readonly YamlNode[]): YamlNode {
  return { anchors: [], alias: null, children };
}

/**
 * Parse one YAML document.
 *
 * Throws {@link YamlGuardError} with `ERR_YAML_MULTI_DOC`, `ERR_YAML_CYCLIC_GRAPH`,
 * `ERR_YAML_ALIAS_BOMB`, or `ERR_YAML_PARSE`. Cyclic anchors use `ERR_YAML_CYCLIC_GRAPH`.
 */
export function parseGuardedYaml(text: string): unknown {
  if (typeof text !== "string") {
    throw new YamlGuardError("ERR_YAML_PARSE", "YAML input must be a string");
  }
  assertSingleDocument(text);
  if (hasAnchorOrAlias(text)) {
    const root = new AnchorParser(stripBom(text)).parseDocument();
    assertSafeAnchorGraph(root);
  }
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch (error) {
    if (error instanceof YamlGuardError) throw error;
    const message =
      error instanceof Error ? error.message : "YAML parse failed";
    throw new YamlGuardError("ERR_YAML_PARSE", message, { cause: error });
  }
  assertParsedAcyclic(value);
  return value;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function assertSingleDocument(text: string): void {
  const s = stripBom(text);
  let i = 0;
  let flow = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let blockIndent = -1;
  let docOpen = false;
  let closed = false;

  const throwMulti = (): never => {
    throw new YamlGuardError(
      "ERR_YAML_MULTI_DOC",
      "YAML stream contains more than one document",
    );
  };

  while (i < s.length) {
    if (quote !== null) {
      const c = s[i] ?? "";
      if (quote === '"' && escape) {
        escape = false;
        i += 1;
        continue;
      }
      if (quote === '"' && c === "\\") {
        escape = true;
        i += 1;
        continue;
      }
      if (quote === "'" && c === "'" && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (blockIndent >= 0 && isLineStart(s, i)) {
      const indent = indentAt(s, i);
      const empty = lineIsEmpty(s, i);
      if (empty || indent > blockIndent) {
        i = nextLine(s, i);
        continue;
      }
      blockIndent = -1;
    }

    if (flow === 0 && isLineStart(s, i)) {
      const indent = indentAt(s, i);
      if (indent === 0 && isDirectiveLine(s, i)) {
        if (docOpen || closed) throwMulti();
        i = nextLine(s, i);
        continue;
      }
      if (indent === 0 && isDocMarker(s, i)) {
        const kind = (s[i] ?? "") === "." ? "end" : "start";
        if (kind === "start") {
          if (docOpen || closed) throwMulti();
          docOpen = true;
        } else if (closed) {
          throwMulti();
        } else {
          closed = true;
          docOpen = false;
        }
        i = nextLine(s, i);
        continue;
      }
    }

    const c = s[i] ?? "";
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "#") {
      i = nextLine(s, i);
      continue;
    }
    if (c === "[" || c === "{") {
      flow += 1;
      i += 1;
      continue;
    }
    if ((c === "]" || c === "}") && flow > 0) {
      flow -= 1;
      i += 1;
      continue;
    }
    if (flow === 0 && (c === "|" || c === ">") && isBlockIndicator(s, i)) {
      blockIndent = indentAt(s, lineStart(s, i));
      i = nextLine(s, i);
      continue;
    }
    if (c === "\n") {
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (closed) throwMulti();
    docOpen = true;
    i += 1;
  }
}

function hasAnchorOrAlias(text: string): boolean {
  const s = stripBom(text);
  let i = 0;
  let flow = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let blockIndent = -1;
  while (i < s.length) {
    if (quote !== null) {
      const c = s[i] ?? "";
      if (quote === '"' && escape) {
        escape = false;
        i += 1;
        continue;
      }
      if (quote === '"' && c === "\\") {
        escape = true;
        i += 1;
        continue;
      }
      if (quote === "'" && c === "'" && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (blockIndent >= 0 && isLineStart(s, i)) {
      const indent = indentAt(s, i);
      if (lineIsEmpty(s, i) || indent > blockIndent) {
        i = nextLine(s, i);
        continue;
      }
      blockIndent = -1;
    }
    const c = s[i] ?? "";
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "#") {
      i = nextLine(s, i);
      continue;
    }
    if (c === "[" || c === "{") {
      flow += 1;
      i += 1;
      continue;
    }
    if ((c === "]" || c === "}") && flow > 0) {
      flow -= 1;
      i += 1;
      continue;
    }
    if (flow === 0 && (c === "|" || c === ">") && isBlockIndicator(s, i)) {
      blockIndent = indentAt(s, lineStart(s, i));
      i = nextLine(s, i);
      continue;
    }
    if (c === "&" || c === "*") return true;
    i += 1;
  }
  return false;
}

function isLineStart(s: string, i: number): boolean {
  return i === 0 || s.charCodeAt(i - 1) === 10;
}

function lineStart(s: string, i: number): number {
  let j = i;
  while (j > 0 && s.charCodeAt(j - 1) !== 10) j -= 1;
  return j;
}

function indentAt(s: string, i: number): number {
  let n = 0;
  while (s.charCodeAt(i + n) === 32) n += 1;
  return n;
}

function lineIsEmpty(s: string, i: number): boolean {
  let j = i + indentAt(s, i);
  const c = s.charCodeAt(j);
  return c === 10 || c === 13 || Number.isNaN(c) || c === 35;
}

function nextLine(s: string, i: number): number {
  const nl = s.indexOf("\n", i);
  return nl === -1 ? s.length : nl + 1;
}

function isDirectiveLine(s: string, i: number): boolean {
  if (s.charCodeAt(i) !== 37) return false;
  const name = s.charCodeAt(i + 1);
  const letter = (name >= 65 && name <= 90) || (name >= 97 && name <= 122);
  if (!letter) return false;
  let j = i + 2;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 10 || c === 13) return true;
    j += 1;
  }
  return true;
}

function isDocMarker(s: string, i: number): boolean {
  const dashes = s.startsWith("---", i);
  const dots = s.startsWith("...", i);
  if (!dashes && !dots) return false;
  const fourth = s.charCodeAt(i + 3);
  if (fourth === 45 || fourth === 46) return false;
  let j = i + 3;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 10 || c === 13 || c === 35) return true;
    if (c !== 32 && c !== 9) return false;
    j += 1;
  }
  return true;
}

function isBlockIndicator(s: string, i: number): boolean {
  const prev = i === 0 ? 10 : s.charCodeAt(i - 1);
  if (
    prev !== 32 &&
    prev !== 9 &&
    prev !== 10 &&
    prev !== 13 &&
    prev !== 58 &&
    prev !== 45
  ) {
    return false;
  }
  let j = i + 1;
  const digit = s.charCodeAt(j);
  if (digit >= 49 && digit <= 57) j += 1;
  const chomp = s.charCodeAt(j);
  if (chomp === 43 || chomp === 45) j += 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 10 || c === 13 || c === 35) return true;
    if (c !== 32 && c !== 9) return false;
    j += 1;
  }
  return true;
}

class AnchorParser {
  private i = 0;

  constructor(private readonly s: string) {}

  parseDocument(): YamlNode {
    this.skipSpace();
    while (!this.eof() && this.atLineStart() && this.isDirective()) {
      this.consumeLine();
      this.skipSpace();
    }
    if (this.isDocStart()) this.consumeLine();
    this.skipSpace();
    if (this.eof()) return leaf();
    const root = this.parseNode(-1);
    this.skipSpace();
    if (this.isDocEnd()) {
      this.consumeLine();
      this.skipSpace();
    }
    if (!this.eof()) {
      throw new YamlGuardError(
        "ERR_YAML_PARSE",
        "YAML document has trailing content the anchor guard could not classify",
      );
    }
    return root;
  }

  private parseNode(minIndent: number): YamlNode {
    const before = this.i;
    this.skipSpace();
    if (this.eof() || this.isDocMarker()) return leaf();
    if (this.atLineStart() && this.lineIndent() <= minIndent) return leaf();

    const anchors = this.readProperties();
    this.skipInline();
    if (this.isEol() || this.isComment()) {
      this.finishLine();
      const saved = this.i;
      this.skipSpace();
      if (
        this.eof() ||
        this.isDocMarker() ||
        (this.atLineStart() && this.lineIndent() <= minIndent)
      ) {
        this.i = saved;
        return withAnchors(anchors, leaf());
      }
      this.ensureProgress(before);
      return withAnchors(anchors, this.parseNode(minIndent));
    }
    if (this.cc() === 42) return withAnchors(anchors, this.readAlias());
    if (this.cc() === 91 || this.cc() === 123) {
      return withAnchors(anchors, this.parseFlow());
    }
    if (this.isBlockIndicatorHere()) {
      return withAnchors(anchors, this.parseBlockScalar());
    }
    if (this.atLineStart() && this.isSeqEntry()) {
      return withAnchors(anchors, this.parseBlockSeq(this.lineIndent()));
    }
    if (this.atLineStart() && this.looksLikeKey()) {
      return withAnchors(anchors, this.parseBlockMap(this.lineIndent()));
    }
    const plainStart = this.i;
    const plain = this.parsePlain(minIndent);
    this.ensureProgress(plainStart);
    return withAnchors(anchors, plain);
  }

  private parseBlockMap(indent: number): YamlNode {
    const children: YamlNode[] = [];
    while (!this.eof()) {
      const before = this.i;
      this.skipSpace();
      if (this.eof() || this.isDocMarker()) break;
      if (!this.atLineStart() || this.lineIndent() !== indent) break;
      if (!this.looksLikeKey()) break;
      this.consumeKey();
      this.skipInline();
      children.push(this.parseValue(indent));
      this.ensureProgress(before);
    }
    return collection(children);
  }

  private parseBlockSeq(indent: number): YamlNode {
    const children: YamlNode[] = [];
    while (!this.eof()) {
      const before = this.i;
      this.skipSpace();
      if (this.eof() || this.isDocMarker()) break;
      if (!this.atLineStart() || this.lineIndent() !== indent) break;
      if (!this.isSeqEntry()) break;
      this.i += 1;
      if (this.cc() === 32 || this.cc() === 9) this.i += 1;
      children.push(this.parseValue(indent));
      this.ensureProgress(before);
    }
    return collection(children);
  }

  private parseValue(parentIndent: number): YamlNode {
    this.skipInline();
    if (this.eof() || this.isEol() || this.isComment()) {
      const saved = this.i;
      this.finishLine();
      this.skipSpace();
      if (
        this.eof() ||
        this.isDocMarker() ||
        (this.atLineStart() && this.lineIndent() <= parentIndent)
      ) {
        this.i = saved;
        return leaf();
      }
      return this.parseNode(parentIndent);
    }
    return this.parseNode(parentIndent);
  }

  private parseFlow(): YamlNode {
    const open = this.cc();
    const close = open === 91 ? 93 : 125;
    this.i += 1;
    const children: YamlNode[] = [];
    while (!this.eof()) {
      this.skipFlowSpace();
      if (this.cc() === close) {
        this.i += 1;
        return collection(children);
      }
      if (open === 123) {
        this.parseFlowKey();
        this.skipFlowSpace();
        if (this.cc() !== 58) {
          throw new YamlGuardError(
            "ERR_YAML_PARSE",
            "YAML flow mapping is missing a colon",
          );
        }
        this.i += 1;
        this.skipFlowSpace();
      }
      children.push(this.parseFlowNode());
      this.skipFlowSpace();
      if (this.cc() === 44) {
        this.i += 1;
        continue;
      }
      if (this.cc() === close) {
        this.i += 1;
        return collection(children);
      }
      throw new YamlGuardError(
        "ERR_YAML_PARSE",
        "YAML flow collection is missing a comma or closer",
      );
    }
    throw new YamlGuardError(
      "ERR_YAML_PARSE",
      "YAML flow collection is not closed",
    );
  }

  private parseFlowNode(): YamlNode {
    this.skipFlowSpace();
    const anchors = this.readProperties();
    this.skipFlowSpace();
    if (this.cc() === 42) return withAnchors(anchors, this.readAlias());
    if (this.cc() === 91 || this.cc() === 123) {
      return withAnchors(anchors, this.parseFlow());
    }
    this.parseFlowScalar();
    return withAnchors(anchors, leaf());
  }

  private parseFlowKey(): void {
    this.skipFlowSpace();
    if (this.cc() === 34 || this.cc() === 39) {
      this.parseQuoted();
      return;
    }
    while (!this.eof()) {
      const c = this.cc();
      if (
        c === 58 ||
        c === 10 ||
        c === 13 ||
        c === 35 ||
        c === 44 ||
        c === 125
      ) {
        break;
      }
      if (c === 91 || c === 93 || c === 123) break;
      this.i += 1;
    }
  }

  private parseFlowScalar(): void {
    if (this.cc() === 34 || this.cc() === 39) {
      this.parseQuoted();
      return;
    }
    while (!this.eof()) {
      const c = this.cc();
      if (
        c === 44 ||
        c === 93 ||
        c === 125 ||
        c === 10 ||
        c === 13 ||
        c === 35
      ) {
        return;
      }
      if (c === 58) {
        const next = this.cc(1);
        if (
          next === 32 ||
          next === 9 ||
          next === 10 ||
          next === 13 ||
          next === 44 ||
          next === 93 ||
          next === 125 ||
          next === -1
        ) {
          return;
        }
      }
      this.i += 1;
    }
  }

  private parsePlain(parentIndent: number): YamlNode {
    this.consumePlainLine();
    while (!this.eof()) {
      const saved = this.i;
      if (!this.finishLine()) break;
      let ind = 0;
      while (this.cc() === 32) {
        this.i += 1;
        ind += 1;
      }
      if (
        this.eof() ||
        this.isEol() ||
        this.isComment() ||
        ind <= parentIndent
      ) {
        this.i = saved;
        break;
      }
      this.consumePlainLine();
    }
    return leaf();
  }

  private parseBlockScalar(): YamlNode {
    const parent = this.lineIndent();
    this.consumeLine();
    while (!this.eof()) {
      const saved = this.i;
      if (this.isEol()) {
        this.finishLine();
        continue;
      }
      const ind = this.peekIndent();
      const empty = this.isComment() || this.isEol();
      if (!empty && ind <= parent) {
        this.i = saved;
        break;
      }
      this.consumeLine();
    }
    return leaf();
  }

  private readProperties(): string[] {
    const anchors: string[] = [];
    while (!this.eof()) {
      this.skipInline();
      if (this.cc() === 38) {
        this.i += 1;
        anchors.push(this.readName());
        continue;
      }
      if (this.cc() === 33) {
        this.skipTag();
        continue;
      }
      break;
    }
    return anchors;
  }

  private readAlias(): YamlNode {
    this.i += 1;
    return leaf(this.readName());
  }

  private readName(): string {
    const start = this.i;
    while (!this.eof()) {
      const c = this.cc();
      if (
        c <= 32 ||
        c === 44 ||
        c === 35 ||
        c === 58 ||
        c === 91 ||
        c === 93 ||
        c === 123 ||
        c === 125
      ) {
        break;
      }
      this.i += 1;
    }
    if (this.i === start) {
      throw new YamlGuardError(
        "ERR_YAML_PARSE",
        "YAML anchor or alias is missing a name",
      );
    }
    return this.s.slice(start, this.i);
  }

  private skipTag(): void {
    this.i += 1;
    if (this.cc() === 60) {
      while (!this.eof() && this.cc() !== 62) this.i += 1;
      if (this.cc() === 62) this.i += 1;
      return;
    }
    if (this.cc() === 33) this.i += 1;
    while (!this.eof()) {
      const c = this.cc();
      if (
        c <= 32 ||
        c === 44 ||
        c === 35 ||
        c === 91 ||
        c === 93 ||
        c === 123 ||
        c === 125
      ) {
        break;
      }
      this.i += 1;
    }
  }

  private consumeKey(): void {
    this.skipInline();
    if (this.cc() === 34 || this.cc() === 39) {
      this.parseQuoted();
      this.skipInline();
    } else {
      while (!this.eof() && !this.isEol()) {
        if (this.cc() === 58 && this.isKeyColon()) break;
        this.i += 1;
      }
    }
    if (this.cc() !== 58) {
      throw new YamlGuardError(
        "ERR_YAML_PARSE",
        "YAML mapping key is missing a colon",
      );
    }
    this.i += 1;
  }

  private parseQuoted(): void {
    const q = this.cc();
    this.i += 1;
    while (!this.eof()) {
      const c = this.cc();
      if (q === 34 && c === 92) {
        this.i += 2;
        continue;
      }
      if (q === 39 && c === 39 && this.cc(1) === 39) {
        this.i += 2;
        continue;
      }
      this.i += 1;
      if (c === q) return;
    }
    throw new YamlGuardError("ERR_YAML_PARSE", "YAML string is not closed");
  }

  private looksLikeKey(): boolean {
    let j = this.i;
    if (this.s.charCodeAt(j) === 34 || this.s.charCodeAt(j) === 39) {
      const q = this.s.charCodeAt(j);
      j += 1;
      while (j < this.s.length) {
        const c = this.s.charCodeAt(j);
        if (q === 34 && c === 92) {
          j += 2;
          continue;
        }
        if (q === 39 && c === 39 && this.s.charCodeAt(j + 1) === 39) {
          j += 2;
          continue;
        }
        j += 1;
        if (c === q) break;
      }
    }
    while (j < this.s.length) {
      const c = this.s.charCodeAt(j);
      if (c === 10 || c === 13 || c === 35) return false;
      if (c === 58) {
        const n = j + 1 < this.s.length ? this.s.charCodeAt(j + 1) : -1;
        return (
          n === 32 || n === 9 || n === 10 || n === 13 || n === 35 || n === -1
        );
      }
      j += 1;
    }
    return false;
  }

  private isKeyColon(): boolean {
    const n = this.cc(1);
    return n === 32 || n === 9 || n === 10 || n === 13 || n === 35 || n === -1;
  }

  private isSeqEntry(): boolean {
    if (this.cc() !== 45) return false;
    const n = this.cc(1);
    return n === 32 || n === 9 || n === 10 || n === 13 || n === -1;
  }

  private isBlockIndicatorHere(): boolean {
    const c = this.cc();
    if (c !== 124 && c !== 62) return false;
    return isBlockIndicator(this.s, this.i);
  }

  private isDocMarker(): boolean {
    return (
      this.atLineStart() &&
      this.lineIndent() === 0 &&
      isDocMarker(this.s, this.i)
    );
  }

  private isDocStart(): boolean {
    return this.isDocMarker() && this.cc() === 45;
  }

  private isDocEnd(): boolean {
    return this.isDocMarker() && this.cc() === 46;
  }

  private isDirective(): boolean {
    return isDirectiveLine(this.s, this.i);
  }

  private consumePlainLine(): void {
    while (!this.eof() && !this.isEol()) {
      if (
        this.isComment() &&
        (this.i === 0 || this.s.charCodeAt(this.i - 1) === 32)
      ) {
        break;
      }
      this.i += 1;
    }
  }

  private consumeLine(): void {
    while (!this.eof() && !this.isEol()) this.i += 1;
    this.finishLine();
  }

  private finishLine(): boolean {
    if (this.cc() === 13) this.i += 1;
    if (this.cc() === 10) {
      this.i += 1;
      return true;
    }
    return false;
  }

  private skipInline(): void {
    while (this.cc() === 32 || this.cc() === 9) this.i += 1;
  }

  private skipFlowSpace(): void {
    while (!this.eof()) {
      this.skipInline();
      if (this.isEol()) {
        this.finishLine();
        continue;
      }
      if (this.isComment()) {
        this.consumeLine();
        continue;
      }
      break;
    }
  }

  private skipSpace(): void {
    while (!this.eof()) {
      this.skipInline();
      if (this.isEol()) {
        this.finishLine();
        continue;
      }
      if (this.isComment()) {
        this.consumeLine();
        continue;
      }
      break;
    }
  }

  private peekIndent(): number {
    let n = 0;
    while (this.cc(n) === 32) n += 1;
    return n;
  }

  private lineIndent(): number {
    return indentAt(this.s, lineStart(this.s, this.i));
  }

  private atLineStart(): boolean {
    let j = this.i;
    while (j > 0) {
      const c = this.s.charCodeAt(j - 1);
      if (c === 10) return true;
      if (c !== 32 && c !== 9) return false;
      j -= 1;
    }
    return true;
  }

  private isComment(): boolean {
    return this.cc() === 35;
  }

  private isEol(): boolean {
    const c = this.cc();
    return c === 10 || c === 13;
  }

  private eof(): boolean {
    return this.i >= this.s.length;
  }

  private cc(offset = 0): number {
    const j = this.i + offset;
    return j >= 0 && j < this.s.length ? this.s.charCodeAt(j) : -1;
  }

  private ensureProgress(before: number): void {
    if (this.i === before) {
      throw new YamlGuardError(
        "ERR_YAML_PARSE",
        `YAML anchor guard stalled at offset ${this.i}`,
      );
    }
  }
}

function assertSafeAnchorGraph(root: YamlNode): void {
  const anchors = new Map<string, YamlNode>();
  indexAnchors(root, anchors);
  const graph = new Map<string, Set<string>>();
  collectEdges(root, [], graph);
  if (hasCycle(graph)) {
    throw new YamlGuardError(
      "ERR_YAML_CYCLIC_GRAPH",
      "YAML anchor graph contains a cycle",
    );
  }
  if (countAliases(root) === 0) return;
  const expanded = expandedSize(root, anchors, new Map(), new Set());
  const skeleton = skeletonSize(root);
  if (
    expanded > ALIAS_HARD_CAP ||
    (expanded > ALIAS_BOMB_MIN_EXPANDED &&
      expanded > skeleton * ALIAS_BOMB_RATIO)
  ) {
    throw new YamlGuardError(
      "ERR_YAML_ALIAS_BOMB",
      `YAML alias expansion is ${expanded} nodes from ${skeleton} source nodes`,
    );
  }
}

function indexAnchors(node: YamlNode, anchors: Map<string, YamlNode>): void {
  for (const name of node.anchors) anchors.set(name, node);
  if (node.alias !== null) return;
  for (const child of node.children) indexAnchors(child, anchors);
}

function collectEdges(
  node: YamlNode,
  stack: readonly string[],
  graph: Map<string, Set<string>>,
): void {
  if (node.alias !== null) {
    const sources = stack.concat(node.anchors);
    for (const source of sources) {
      const next = graph.get(source);
      if (next === undefined) graph.set(source, new Set([node.alias]));
      else next.add(node.alias);
    }
    return;
  }
  const next = node.anchors.length === 0 ? stack : stack.concat(node.anchors);
  for (const child of node.children) collectEdges(child, next, graph);
}

function hasCycle(graph: Map<string, Set<string>>): boolean {
  const color = new Map<string, number>();
  const visit = (name: string): boolean => {
    const state = color.get(name) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    color.set(name, 1);
    for (const next of graph.get(name) ?? []) {
      if (visit(next)) return true;
    }
    color.set(name, 2);
    return false;
  };
  for (const name of graph.keys()) {
    if (visit(name)) return true;
  }
  return false;
}

function expandedSize(
  node: YamlNode,
  anchors: Map<string, YamlNode>,
  memo: Map<YamlNode, number>,
  stack: Set<YamlNode>,
): number {
  if (node.alias !== null) {
    const target = anchors.get(node.alias);
    if (target === undefined) return 1;
    return expandedSize(target, anchors, memo, stack);
  }
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  if (stack.has(node)) return Number.POSITIVE_INFINITY;
  stack.add(node);
  let total = 1;
  for (const child of node.children) {
    total += expandedSize(child, anchors, memo, stack);
    if (total > ALIAS_HARD_CAP) break;
  }
  stack.delete(node);
  memo.set(node, total);
  return total;
}

function skeletonSize(node: YamlNode): number {
  let total = 1;
  for (const child of node.children) total += skeletonSize(child);
  return total;
}

function countAliases(node: YamlNode): number {
  let total = node.alias === null ? 0 : 1;
  for (const child of node.children) total += countAliases(child);
  return total;
}

function assertParsedAcyclic(value: unknown): void {
  const stack = new Set<object>();
  const done = new Set<object>();
  const walk = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (done.has(current)) return;
    if (stack.has(current)) {
      throw new YamlGuardError(
        "ERR_YAML_CYCLIC_GRAPH",
        "YAML anchor graph contains a cycle",
      );
    }
    stack.add(current);
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
    } else {
      for (const key of Object.keys(current)) {
        walk((current as Record<string, unknown>)[key]);
      }
    }
    stack.delete(current);
    done.add(current);
  };
  walk(value);
}
