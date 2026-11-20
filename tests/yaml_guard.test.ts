import { describe, expect, test } from "bun:test";

import { parseGuardedYaml, YamlGuardError } from "../lib/yaml_guard.ts";

const fanout = 10;

function aliasBomb(): string {
  const scalars = Array.from({ length: fanout }, () => '"x"').join(", ");
  const lines = [`a: &a [${scalars}]`];
  const names = "bcdef";
  let prev = "a";
  for (const name of names) {
    const refs = Array.from({ length: fanout }, () => `*${prev}`).join(", ");
    lines.push(`${name}: &${name} [${refs}]`);
    prev = name;
  }
  return `${lines.join("\n")}\n`;
}

describe("parseGuardedYaml", () => {
  test("parses one manifest document", () => {
    expect(
      parseGuardedYaml(
        "kind: r2-manifest\nversion: 1\nobjects:\n  - key: reports/daily.json\n",
      ),
    ).toEqual({
      kind: "r2-manifest",
      version: 1,
      objects: [{ key: "reports/daily.json" }],
    });
  });

  test("accepts a leading document marker and a trailing end marker", () => {
    expect(parseGuardedYaml("---\nkind: r2-manifest\n...\n")).toEqual({
      kind: "r2-manifest",
    });
  });

  test("accepts a YAML directive before the single document", () => {
    expect(parseGuardedYaml("%YAML 1.2\n---\nkind: manifest\n")).toEqual({
      kind: "manifest",
    });
  });

  test("accepts a shared anchor that is not a cycle", () => {
    expect(parseGuardedYaml("a: &a\n  x: 1\nb: *a\n")).toEqual({
      a: { x: 1 },
      b: { x: 1 },
    });
  });

  test("does not treat dashes inside a block scalar as a new document", () => {
    expect(parseGuardedYaml("desc: |\n  ---\n  &a *a\nnext: 1\n")).toEqual({
      desc: "---\n&a *a\n",
      next: 1,
    });
  });

  test("rejects a multi-document stream", () => {
    expect(() => parseGuardedYaml("a: 1\n---\nb: 2\n")).toThrow(
      expect.objectContaining({
        name: "YamlGuardError",
        code: "ERR_YAML_MULTI_DOC",
      }),
    );
  });

  test("rejects a cyclic anchor with ERR_YAML_CYCLIC_GRAPH", () => {
    let caught: unknown;
    try {
      parseGuardedYaml("a: &a\n  self: *a\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(YamlGuardError);
    expect((caught as YamlGuardError).code).toBe("ERR_YAML_CYCLIC_GRAPH");
  });

  test("rejects a flow-style self alias", () => {
    expect(() => parseGuardedYaml("root: &a [*a]\n")).toThrow(
      expect.objectContaining({ code: "ERR_YAML_CYCLIC_GRAPH" }),
    );
  });

  test("parses a compact sequence mapping and a shared anchor", () => {
    expect(
      parseGuardedYaml(
        "items:\n  - key: a\n    value: &a 1\n  - key: b\n    value: *a\n",
      ),
    ).toEqual({
      items: [
        { key: "a", value: 1 },
        { key: "b", value: 1 },
      ],
    });
  });

  test("parses a plain scalar that contains an apostrophe", () => {
    expect(parseGuardedYaml("name: O'Reilly\nkind: manifest\n")).toEqual({
      name: "O'Reilly",
      kind: "manifest",
    });
  });

  test("parses one inline document after the start marker", () => {
    expect(parseGuardedYaml("--- {kind: manifest}\n")).toEqual({
      kind: "manifest",
    });
  });

  test("rejects inline multi-document markers", () => {
    expect(() => parseGuardedYaml("--- {a: 1}\n--- {b: 2}\n")).toThrow(
      expect.objectContaining({ code: "ERR_YAML_MULTI_DOC" }),
    );
  });

  test("rejects a cyclic anchor nested in a compact sequence mapping", () => {
    expect(() =>
      parseGuardedYaml("items:\n  - key: a\n    value: &a [*a]\n"),
    ).toThrow(expect.objectContaining({ code: "ERR_YAML_CYCLIC_GRAPH" }));
  });

  test("rejects an alias bomb nested in compact sequence mappings", () => {
    const scalars = Array.from({ length: fanout }, () => '"x"').join(", ");
    const lines = ["items:", `  - key: a`, `    value: &a [${scalars}]`];
    let prev = "a";
    for (const name of "bcdef") {
      const refs = Array.from({ length: fanout }, () => `*${prev}`).join(", ");
      lines.push(`  - key: ${name}`, `    value: &${name} [${refs}]`);
      prev = name;
    }
    const started = performance.now();
    expect(() => parseGuardedYaml(`${lines.join("\n")}\n`)).toThrow(
      expect.objectContaining({ code: "ERR_YAML_ALIAS_BOMB" }),
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("an apostrophe in a plain scalar does not hide a later alias bomb", () => {
    const started = performance.now();
    expect(() => parseGuardedYaml(`name: O'Reilly\n${aliasBomb()}`)).toThrow(
      expect.objectContaining({ code: "ERR_YAML_ALIAS_BOMB" }),
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("rejects an alias bomb before expansion", () => {
    const started = performance.now();
    expect(() => parseGuardedYaml(aliasBomb())).toThrow(
      expect.objectContaining({ code: "ERR_YAML_ALIAS_BOMB" }),
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("wraps a syntax error from Bun.YAML", () => {
    expect(() => parseGuardedYaml("a: [\n")).toThrow(
      expect.objectContaining({
        name: "YamlGuardError",
        code: "ERR_YAML_PARSE",
      }),
    );
  });
});
