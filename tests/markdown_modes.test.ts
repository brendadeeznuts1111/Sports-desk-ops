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
