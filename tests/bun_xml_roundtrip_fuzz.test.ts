import { describe, expect, test } from "bun:test";

/**
 * Deterministic round-trip fuzz for the documented invariant:
 * `XML.parse(XML.stringify(value))` deep-equals `value` for anything
 * `XML.parse` returned, in either shape.
 *
 * The generator mixes text, attributes, namespaced names, comments and
 * processing instructions; the assertion starts from a parsed tree, because
 * `NodeInput` allows adjacent text runs that a parse legitimately merges.
 */

type XmlNode = {
  name: string;
  attributes?: Record<string, string>;
  children?: Array<
    string | XmlNode | { comment: string } | { target: string; data: string }
  >;
};

const NAMES = ["a", "item", "ns:tag", "x-y", "_n"] as const;
const ATTRIBUTE_NAMES = ["id", "data-x", "ns:attr"] as const;
const ATTRIBUTE_VALUES = [
  "A1",
  "a & b",
  "<tag>",
  'quote "',
  "apos '",
  "tab\tnew\nline\r",
  "é漢",
] as const;
const TEXT = [
  "hello",
  "a & b",
  "<tag>",
  'quote "',
  "line\r\nbreak",
  "é漢",
  "  spaces  ",
] as const;
const COMMENTS = [" note ", "x-y", " spaced  out "] as const;
const PI_DATA = ["now", "", "a & b"] as const;

let seed = 0x5eed;
function random(): number {
  seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return seed / 2 ** 32;
}
function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}
function count(max: number): number {
  return Math.floor(random() * (max + 1));
}

function makeNode(depth: number): XmlNode {
  const node: XmlNode = { name: pick(NAMES) };
  const attributes: Record<string, string> = {};
  for (let i = 0; i < count(2); i++) {
    attributes[pick(ATTRIBUTE_NAMES)] = pick(ATTRIBUTE_VALUES);
  }
  if (Object.keys(attributes).length > 0) node.attributes = attributes;

  const children: NonNullable<XmlNode["children"]> = [];
  for (let i = 0; i < count(3); i++) {
    const kind = random();
    if (kind < 0.45) children.push(pick(TEXT));
    else if (kind < 0.8 && depth > 0) children.push(makeNode(depth - 1));
    else if (kind < 0.9) children.push({ comment: pick(COMMENTS) });
    else children.push({ target: "go", data: pick(PI_DATA) });
  }
  if (children.length > 0) node.children = children;
  return node;
}

describe("Bun.XML round-trip fuzz", () => {
  test("parse(stringify(parse(x))) is stable across generated documents", () => {
    for (let iteration = 0; iteration < 100; iteration++) {
      const tree = makeNode(2);
      const first = Bun.XML.stringify(tree);
      if (first === undefined)
        throw new Error(`iteration ${iteration}: undefined`);
      const parsed = Bun.XML.parse(first, { compact: false });

      const second = Bun.XML.stringify(parsed);
      if (second === undefined)
        throw new Error(`iteration ${iteration}: undefined`);
      const reparsed = Bun.XML.parse(second, { compact: false });

      expect(reparsed, `iteration ${iteration}: tree changed`).toEqual(parsed);
      expect(second, `iteration ${iteration}: serialization not stable`).toBe(
        first,
      );
    }
  });
});
