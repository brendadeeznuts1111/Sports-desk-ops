import { describe, expect, test } from "bun:test";

import {
  BUN_ANSI_THEME_REFERENCE_URL,
  BUN_ORIGIN,
  bunReferenceUrl,
  bunUrl,
  canonicalBunUrl,
  findBunReferenceSymbolsInText,
  linkifyBunSymbolsInMarkdown,
  matchBunReferenceSymbol,
  parseBunReferenceUrl,
  resolveBunSymbolReferenceUrl,
  textFragment,
} from "../lib/bun_urls.ts";

describe("bunUrl", () => {
  test("builds on https://bun.com and keeps the literal type", () => {
    const url: "https://bun.com/docs/runtime/cron" =
      bunUrl("/docs/runtime/cron");
    expect(url).toBe("https://bun.com/docs/runtime/cron");
    expect(BUN_ORIGIN).toBe("https://bun.com");
  });

  test("keeps fragments and text fragments verbatim", () => {
    expect(bunUrl("/blog/bun-v1.4#bun-terminal:~:text=a%20b")).toBe(
      "https://bun.com/blog/bun-v1.4#bun-terminal:~:text=a%20b",
    );
  });

  test("rejects a trailing slash, which bun.com 308-redirects", () => {
    expect(() => bunUrl("/docs/runtime/")).toThrow("must not end");
    expect(bunUrl("/")).toBe("https://bun.com/");
  });

  test("rejects a doubled slash", () => {
    expect(() => bunUrl("//evil.example/x")).toThrow("one absolute path");
    expect(() => bunUrl("/docs//cron")).toThrow("one absolute path");
  });
});

describe("bunReferenceUrl", () => {
  test("globals/bun/<Symbol> is the reference shape", () => {
    const url: "https://bun.com/reference/globals/bun/ImportKind" =
      bunReferenceUrl("globals/bun/ImportKind");
    expect(url).toBe("https://bun.com/reference/globals/bun/ImportKind");
  });

  test("a trailing slash on the symbol path is rejected", () => {
    expect(() => bunReferenceUrl("globals/bun/")).toThrow("must not end");
  });
});

describe("textFragment", () => {
  test("rebuilds the globals-reference module-list link exactly", () => {
    expect(
      bunUrl(
        `/reference/globals/bun#${textFragment({
          prefix: "node:zlib/iter",
          start: "MODULE",
          end: "YAML related APIs",
          suffix: "Ask AI",
        })}`,
      ),
    ).toBe(
      "https://bun.com/reference/globals/bun#:~:text=node%3Azlib/iter-,MODULE,YAML%20related%20APIs,-Ask%20AI",
    );
  });

  test("a start-only directive after an element id", () => {
    expect(
      bunUrl(`/blog/bun-v1.4#bun-terminal${textFragment({ start: "a b" })}`),
    ).toBe("https://bun.com/blog/bun-v1.4#bun-terminal:~:text=a%20b");
  });

  test("the directive delimiters - , & are escaped inside a part", () => {
    expect(textFragment({ start: "1-3, a&b" })).toBe(
      ":~:text=1%2D3%2C%20a%26b",
    );
  });

  test("an empty part is rejected", () => {
    expect(() => textFragment({ start: "" })).toThrow("must not be empty");
    expect(() => textFragment({ start: "x", suffix: "" })).toThrow(
      "must not be empty",
    );
  });

  test("canonicalBunUrl keeps a text fragment byte for byte across hosts", () => {
    const fragment =
      "/reference/globals/bun#:~:text=node%3Azlib/iter-,MODULE,YAML%20related%20APIs,-Ask%20AI";
    expect(canonicalBunUrl(`https://bun.sh${fragment}`)).toBe(
      `https://bun.com${fragment}`,
    );
  });
});

describe("canonicalBunUrl", () => {
  const CANONICAL = "https://bun.com/reference/globals/bun/ImportKind";

  test("bun.sh, www., http and a trailing slash all map to the bun.com form", () => {
    for (const raw of [
      CANONICAL,
      "https://bun.sh/reference/globals/bun/ImportKind",
      "https://www.bun.sh/reference/globals/bun/ImportKind",
      "https://www.bun.com/reference/globals/bun/ImportKind",
      "http://bun.sh/reference/globals/bun/ImportKind/",
      "bun.sh/reference/globals/bun/ImportKind",
      "  HTTPS://BUN.SH/reference/globals/bun/ImportKind  ",
    ]) {
      expect(canonicalBunUrl(raw)).toBe(CANONICAL);
    }
  });

  test("query and text fragment survive unchanged", () => {
    expect(
      canonicalBunUrl(
        "https://bun.sh/blog/bun-v1.4?ref=x#bun-terminal:~:text=Pass%20terminal",
      ),
    ).toBe(
      "https://bun.com/blog/bun-v1.4?ref=x#bun-terminal:~:text=Pass%20terminal",
    );
  });

  test("the site root stays https://bun.com/", () => {
    expect(canonicalBunUrl("https://bun.sh")).toBe("https://bun.com/");
  });

  test("anything that is not Bun's site is null", () => {
    for (const raw of [
      "https://bun.sh.evil.example/docs",
      "https://evilbun.sh/docs",
      "https://bun.sh:8443/docs",
      // Joined at runtime: tests/fetch_url_credentials.test.ts bans credential URLs in source.
      ["https://user", "pw@bun.sh/docs"].join(":"),
      "javascript:alert(1)",
      "file:///bun.sh/docs",
      "",
      "not a url",
    ]) {
      expect(canonicalBunUrl(raw)).toBeNull();
    }
  });
});

describe("Bun reference symbol matching", () => {
  test("BUN_ANSI_THEME_REFERENCE_URL is the canonical AnsiTheme reference URL", () => {
    expect(BUN_ANSI_THEME_REFERENCE_URL).toBe(
      "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
    );
  });

  test("parseBunReferenceUrl extracts symbol, module, and canonical URL", () => {
    const ansi = parseBunReferenceUrl(
      "https://bun.sh/reference/globals/bun/markdown/AnsiTheme",
    );
    expect(ansi).toEqual({
      canonicalUrl: "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
      symbolPath: "globals/bun/markdown/AnsiTheme",
      modulePath: "globals/bun/markdown",
      symbolName: "AnsiTheme",
    });

    const importKind = parseBunReferenceUrl(
      "https://www.bun.com/reference/globals/bun/ImportKind",
    );
    expect(importKind).toEqual({
      canonicalUrl: "https://bun.com/reference/globals/bun/ImportKind",
      symbolPath: "globals/bun/ImportKind",
      modulePath: "globals/bun",
      symbolName: "ImportKind",
    });
  });

  test("parseBunReferenceUrl returns null for non-reference URLs", () => {
    expect(
      parseBunReferenceUrl("https://bun.com/docs/runtime/cron"),
    ).toBeNull();
    expect(parseBunReferenceUrl("https://bun.com/reference/")).toBeNull();
    expect(
      parseBunReferenceUrl("https://bun.com/reference/globals/"),
    ).toBeNull();
    expect(
      parseBunReferenceUrl("https://evil.com/reference/globals/bun/AnsiTheme"),
    ).toBeNull();
  });

  test("matchBunReferenceSymbol matches expected symbols", () => {
    const url = "https://bun.sh/reference/globals/bun/markdown/AnsiTheme";
    expect(matchBunReferenceSymbol(url, "AnsiTheme")).toBe(true);
    expect(matchBunReferenceSymbol(url, "ansitheme")).toBe(true);
    expect(matchBunReferenceSymbol(url, "ANSITHEME")).toBe(true);

    expect(matchBunReferenceSymbol(url, "ansitheme", { exactCase: true })).toBe(
      false,
    );
    expect(matchBunReferenceSymbol(url, "AnsiTheme", { exactCase: true })).toBe(
      true,
    );

    expect(matchBunReferenceSymbol(url, "ImportKind")).toBe(false);
    expect(
      matchBunReferenceSymbol("https://bun.com/docs/runtime/cron", "AnsiTheme"),
    ).toBe(false);
  });

  test("resolveBunSymbolReferenceUrl resolves known symbols to canonical URLs", () => {
    expect(resolveBunSymbolReferenceUrl("AnsiTheme")).toBe(
      "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
    );
    expect(resolveBunSymbolReferenceUrl("`AnsiTheme`")).toBe(
      "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.ansi")).toBe(
      "https://bun.com/reference/globals/bun/markdown/ansi",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.inspect.custom")).toBe(
      "https://bun.com/reference/globals/bun/inspect",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Terminal")).toBe(
      "https://bun.com/reference/globals/bun/Terminal",
    );
    expect(
      resolveBunSymbolReferenceUrl("unknown_nonexistent_symbol"),
    ).toBeNull();
  });

  test("findBunReferenceSymbolsInText extracts symbols present in text", () => {
    const text =
      "Use `AnsiTheme` along with Bun.markdown.ansi and Bun.serve to build CLI tools.";
    const symbols = findBunReferenceSymbolsInText(text);
    const names = symbols.map((s) => s.symbolName);
    expect(names).toContain("AnsiTheme");
    expect(names).toContain("ansi");
    expect(names).toContain("serve");
  });

  test("linkifyBunSymbolsInMarkdown transforms code spans into OSC 8 markdown links", () => {
    const input =
      "Configure styling with `AnsiTheme` and render using `Bun.markdown.ansi`.";
    const linked = linkifyBunSymbolsInMarkdown(input);
    expect(linked).toContain(
      "[`AnsiTheme`](https://bun.com/reference/globals/bun/markdown/AnsiTheme)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.ansi`](https://bun.com/reference/globals/bun/markdown/ansi)",
    );
  });
});
