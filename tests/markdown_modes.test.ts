import { describe, expect, test } from "bun:test";

/**
 * What the four Markdown modes actually do with the constructs that were supposed to make HTML and
 * ANSI disagree.
 *
 * The current guide lists `wikiLinks`, `underline` and `latexMath` as opt-in (default `false`).
 * Measured on 1.4.4: only `wikiLinks` changes output, and only when passed to `html()`; `underline`
 * and `latexMath` are inert. These tests pin the observed behaviour, so a Bun change surfaces here
 * instead of silently altering a rendered doc.
 */
describe("markdown mode divergence", () => {
  const SAMPLE = "__x__ and [[page]] and $x^2$";

  test("ansi leaves wiki links, underline and math literal", () => {
    const ansi = Bun.markdown
      .ansi(SAMPLE, { colors: false, columns: 0 })
      .trim();
    expect(ansi).toContain("[[page]]");
    expect(ansi).toContain("$x^2$");
    expect(ansi).not.toContain("x-wikilink");
  });

  // Measured 2026-11-11 on Bun 1.4.4: `hyperlinks` emits an OSC 8 sequence only while colors
  // are enabled — `colors: false` drops the link wrapper along with the styling, so a caller that
  // disables color for a non-TTY also loses the hyperlink.
  test("hyperlinks emits OSC 8 only while colors are on", () => {
    const link = "[docs](https://bun.sh)";
    expect(Bun.markdown.ansi(link)).not.toContain("\u001b]8;;");
    expect(Bun.markdown.ansi(link, { hyperlinks: true })).toContain(
      "\u001b]8;;https://bun.sh",
    );
    expect(
      Bun.markdown.ansi(link, { hyperlinks: true, colors: false }),
    ).not.toContain("\u001b]8;;");
  });

  test("columns wraps to the given width; 0 disables wrapping", () => {
    const words = "word ".repeat(30).trim();
    const widths = Bun.markdown
      .ansi(words, { columns: 40, colors: false })
      .split("\n")
      .filter(Boolean)
      .map((line) => line.length);
    expect(widths.length).toBeGreaterThan(1);
    expect(widths.every((width) => width <= 40)).toBe(true);
    expect(
      Bun.markdown.ansi(words, { columns: 0 }).split("\n").filter(Boolean),
    ).toHaveLength(1);
  });

  test("html only diverges when wikiLinks is enabled", () => {
    expect(Bun.markdown.html(SAMPLE).trim()).toContain("[[page]]");
    const linked = Bun.markdown.html(SAMPLE, { wikiLinks: true });
    expect(linked).toContain('<x-wikilink data-target="page">');
  });

  test("underline and latexMath are inert for these inputs", () => {
    for (const markdown of ["__x__", "a __b__ c"]) {
      expect(Bun.markdown.html(markdown, { underline: true })).toBe(
        Bun.markdown.html(markdown),
      );
    }
    for (const markdown of ["$x^2$", "$40$", "Risk $40 and $50"]) {
      expect(Bun.markdown.html(markdown, { latexMath: true })).toBe(
        Bun.markdown.html(markdown),
      );
    }
  });

  test("render() passes text through when no callbacks are given", () => {
    expect(Bun.markdown.render(SAMPLE, {}, {})).toContain("[[page]]");
  });

  test("fenced code keeps the info-string as a language class", () => {
    const html = Bun.markdown.html("```ts\nconst x: number = 1\n```");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("const x: number = 1");

    const custom = Bun.markdown.render("```js\nconsole.log(1)\n```", {
      code: (children, meta) =>
        `<pre data-language="${meta?.language ?? ""}">${children}</pre>`,
    });
    expect(custom).toBe('<pre data-language="js">console.log(1)\n</pre>');
  });

  test("autolinks are opt-in, and headings accept the partial { ids: true } shape", () => {
    const plain = Bun.markdown.html("Visit www.example.com");
    expect(plain).not.toContain("<a ");
    const linked = Bun.markdown.html("Visit www.example.com", {
      autolinks: true,
    });
    expect(linked).toContain('<a href="http://www.example.com">');

    // The guide's granular form is accepted at runtime: id, no heading anchor.
    const idsOnly = Bun.markdown.html("## Hello World", {
      headings: { ids: true },
    });
    expect(idsOnly).toContain('<h2 id="hello-world">Hello World</h2>');
    expect(idsOnly).not.toContain('<a href="#hello-world">');
  });

  test("react() uses the React 19 element symbol, and reactVersion: 18 opts down", () => {
    const element = Bun.markdown.react("# Hello") as {
      readonly $$typeof?: symbol;
    };
    expect(element.$$typeof).toBe(Symbol.for("react.transitional.element"));

    const legacy = Bun.markdown.react("# Hello", undefined, {
      reactVersion: 18,
    }) as { readonly $$typeof?: symbol };
    expect(legacy.$$typeof).toBe(Symbol.for("react.element"));
  });
});
