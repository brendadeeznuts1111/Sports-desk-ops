import { describe, expect, test } from "bun:test";
import {
  parseHardenedYaml,
  YamlGuardError,
  type YamlGuardErrorCode,
} from "../src/utils/hardened_yaml.ts";

function expectYamlCode(
  fn: () => unknown,
  code: YamlGuardErrorCode,
): YamlGuardError {
  try {
    fn();
    expect.unreachable(`Expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(YamlGuardError);
    const guardErr = err as YamlGuardError;
    expect(guardErr.code).toBe(code);
    return guardErr;
  }
}

describe("parseHardenedYaml", () => {
  test("parses valid single-document YAML with explicit markers, comments, quotes, and bounded aliases", () => {
    const yaml = [
      "%YAML 1.2",
      "--- # manifest header",
      'cron: "*/10 * * * *" # inline comment with *star',
      "glob: '*.yaml'",
      "defaults: &base",
      "  retries: 3",
      "  timeoutMs: 1500",
      "sink:",
      "  <<: *base",
      "  bucket: sportsdesk-ops-reports",
      "...",
      "# trailing comment allowed",
    ].join("\n");

    const parsed = parseHardenedYaml(yaml);
    expect(parsed.cron).toBe("*/10 * * * *");
    expect(parsed.glob).toBe("*.yaml");
    expect(parsed.sink).toEqual({
      retries: 3,
      timeoutMs: 1500,
      bucket: "sportsdesk-ops-reports",
    });
  });

  test("rejects empty and comment-only inputs with ERR_YAML_EMPTY_INPUT", () => {
    expectYamlCode(() => parseHardenedYaml(""), "ERR_YAML_EMPTY_INPUT");
    expectYamlCode(
      () => parseHardenedYaml("   \n  \n"),
      "ERR_YAML_EMPTY_INPUT",
    );
    expectYamlCode(
      () => parseHardenedYaml("# just a comment\n---\n# nothing\n...\n"),
      "ERR_YAML_EMPTY_INPUT",
    );
  });

  test("rejects payloads exceeding maxBytes with ERR_YAML_BYTE_LIMIT", () => {
    expectYamlCode(
      () => parseHardenedYaml("key: " + "a".repeat(128), { maxBytes: 64 }),
      "ERR_YAML_BYTE_LIMIT",
    );
  });

  test("rejects multi-document streams with ERR_YAML_MULTI_DOCUMENT", () => {
    expectYamlCode(
      () => parseHardenedYaml("a: 1\n---\nb: 2\n"),
      "ERR_YAML_MULTI_DOCUMENT",
    );
    expectYamlCode(
      () => parseHardenedYaml("---\na: 1\n---\nb: 2\n"),
      "ERR_YAML_MULTI_DOCUMENT",
    );
    expectYamlCode(
      () => parseHardenedYaml("---\na: 1\n...\n---\nb: 2\n"),
      "ERR_YAML_MULTI_DOCUMENT",
    );
    expectYamlCode(
      () => parseHardenedYaml("---\na: 1\n...\ntrailing: 2\n"),
      "ERR_YAML_MULTI_DOCUMENT",
    );
  });

  test("rejects non-object roots with ERR_YAML_ROOT_NOT_OBJECT", () => {
    expectYamlCode(
      () => parseHardenedYaml("- one\n- two\n"),
      "ERR_YAML_ROOT_NOT_OBJECT",
    );
    expectYamlCode(
      () => parseHardenedYaml("scalar-string\n"),
      "ERR_YAML_ROOT_NOT_OBJECT",
    );
    expectYamlCode(
      () => parseHardenedYaml("null\n"),
      "ERR_YAML_ROOT_NOT_OBJECT",
    );
  });

  test("wraps invalid YAML syntax errors with ERR_YAML_PARSE_ERROR and preserves cause", () => {
    const err = expectYamlCode(
      () => parseHardenedYaml("broken: [unterminated\n"),
      "ERR_YAML_PARSE_ERROR",
    );
    expect(err.cause).toBeDefined();
  });

  test("blocks cyclic anchor graphs with ERR_YAML_CYCLIC_GRAPH", () => {
    expectYamlCode(
      () => parseHardenedYaml("node: &self\n  ref: *self\n"),
      "ERR_YAML_CYCLIC_GRAPH",
    );
  });

  test("blocks exponential alias bombs and alias-count floods with ERR_YAML_ALIAS_BOMB", () => {
    const millionLaughs = [
      "a: &a [x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c]",
      "e: &e [*d, *d, *d, *d, *d]",
    ].join("\n");
    expectYamlCode(
      () => parseHardenedYaml(millionLaughs, { maxNodes: 500 }),
      "ERR_YAML_ALIAS_BOMB",
    );

    const manyAliases = [
      "base: &v { ok: true }",
      ...Array.from({ length: 10 }, (_, idx) => `k${idx}: *v`),
    ].join("\n");
    expectYamlCode(
      () => parseHardenedYaml(manyAliases, { maxAliases: 4 }),
      "ERR_YAML_ALIAS_BOMB",
    );
  });

  test("rejects aliases when allowAliases is false with ERR_YAML_ALIAS_LIMIT", () => {
    expectYamlCode(
      () =>
        parseHardenedYaml("a: &x\n  v: 1\nb: *x\n", { allowAliases: false }),
      "ERR_YAML_ALIAS_LIMIT",
    );
  });

  test("blocks deep nesting with ERR_YAML_MAX_DEPTH and unshared floods with ERR_YAML_NODE_LIMIT", () => {
    expectYamlCode(
      () =>
        parseHardenedYaml("a:\n  b:\n    c:\n      d: 1\n", { maxDepth: 2 }),
      "ERR_YAML_MAX_DEPTH",
    );

    const wide = Array.from({ length: 30 }, (_, idx) => `k${idx}: ${idx}`).join(
      "\n",
    );
    expectYamlCode(
      () => parseHardenedYaml(wide, { maxNodes: 10 }),
      "ERR_YAML_NODE_LIMIT",
    );
  });

  test("rejects prototype-polluting keys with ERR_YAML_FORBIDDEN_KEY", () => {
    expectYamlCode(
      () => parseHardenedYaml("__proto__:\n  admin: true\n"),
      "ERR_YAML_FORBIDDEN_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml("nested:\n  constructor: bad\n"),
      "ERR_YAML_FORBIDDEN_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml("nested:\n  prototype: bad\n"),
      "ERR_YAML_FORBIDDEN_KEY",
    );
  });

  test("permits asterisks, duplicate lines, and !tags inside block scalars even under strict flags", () => {
    const yaml = [
      "notes: |",
      "  *emphasis* and *not_alias",
      "  role: viewer",
      "  role: admin",
      "  !!js/function inside prose",
      "folded: >2-",
      "  !not_a_tag",
      "  *still_prose",
      "name: safe",
    ].join("\n");

    const parsed = parseHardenedYaml(yaml, {
      allowAliases: false,
      allowTags: false,
      allowDuplicateKeys: false,
    });
    expect(parsed.name).toBe("safe");
    expect(String(parsed.notes)).toContain("*emphasis*");
    expect(String(parsed.folded)).toContain("!not_a_tag");
  });

  test("permits repeated keys across distinct sequence objects and flow objects", () => {
    const yaml = [
      "entries:",
      "  - name: first",
      "    weight: 1",
      "  - name: second",
      "    weight: 2",
      "flowPairs: [{ name: a, v: 1 }, { name: b, v: 2 }]",
      "trailing: ok",
    ].join("\n");

    const parsed = parseHardenedYaml(yaml);
    expect(parsed.trailing).toBe("ok");
    expect(parsed.entries).toEqual([
      { name: "first", weight: 1 },
      { name: "second", weight: 2 },
    ]);
    expect(parsed.flowPairs).toEqual([
      { name: "a", v: 1 },
      { name: "b", v: 2 },
    ]);
  });

  test("rejects duplicate keys in block and flow mappings with ERR_YAML_DUPLICATE_KEY", () => {
    expectYamlCode(
      () => parseHardenedYaml("role: viewer\nrole: admin\n"),
      "ERR_YAML_DUPLICATE_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml("auth:\n  allow: false\n  allow: true\n"),
      "ERR_YAML_DUPLICATE_KEY",
    );
    expectYamlCode(
      () =>
        parseHardenedYaml(
          "top:\n  - name: a\n  - name: b\ntop:\n  - name: c\n",
        ),
      "ERR_YAML_DUPLICATE_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml("cfg: { a: 1, nested: { x: 1 }, a: 2 }\n"),
      "ERR_YAML_DUPLICATE_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml('cfg: {"role":"viewer","role":"admin"}\n'),
      "ERR_YAML_DUPLICATE_KEY",
    );
    expectYamlCode(
      () => parseHardenedYaml('"role": viewer\nrole: admin\n'),
      "ERR_YAML_DUPLICATE_KEY",
    );
  });

  test("rejects explicit YAML tags unless allowTags is true", () => {
    expectYamlCode(
      () => parseHardenedYaml('fn: !!js/function "function(){}"\n'),
      "ERR_YAML_DISALLOWED_TAG",
    );
    expectYamlCode(
      () => parseHardenedYaml("bin: !!binary R0lGODlh\n"),
      "ERR_YAML_DISALLOWED_TAG",
    );
    expectYamlCode(
      () => parseHardenedYaml("v: !custom foo\n"),
      "ERR_YAML_DISALLOWED_TAG",
    );

    const optedIn = parseHardenedYaml("v: !custom foo\n", { allowTags: true });
    expect(optedIn.v).toBe("foo");
  });

  test("rejects C0 control chars including escaped NUL with ERR_YAML_CONTROL_CHAR", () => {
    expectYamlCode(
      () => parseHardenedYaml('a: "hello\\0world"\n'),
      "ERR_YAML_CONTROL_CHAR",
    );
    expectYamlCode(
      () => parseHardenedYaml('"bad\\u0007key": 1\n'),
      "ERR_YAML_CONTROL_CHAR",
    );
  });

  test("enforces maxKeys limit and optional recursive freeze", () => {
    const manyKeys = Array.from({ length: 12 }, (_, idx) => `k${idx}: 1`).join(
      "\n",
    );
    expectYamlCode(
      () => parseHardenedYaml(manyKeys, { maxKeys: 5 }),
      "ERR_YAML_NODE_LIMIT",
    );

    const frozen = parseHardenedYaml(
      "meta:\n  owner: desk\nitems:\n  - id: 1\n",
      { freeze: true },
    );
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.meta as object)).toBe(true);
    expect(Object.isFrozen(frozen.items as object)).toBe(true);
    const first = (frozen.items as readonly object[])[0]!;
    expect(Object.isFrozen(first)).toBe(true);
  });
});
