import { describe, expect, test } from "bun:test";
import {
  decodeEntities,
  extractLinks,
  htmlToText,
  stripNonContent,
} from "../lib/ticket_html.ts";

const PAGE = `<!doctype html><html><head>
<style>.label { color: red }</style>
<script>const secret = "not-content";</script>
</head><body>
  <h1>Ticket 990001</h1>
  <p>Amount: 40 &amp; fee &#36;2</p>
  <table><tr><td>Risk</td><td>$4,000</td></tr></table>
  <a href="/manager/wager?id=1">Open <b>wager</b></a><br>
  <a href="">no href</a>
  <noscript>enable js</noscript>
  <script>bad()</script>
</body></html>`;

describe("ticket html", () => {
  test("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#36;2 &#x41; &nbsp;")).toBe(
      "a & b <c> $2 A  ",
    );
    expect(decodeEntities("&unknown; stays")).toBe("&unknown; stays");
    expect(decodeEntities("Culiac&aacute;n &amp; Cañeros")).toBe(
      "Culiacán & Cañeros",
    );
    expect(htmlToText("<p>Culiac&aacute;n</p>")).toBe("Culiacán");
  });

  test("handles invalid, NUL and surrogate numeric codepoints safely without throwing", () => {
    expect(() =>
      decodeEntities(
        "&#-1; &#0; &#x0; &#x110000; &#xD800; &#xDFFF; &#99999999;",
      ),
    ).not.toThrow();
    expect(
      decodeEntities(
        "&#-1; &#0; &#x0; &#x110000; &#xD800; &#xDFFF; &#99999999;",
      ),
    ).toBe("&#-1; &#0; &#x0; &#x110000; &#xD800; &#xDFFF; &#99999999;");
  });

  test("strips script, style and noscript bodies", () => {
    const stripped = stripNonContent(PAGE);
    expect(stripped).not.toContain("not-content");
    expect(stripped).not.toContain("bad()");
    expect(stripped).not.toContain("enable js");
    expect(stripped).toContain("Ticket 990001");
  });

  test("renders readable text with block separation", () => {
    const text = htmlToText(PAGE);
    expect(text).toContain("Ticket 990001");
    expect(text).toContain("Amount: 40 & fee $2");
    expect(text).toContain("Risk");
    expect(text).toContain("$4,000");
    expect(text.split("\n").length).toBeGreaterThan(3);
    expect(text).not.toContain("not-content");
  });

  test("extracts links with nested markup and drops empty hrefs", () => {
    expect(extractLinks(PAGE)).toEqual([
      { href: "/manager/wager?id=1", text: "Open wager" },
    ]);
  });

  test("a void element does not throw for a missing end tag", () => {
    expect(() => htmlToText("<p>a<br>b</p>")).not.toThrow();
    expect(htmlToText("<p>a<br>b</p>")).toBe("a\nb");
  });

  test("entities split across text nodes still decode", () => {
    // HTMLRewriter emits "&am" + "p;" as separate chunks for this markup in some paths; joining
    // before decoding is what makes it correct.
    expect(htmlToText("<p>&amp;</p>")).toBe("&");
  });
});
