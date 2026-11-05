import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import rssFixture from "./fixtures/bun-xml-golden-ast/rss-multi-item-channel-semver.xml";

/**
 * Pins the documented `Bun.XML` contract the ingestion paths depend on: the two result shapes,
 * internal vs external entities, byte decoding, and the `parse(stringify(x))` round-trip.
 *
 * The replay hashes use `{ compact: false }`, while the parse endpoints and F402 helpers use the
 * compact shape; a Bun change to either is a data-contract change, not a cosmetic one.
 */

function serialize(value: Bun.XML.Document | Bun.XML.NodeInput): string {
  const text = Bun.XML.stringify(value);
  if (text === undefined) throw new Error("XML.stringify returned undefined");
  return text;
}

describe("Bun.XML contract", () => {
  test("compact shape keeps attributes, repeated children and #text", () => {
    expect(
      Bun.XML.parse(
        `<order id="A1"><item sku="x">Tea</item><item sku="y">Mug</item><paid/></order>`,
      ),
    ).toEqual({
      order: {
        "@id": "A1",
        item: [
          { "@sku": "x", "#text": "Tea" },
          { "@sku": "y", "#text": "Mug" },
        ],
        paid: "",
      },
    });

    // Text runs concatenate; layout-only whitespace between elements is dropped.
    expect(Bun.XML.parse("<p>Hello <b>world</b>!  </p>")).toEqual({
      p: { "#text": "Hello !  ", b: "world" },
    });
    // Attribute-value normalization folds tab/newline into spaces.
    expect(Bun.XML.parse(`<a x="1\t2\n3"/>`)).toEqual({
      a: { "@x": "1 2 3" },
    });
  });

  test("compact keys follow first appearance and drop comments/PIs", () => {
    const doc = Bun.XML.parse(`<r a="1"><x/><y/><x/><z/></r>`) as {
      r: Record<string, unknown>;
    };
    // Duplicate child names collapse to one array-valued key at first appearance; document
    // order is otherwise preserved and attributes come first.
    expect(Object.keys(doc.r)).toEqual(["@a", "x", "y", "z"]);
    expect(Bun.XML.parse(`<p>a<!--x-->b<?go?></p>`)).toEqual({ p: "ab" });
  });

  test("parse returns the documented Document/Node types", () => {
    const compact: Bun.XML.Document = Bun.XML.parse("<a>1</a>");
    const full: Bun.XML.Node = Bun.XML.parse("<a>1</a>", {
      compact: false,
    });
    expect(compact).toEqual({ a: "1" });
    expect(full.name).toBe("a");
  });

  test("importing .xml evaluates to the compact Document", async () => {
    const path = join(
      import.meta.dir,
      "fixtures/bun-xml-golden-ast/rss-multi-item-channel-semver.xml",
    );
    expect(rssFixture).toEqual(Bun.XML.parse(await Bun.file(path).text()));
  });

  test("the full shape keeps document order, comments and processing instructions", () => {
    expect(
      Bun.XML.parse(`<p>Hello <b>world</b>!<!-- bye --><?go now?></p>`, {
        compact: false,
      }),
    ).toEqual({
      name: "p",
      attributes: {},
      children: [
        "Hello ",
        { name: "b", attributes: {}, children: ["world"] },
        "!",
        { comment: " bye " },
        { target: "go", data: "now" },
      ],
    });
  });

  test("internal entities expand, external entities are never read", () => {
    expect(
      Bun.XML.parse(
        `<!DOCTYPE note [<!ENTITY who "world">]><note>Hello &who;</note>`,
      ),
    ).toEqual({ note: "Hello world" });

    // XML 1.0 §4.1: an entity only an unread external DTD could declare stays literal.
    expect(
      Bun.XML.parse(
        `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`,
      ),
    ).toEqual({ foo: "&xxe;" });

    // An external DTD declaration is not read either: the document parses, the DTD is ignored.
    expect(
      Bun.XML.parse(`<!DOCTYPE foo SYSTEM "file:///etc/passwd"><foo/>`),
    ).toEqual({ foo: "" });
  });

  test("DTD attribute defaults, CDATA and namespace attributes", () => {
    expect(
      Bun.XML.parse(`<!DOCTYPE a [<!ATTLIST a x CDATA "d">]><a/>`),
    ).toEqual({ a: { "@x": "d" } });

    // CDATA and character references are expanded; adjacent text merges into one string.
    expect(Bun.XML.parse(`<p>a<![CDATA[<b>&]]>c&#233;</p>`)).toEqual({
      p: "a<b>&cé",
    });
    expect(
      Bun.XML.parse(`<p>a<![CDATA[<b>&]]>c&#233;</p>`, { compact: false }),
    ).toEqual({ name: "p", attributes: {}, children: ["a<b>&cé"] });

    // Namespace declarations are ordinary attributes; prefixes stay in the element name.
    expect(Bun.XML.parse(`<soap:Envelope xmlns:soap="urn:x"/>`)).toEqual({
      "soap:Envelope": { "@xmlns:soap": "urn:x" },
    });
  });

  test("entity amplification and nesting depth fail closed", () => {
    const entities = [`<!ENTITY e0 "x">`];
    for (let level = 1; level <= 6; level++) {
      entities.push(`<!ENTITY e${level} "${`&e${level - 1};`.repeat(10)}">`);
    }
    expect(() =>
      Bun.XML.parse(`<!DOCTYPE r [${entities.join("")}]><r>&e6;</r>`),
    ).toThrow(/amplification limit/);

    const deep = `${"<a>".repeat(50_000)}x${"</a>".repeat(50_000)}`;
    expect(() => Bun.XML.parse(deep)).toThrow(/call stack|too deeply/i);
  });

  test("bytes honor the BOM or the XML encoding declaration", () => {
    const encoder = new TextEncoder();
    const iso = new Uint8Array([
      ...encoder.encode(`<?xml version="1.0" encoding="ISO-8859-1"?><a>`),
      0xe9, // é in ISO-8859-1
      ...encoder.encode("</a>"),
    ]);
    expect(Bun.XML.parse(iso)).toEqual({ a: "é" });

    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...new Uint8Array(Buffer.from("<a>é</a>", "utf16le")),
    ]);
    expect(Bun.XML.parse(utf16)).toEqual({ a: "é" });

    const le = Buffer.from("<a>é</a>", "utf16le");
    const utf16be = new Uint8Array(2 + le.length);
    utf16be[0] = 0xfe;
    utf16be[1] = 0xff;
    for (let i = 0; i < le.length; i += 2) {
      utf16be[2 + i] = le[i + 1] as number;
      utf16be[2 + i + 1] = le[i] as number;
    }
    expect(Bun.XML.parse(utf16be)).toEqual({ a: "é" });

    const unsupported = encoder.encode(
      `<?xml version="1.0" encoding="Shift_JIS"?><a>1</a>`,
    );
    expect(() => Bun.XML.parse(unsupported)).toThrow(/Unsupported encoding/);
  });

  test("parse accepts Blob, ArrayBuffer and DataView", () => {
    expect(Bun.XML.parse(new Blob(["<a>1</a>"]))).toEqual({ a: "1" });
    expect(Bun.XML.parse(new TextEncoder().encode("<a>2</a>").buffer)).toEqual({
      a: "2",
    });
    expect(
      Bun.XML.parse(new DataView(new TextEncoder().encode("<a>3</a>").buffer)),
    ).toEqual({ a: "3" });
  });

  test("stringify round-trips both shapes", () => {
    const compact = Bun.XML.parse(
      `<order id="A1"><item sku="x">Tea</item><paid/></order>`,
    );
    expect(Bun.XML.parse(serialize(compact))).toEqual(compact);

    const node = Bun.XML.parse(`<p class="x">Hi <b>!</b><!-- bye --></p>`, {
      compact: false,
    });
    expect(Bun.XML.parse(serialize(node), { compact: false })).toEqual(node);

    // Neither shape represents the XML declaration or the DTD; stringify emits the element only.
    const declared = Bun.XML.parse(
      `<?xml version="1.0" encoding="UTF-8"?><a>1</a>`,
    );
    expect(serialize(declared)).toBe("<a>1</a>");
  });

  test("stringify escapes text and rejects invalid names", () => {
    expect(
      Bun.XML.stringify({
        order: { "@id": "A&1", item: ["<Tea>"], paid: null },
      }),
    ).toBe('<order id="A&amp;1"><item>&lt;Tea&gt;</item><paid/></order>');
    expect(Bun.XML.stringify({ a: { "@x": null, "@y": "1" } })).toBe(
      '<a y="1"/>',
    );
    expect(() => Bun.XML.stringify({ "bad name": "x" })).toThrow(
      /not a valid XML element name/,
    );
  });

  test("stringify renders scalars, comments, PIs and indentation", () => {
    expect(
      Bun.XML.stringify({
        name: "n",
        children: [1, true, 2n, new Date("2020-01-01T00:00:00.000Z")],
      }),
    ).toBe("<n>1true22020-01-01T00:00:00.000Z</n>");

    // Element-only content is indented; a text child keeps the element on one line.
    expect(
      Bun.XML.stringify(
        { name: "a", children: [{ name: "b", children: ["x"] }] },
        null,
        2,
      ),
    ).toBe("<a>\n  <b>x</b>\n</a>");
    expect(
      Bun.XML.stringify(
        { name: "a", children: ["t", { name: "b", children: ["x"] }] },
        null,
        2,
      ),
    ).toBe("<a>t<b>x</b></a>");

    expect(
      Bun.XML.stringify({
        name: "a",
        children: [{ comment: "x" }, { target: "go", data: "now" }],
      }),
    ).toBe("<a><!--x--><?go now?></a>");
  });

  test("stringify rejects values XML cannot represent", () => {
    expect(() => Bun.XML.stringify({ a: "\u0000" })).toThrow(/U\+0000/);
    expect(() =>
      Bun.XML.stringify({ name: "a", children: [{ comment: "x--y" }] }),
    ).toThrow(/comment/);
    expect(() =>
      Bun.XML.stringify({
        name: "a",
        children: [{ target: "go", data: "x?>y" }],
      }),
    ).toThrow(/processing instruction/);

    type CircularNode = { name: string; children: CircularNode[] };
    const circular: CircularNode = { name: "a", children: [] };
    circular.children.push(circular);
    expect(() => Bun.XML.stringify(circular)).toThrow(/circular/i);

    expect(Bun.XML.stringify(undefined)).toBeUndefined();
    expect(Bun.XML.stringify(() => 1)).toBeUndefined();
  });

  test("stringify caps indentation at ten characters", () => {
    const node = { name: "a", children: [{ name: "b" }] };
    expect(Bun.XML.stringify(node, null, 20)).toBe("<a>\n          <b/>\n</a>");
    expect(Bun.XML.stringify(node, null, "abcdefghijkl")).toBe(
      "<a>\nabcdefghij<b/>\n</a>",
    );
  });
});
