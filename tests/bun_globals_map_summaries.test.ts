/**
 * Unit fixtures for `lib/bun_globals_map_summaries.ts`.
 *
 * These exercise the branches the committed artifact cannot: parser grammar (implements, generic
 * type arguments, module/namespace scope), external-base corroboration, merged-symbol row accuracy,
 * self-edges, idempotency, and the two suppression passes composing.
 */
import { describe, expect, test } from "bun:test";
import {
  baseNames,
  findFalsifiedTypeOnlyClaims,
  findInheritedSummaries,
  parseTypeScriptBases,
  quotesBaseReference,
  suppressFalsifiedTypeOnlySummaries,
  suppressInheritedSummaries,
  suppressSummaryDefects,
  TYPE_ONLY_CLAIM,
} from "../lib/bun_globals_map_summaries.ts";

type Row = {
  readonly symbol: string;
  readonly kind: string;
  readonly summary: string;
};

const row = (symbol: string, kind: string, summary: string): Row => ({
  symbol,
  kind,
  summary,
});

const bunModule = (body: string): string =>
  `declare module "bun" {\n${body}\n}\n`;

const declarationsOf = (source: string) =>
  parseTypeScriptBases(source, { module: "bun" });

describe("parseTypeScriptBases", () => {
  test("parses implements-only and modified declarations", () => {
    const parsed = declarationsOf(
      bunModule(
        [
          "class Terminal implements AsyncDisposable {}",
          "class CookieMap implements Iterable<[string, string]> {}",
          "declare class Declared {}",
          "export default class Defaulted {}",
        ].join("\n"),
      ),
    );
    expect(parsed.get("Terminal")?.hasOwnJsDoc).toBe(false);
    expect(parsed.get("CookieMap")?.hasOwnJsDoc).toBe(false);
    expect(parsed.get("Declared")).toBeDefined();
    expect(parsed.get("Defaulted")).toBeDefined();
  });

  test("type arguments are not base types", () => {
    const parsed = declarationsOf(
      bunModule(
        "interface SpawnOptions extends BaseOptions<In, Out, Err> {}\n" +
          "interface Nested extends Map<string, Array<number>> {}",
      ),
    );
    expect(parsed.get("SpawnOptions")?.bases).toEqual(["BaseOptions"]);
    expect(parsed.get("Nested")?.bases).toEqual(["Map"]);
  });

  test("qualified bases keep the module symbol and reject self-edges", () => {
    const parsed = declarationsOf(
      bunModule(
        [
          "interface TLSOptions extends Bun.TLSOptions {}",
          "interface Wrapped extends Buffer {}",
        ].join("\n"),
      ),
    );
    expect(parsed.get("TLSOptions")?.bases).toEqual([]);
    expect(parsed.get("Wrapped")?.bases).toEqual(["Buffer"]);
  });

  test("baseNames handles comments and implements tails", () => {
    expect(baseNames("A /* why */, B implements C", "X")).toEqual(["A", "B"]);
    expect(baseNames("__internal.LibWorkerOrBunWorker", "Worker")).toEqual([]);
  });

  test("module scope ignores top-level DOM re-declarations and nested namespaces", () => {
    const source = [
      "interface Worker extends Bogus {}",
      'declare module "bun" {',
      "  namespace WebAssembly {",
      "    interface ValueTypeMap {}",
      "  }",
      "  interface Worker extends EventTarget, AbstractWorker {}",
      "}",
    ].join("\n");
    const scoped = declarationsOf(source);
    expect(scoped.get("Worker")?.bases).toEqual([
      "EventTarget",
      "AbstractWorker",
    ]);
    expect(scoped.has("ValueTypeMap")).toBe(false);
  });
});

describe("quotesBaseReference", () => {
  test("recognises the base's own MDN page", () => {
    expect(
      quotesBaseReference(
        "An event which takes place in the DOM. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event)",
        "Event",
      ),
    ).toBe(true);
    expect(quotesBaseReference("A websocket.", "Event")).toBe(false);
  });
});

describe("findInheritedSummaries", () => {
  test("external base with an MDN reference is a borrowed summary", () => {
    const rows = [
      row(
        "globals.bun.FetchEvent",
        "interface",
        "An event which takes place in the DOM. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event)",
      ),
    ];
    const declarations = declarationsOf(
      bunModule("interface FetchEvent extends Event {}"),
    );
    const claims = findInheritedSummaries(rows, declarations);
    expect(claims).toEqual([
      {
        symbol: "globals.bun.FetchEvent",
        reason: "inherited-from-base",
        detail: "Event",
        upstreamSummary:
          "An event which takes place in the DOM. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Event)",
      },
    ]);
  });

  test("external base with an identical sibling is corroborated", () => {
    const text =
      "EventTarget is a DOM interface implemented by objects that can receive events.";
    const rows = [
      row("globals.bun.EventSource", "class", text),
      row("globals.bun.Worker", "class", text),
    ];
    const declarations = declarationsOf(
      bunModule(
        "interface EventSource extends EventTarget {}\ninterface Worker extends EventTarget, AbstractWorker {}",
      ),
    );
    const claims = findInheritedSummaries(rows, declarations);
    expect(claims.map((claim) => claim.detail)).toEqual([
      "EventTarget",
      "EventTarget",
    ]);
  });

  test("another row of the same symbol cannot corroborate itself", () => {
    const text =
      "EventTarget is a DOM interface implemented by objects that can receive events.";
    const rows = [
      row("globals.bun.EventSource", "class", text),
      row("globals.bun.EventSource", "namespace", text),
    ];
    const declarations = declarationsOf(
      bunModule("interface EventSource extends EventTarget {}"),
    );
    expect(findInheritedSummaries(rows, declarations)).toEqual([]);
  });

  test("a merged base symbol resolves through its class/interface row", () => {
    const rows = [
      row("globals.bun.file", "function", "Open a file as a BunFile."),
      row("globals.bun.BunFile", "interface", "Blob powered by fast syscalls."),
      row(
        "globals.bun.FileBlob",
        "interface",
        "Blob powered by fast syscalls.",
      ),
    ];
    const declarations = declarationsOf(
      bunModule(
        "/** own */\ninterface BunFile extends Blob {}\ninterface FileBlob extends BunFile {}",
      ),
    );
    const claims = findInheritedSummaries(rows, declarations);
    expect(claims.map((claim) => `${claim.symbol}<-${claim.detail}`)).toEqual([
      "globals.bun.FileBlob<-BunFile",
    ]);
  });

  test("types-only rows belong to the falsified pass, not this one", () => {
    const rows = [
      row("globals.bun.MD5", "class", "This class only exists in types"),
      row("globals.bun.Base", "class", "This class only exists in types"),
    ];
    const declarations = declarationsOf(
      bunModule("interface Base {}\nclass MD5 extends Base {}"),
    );
    expect(findInheritedSummaries(rows, declarations)).toEqual([]);
  });
});

describe("suppression passes", () => {
  test("row-accurate clearing keeps a merged symbol's own namespace summary", () => {
    const rows = [
      row("globals.bun.Child", "class", "Base docs"),
      row("globals.bun.Child", "namespace", "Own namespace docs"),
      row("globals.bun.Base", "class", "Base docs"),
    ];
    const declarations = declarationsOf(
      bunModule(
        "/** own */\ninterface Base {}\ninterface Child extends Base {}",
      ),
    );
    const { rows: patched, suppressed } = suppressInheritedSummaries(
      rows,
      declarations,
    );
    expect(suppressed.map((claim) => claim.symbol)).toEqual([
      "globals.bun.Child",
    ]);
    expect(patched).toEqual([
      { symbol: "globals.bun.Child", kind: "class", summary: "" },
      {
        symbol: "globals.bun.Child",
        kind: "namespace",
        summary: "Own namespace docs",
      },
      { symbol: "globals.bun.Base", kind: "class", summary: "Base docs" },
    ]);
  });

  test("falsified claims use property existence, not the read value", () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "MD5", {
      get() {
        throw new Error("boom");
      },
    });
    expect(
      findFalsifiedTypeOnlyClaims(
        [row("globals.bun.MD5", "class", "This class only exists in types")],
        throwing,
      ).length,
    ).toBe(1);
  });

  test("combined pass clears both defect classes and is idempotent", () => {
    const rows = [
      row("globals.bun.MD5", "class", "This class only exists in types"),
      row("globals.bun.Child", "class", "Base docs"),
      row("globals.bun.Base", "class", "Base docs"),
    ];
    const declarations = declarationsOf(
      bunModule("interface Base {}\ninterface Child extends Base {}"),
    );
    const first = suppressSummaryDefects(rows, {
      runtime: { MD5: function MD5() {} },
      declarations,
    });
    expect(first.suppressed.map((claim) => claim.reason).sort()).toEqual([
      "inherited-from-base",
      "types-only-falsified",
    ]);
    expect(first.rows.map((patched) => patched.summary)).toEqual([
      "",
      "",
      "Base docs",
    ]);
    const second = suppressSummaryDefects(first.rows, {
      runtime: { MD5: function MD5() {} },
      declarations,
    });
    expect(second.suppressed).toEqual([]);
    expect(second.rows).toEqual(first.rows);
  });

  test("falsified suppression leaves unrelated rows untouched", () => {
    const rows = [
      row("globals.bun.MD5", "class", "This class only exists in types"),
      row("globals.bun.Keep", "class", "A real summary"),
    ];
    const { rows: patched, suppressed } = suppressFalsifiedTypeOnlySummaries(
      rows,
      { MD5: function MD5() {} },
    );
    expect(suppressed.length).toBe(1);
    expect(patched[1]).toBe(rows[1]);
  });

  test("TYPE_ONLY_CLAIM is the single source for the claim text", () => {
    expect(TYPE_ONLY_CLAIM.test("This class only exists in types")).toBe(true);
  });
});
