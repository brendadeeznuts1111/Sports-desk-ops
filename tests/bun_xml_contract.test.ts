import { describe, expect, test } from "bun:test";

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

    const unsupported = encoder.encode(
      `<?xml version="1.0" encoding="Shift_JIS"?><a>1</a>`,
    );
    expect(() => Bun.XML.parse(unsupported)).toThrow(/Unsupported encoding/);
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
  });

  test("stringify escapes text and rejects invalid names", () => {
    expect(
      Bun.XML.stringify({
        order: { "@id": "A&1", item: ["<Tea>"], paid: null },
      }),
    ).toBe('<order id="A&amp;1"><item>&lt;Tea&gt;</item><paid/></order>');
    expect(() => Bun.XML.stringify({ "bad name": "x" })).toThrow(
      /not a valid XML element name/,
    );
  });
});
