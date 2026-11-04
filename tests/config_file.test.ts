import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  configFormat,
  parseConfig,
  readConfig,
  validateConfig,
} from "../lib/config_file.ts";
import { UsageError } from "../lib/usage_error.ts";

describe("configFormat", () => {
  test("yaml and the JSON family, case-insensitive", () => {
    expect(configFormat("desk.yaml")).toBe("yaml");
    expect(configFormat("conf/DESK.YML")).toBe("yaml");
    expect(configFormat("desk.json")).toBe("json5");
    expect(configFormat("desk.jsonc")).toBe("json5");
    expect(configFormat("desk.JSON5")).toBe("json5");
    expect(configFormat(".yaml")).toBe("yaml");
    expect(configFormat("dir/.desk.yml")).toBe("yaml");
    expect(configFormat("desk.TOML")).toBe("toml");
  });

  test("no extension, a dotted directory or an unknown extension is a usage error, not JSON5", () => {
    for (const [path, shown] of [
      ["config", "(none)"],
      ["conf.d/settings", "(none)"],
      ["desk.ini", '".ini"'],
      ["desk.yaml.bak", '".bak"'],
    ] as const) {
      expect(() => configFormat(path)).toThrow(UsageError);
      expect(() => configFormat(path)).toThrow(
        `${path}: unsupported config extension ${shown}`,
      );
    }
  });
});

describe("parseConfig", () => {
  test("JSON5 takes comments and trailing commas; YAML takes block style", () => {
    expect(parseConfig("{a: 1, // note\n b: [1, 2,],}", "json5")).toEqual({
      a: 1,
      b: [1, 2],
    });
    expect(parseConfig("a: 1\nb:\n  - 2\n", "yaml")).toEqual({ a: 1, b: [2] });
  });

  test("a syntax error becomes a UsageError led by the source, with the parser error as cause", () => {
    let caught: unknown;
    try {
      parseConfig("a: [1", "yaml", "desk.yaml");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).message).toBe(
      "desk.yaml: YAML Parse error: Unexpected token",
    );
    expect((caught as UsageError).cause).toBeInstanceOf(SyntaxError);
    expect(() => parseConfig("{a:", "json5")).toThrow(
      "config: JSON5 Parse error:",
    );
    expect(() => parseConfig("a = 1\na = 2\n", "toml", "desk.toml")).toThrow(
      "desk.toml: TOML Parse error: Cannot redefine key 'a'",
    );
  });

  test("TOML dates are Temporal values, which z.date() rejects and z.instanceof accepts", () => {
    const value = parseConfig("since = 2026-11-02\n", "toml");
    expect(() =>
      validateConfig(value, z.strictObject({ since: z.date() }), "desk.toml"),
    ).toThrow(
      "desk.toml: since: Invalid input: expected date, received PlainDate",
    );
    // TypeScript 5.9 and bun-types 1.4.4 declare no Temporal global; the runtime has one.
    const { Temporal } = globalThis as unknown as {
      Temporal: { PlainDate: new () => { toString(): string } };
    };
    const parsed = validateConfig(
      value,
      z.strictObject({ since: z.instanceof(Temporal.PlainDate) }),
    );
    expect(parsed.since.toString()).toBe("2026-11-02");
  });

  test("TOML inf and nan fail a plain z.number()", () => {
    const value = parseConfig("a = inf\nb = nan\n", "toml");
    expect(() =>
      validateConfig(value, z.strictObject({ a: z.number(), b: z.number() })),
    ).toThrow(/a: .*; b: /);
  });

  test("a multi-document YAML stream comes back as an array, which an array schema cannot tell from one list", () => {
    const stream = parseConfig("a: 1\n---\nb: 2\n", "yaml");
    const list = parseConfig("- a: 1\n- b: 2\n", "yaml");
    expect(stream).toEqual([{ a: 1 }, { b: 2 }]);
    expect(list).toEqual(stream);
  });
});

describe("readConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-file-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const Desk = z.strictObject({
    name: z.string(),
    timeoutMs: z.number().int().positive(),
    enabled: z.boolean(),
    retry: z.strictObject({ count: z.number().int() }).optional(),
  });
  const write = async (name: string, text: string): Promise<string> => {
    const path = join(dir, name);
    await Bun.write(path, text);
    return path;
  };
  const VALID = "name: desk\ntimeoutMs: 1\nenabled: true\n";

  test("reads, parses and validates; YAML, JSON5 and TOML give the same value", async () => {
    const yaml = join(dir, "desk.yaml");
    const json5 = join(dir, "desk.json5");
    const toml = join(dir, "desk.toml");
    await Bun.write(yaml, "name: desk\ntimeoutMs: 20000\nenabled: true\n");
    await Bun.write(json5, "{name: 'desk', timeoutMs: 20000, enabled: true,}");
    await Bun.write(toml, 'name = "desk"\ntimeoutMs = 20000\nenabled = true\n');
    const expected = { name: "desk", timeoutMs: 20_000, enabled: true };
    expect(await readConfig(yaml, Desk)).toEqual(expected);
    expect(await readConfig(json5, Desk)).toEqual(expected);
    expect(await readConfig(toml, Desk)).toEqual(expected);
  });

  test("schema failures name the file and every bad field", async () => {
    const path = join(dir, "bad.yml");
    await Bun.write(path, "name: desk\ntimeoutMs: -1\nenabled: yes\n");
    const failure = readConfig(path, Desk);
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(`${path}: timeoutMs: `);
    await expect(failure).rejects.toThrow("; enabled: ");
  });

  test("a missing file and a directory are usage errors naming the path", async () => {
    const missing = join(dir, "missing.yaml");
    await expect(readConfig(missing, Desk)).rejects.toThrow(
      `${missing}: config file not found`,
    );
    const folder = join(dir, "folder.yaml");
    mkdirSync(folder);
    await expect(readConfig(folder, Desk)).rejects.toThrow(
      `${folder}: is a directory`,
    );
  });

  test("a mistyped key is an error, not silently stripped", async () => {
    const path = await write("typo.yaml", `${VALID}retyr: {count: 2}\n`);
    await expect(readConfig(path, Desk)).rejects.toThrow(
      `${path}: (root): Unrecognized key: "retyr"`,
    );
  });

  test("a stripping z.object schema is refused before it can hide a typo", () => {
    expect(() => validateConfig({}, z.object({}))).toThrow(
      "use z.strictObject, not z.object",
    );
    expect(validateConfig({ a: 1 }, z.looseObject({}))).toEqual({ a: 1 });
  });

  test("a nested failure names the full field path", async () => {
    const path = await write("nested.yaml", `${VALID}retry:\n  count: three\n`);
    await expect(readConfig(path, Desk)).rejects.toThrow(
      `${path}: retry.count: Invalid input: expected number, received string`,
    );
  });

  test("an empty or comment-only file says so instead of failing the schema", async () => {
    for (const [name, text] of [
      ["empty.yaml", ""],
      ["blank.json5", "  \n\t\n"],
    ] as const) {
      const path = await write(name, text);
      await expect(readConfig(path, Desk)).rejects.toThrow(
        `${path}: config is empty`,
      );
    }
    for (const name of ["comments.yaml", "comments.toml"]) {
      const comments = await write(name, "# nothing yet\n");
      await expect(readConfig(comments, Desk)).rejects.toThrow(
        `${comments}: config has no content`,
      );
    }
  });

  test("a UTF-8 BOM parses in every format", async () => {
    const yaml = await write("bom.yaml", `\uFEFF${VALID}`);
    const json5 = await write(
      "bom.json5",
      "\uFEFF{name: 'desk', timeoutMs: 1, enabled: true}",
    );
    const toml = await write(
      "bom.toml",
      '\uFEFFname = "desk"\ntimeoutMs = 1\nenabled = true\n',
    );
    expect((await readConfig(yaml, Desk)).name).toBe("desk");
    expect((await readConfig(json5, Desk)).name).toBe("desk");
    expect((await readConfig(toml, Desk)).name).toBe("desk");
  });

  test("a file:// URL reads the file; other schemes are refused before any read", async () => {
    const path = await write("url.yaml", VALID);
    expect((await readConfig(Bun.pathToFileURL(path).href, Desk)).name).toBe(
      "desk",
    );
    await expect(
      readConfig("https://evil.example/cfg.yaml", Desk),
    ).rejects.toThrow("only local paths and file:// URLs are accepted");
  });
});
