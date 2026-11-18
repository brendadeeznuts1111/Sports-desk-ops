import { describe, expect, test } from "bun:test";

import {
  BUN_ANSI_THEME_REFERENCE_URL,
  BUN_MARKDOWN_OPTIONS_REFERENCE_URL,
  BUN_ORIGIN,
  bunReferenceUrl,
  bunUrl,
  canonicalBunUrl,
  findBunReferenceSymbolsInText,
  linkifyBunSymbolsInMarkdown,
  matchBunReferenceSymbol,
  parseBunReferenceUrl,
  resolveBunSymbolReferenceUrl,
  sanitizeBunUrl,
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
  test("bun/<Symbol> is the reference shape", () => {
    const url: "https://bun.com/reference/bun/ImportKind" =
      bunReferenceUrl("bun/ImportKind");
    expect(url).toBe("https://bun.com/reference/bun/ImportKind");
  });

  test("a trailing slash on the symbol path is rejected", () => {
    expect(() => bunReferenceUrl("bun/")).toThrow("must not end");
  });
});

describe("textFragment", () => {
  test("rebuilds the reference module-list link exactly", () => {
    expect(
      bunUrl(
        `/reference/bun#${textFragment({
          prefix: "node:zlib/iter",
          start: "MODULE",
          end: "YAML related APIs",
          suffix: "Ask AI",
        })}`,
      ),
    ).toBe(
      "https://bun.com/reference/bun#:~:text=node%3Azlib/iter-,MODULE,YAML%20related%20APIs,-Ask%20AI",
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
      "/reference/bun#:~:text=node%3Azlib/iter-,MODULE,YAML%20related%20APIs,-Ask%20AI";
    expect(canonicalBunUrl(`https://bun.sh${fragment}`)).toBe(
      `https://bun.com${fragment}`,
    );
  });
});

describe("canonicalBunUrl", () => {
  const CANONICAL = "https://bun.com/reference/bun/ImportKind";

  test("bun.sh, www., http and a trailing slash all map to the bun.com form", () => {
    for (const raw of [
      CANONICAL,
      "https://bun.sh/reference/bun/ImportKind",
      "https://www.bun.sh/reference/bun/ImportKind",
      "https://www.bun.com/reference/bun/ImportKind",
      "http://bun.sh/reference/bun/ImportKind/",
      "bun.sh/reference/bun/ImportKind",
      "  HTTPS://BUN.SH/reference/bun/ImportKind  ",
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
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    expect(BUN_MARKDOWN_OPTIONS_REFERENCE_URL).toBe(
      "https://bun.com/reference/bun/markdown/Options",
    );
  });

  test("parseBunReferenceUrl extracts symbol, module, and canonical URL", () => {
    const ansi = parseBunReferenceUrl(
      "https://bun.sh/reference/bun/markdown/AnsiTheme",
    );
    expect(ansi).toEqual({
      canonicalUrl: "https://bun.com/reference/bun/markdown/AnsiTheme",
      symbolPath: "bun/markdown/AnsiTheme",
      modulePath: "bun/markdown",
      symbolName: "AnsiTheme",
    });

    const mdOptions = parseBunReferenceUrl(
      "https://bun.sh/reference/bun/markdown/Options",
    );
    expect(mdOptions).toEqual({
      canonicalUrl: "https://bun.com/reference/bun/markdown/Options",
      symbolPath: "bun/markdown/Options",
      modulePath: "bun/markdown",
      symbolName: "Options",
    });

    const importKind = parseBunReferenceUrl(
      "https://www.bun.com/reference/bun/ImportKind",
    );
    expect(importKind).toEqual({
      canonicalUrl: "https://bun.com/reference/bun/ImportKind",
      symbolPath: "bun/ImportKind",
      modulePath: "bun",
      symbolName: "ImportKind",
    });
  });

  test("a legacy globals/bun URL still parses, with its path preserved verbatim", () => {
    const legacy = parseBunReferenceUrl(
      "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
    );
    expect(legacy?.symbolPath).toBe("globals/bun/markdown/AnsiTheme");
    expect(legacy?.symbolName).toBe("AnsiTheme");
    // Parsing does not rewrite; resolveBunSymbolReferenceUrl does.
  });

  test("parseBunReferenceUrl returns null for non-reference URLs", () => {
    expect(
      parseBunReferenceUrl("https://bun.com/docs/runtime/cron"),
    ).toBeNull();
    expect(parseBunReferenceUrl("https://bun.com/reference/")).toBeNull();
    expect(parseBunReferenceUrl("https://bun.com/reference/bun/")).toBeNull();
    expect(
      parseBunReferenceUrl("https://evil.com/reference/bun/AnsiTheme"),
    ).toBeNull();
  });

  test("matchBunReferenceSymbol matches expected symbols", () => {
    const url = "https://bun.sh/reference/bun/markdown/AnsiTheme";
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
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    expect(resolveBunSymbolReferenceUrl("`AnsiTheme`")).toBe(
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.AnsiTheme")).toBe(
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    expect(resolveBunSymbolReferenceUrl("bun/markdown/AnsiTheme")).toBe(
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    // Legacy path input canonicalizes to the current shape.
    expect(resolveBunSymbolReferenceUrl("globals/bun/markdown/AnsiTheme")).toBe(
      "https://bun.com/reference/bun/markdown/AnsiTheme",
    );
    expect(
      resolveBunSymbolReferenceUrl(
        "https://bun.com/reference/globals/bun/markdown/AnsiTheme",
      ),
    ).toBe("https://bun.com/reference/bun/markdown/AnsiTheme");
    expect(
      resolveBunSymbolReferenceUrl(
        "https://bun.com/reference/bun/markdown/AnsiTheme",
      ),
    ).toBe("https://bun.com/reference/bun/markdown/AnsiTheme");
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.ansi")).toBe(
      "https://bun.com/reference/bun/markdown/ansi",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.Options")).toBe(
      "https://bun.com/reference/bun/markdown/Options",
    );
    expect(resolveBunSymbolReferenceUrl("bun.markdown.options")).toBe(
      "https://bun.com/reference/bun/markdown/Options",
    );
    expect(
      resolveBunSymbolReferenceUrl(
        "https://bun.sh/reference/bun/markdown/Options",
      ),
    ).toBe("https://bun.com/reference/bun/markdown/Options");
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.html")).toBe(
      "https://bun.com/reference/bun/markdown/html",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.render")).toBe(
      "https://bun.com/reference/bun/markdown/render",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.react")).toBe(
      "https://bun.com/reference/bun/markdown/react",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.ReactOptions")).toBe(
      "https://bun.com/reference/bun/markdown/ReactOptions",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.RenderCallbacks")).toBe(
      "https://bun.com/reference/bun/markdown/RenderCallbacks",
    );
    expect(
      resolveBunSymbolReferenceUrl("Bun.markdown.ComponentOverrides"),
    ).toBe("https://bun.com/reference/bun/markdown/ComponentOverrides");
    expect(resolveBunSymbolReferenceUrl("Bun.markdown.ListItemMeta")).toBe(
      "https://bun.com/reference/bun/markdown/ListItemMeta",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.inspect.custom")).toBe(
      "https://bun.com/reference/bun/inspect",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.inspect.table")).toBe(
      "https://bun.com/reference/bun/inspect",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.TOML")).toBe(
      "https://bun.com/reference/bun/TOML",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.TOML.stringify")).toBe(
      "https://bun.com/reference/bun/TOML/stringify",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Terminal")).toBe(
      "https://bun.com/reference/bun/Terminal",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.TerminalOptions")).toBe(
      "https://bun.com/reference/bun/TerminalOptions",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive")).toBe(
      "https://bun.com/reference/bun/Archive",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Image")).toBe(
      "https://bun.com/reference/bun/Image",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.FetchSession")).toBe(
      "https://bun.com/reference/bun/FetchSession",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.RedisClient")).toBe(
      "https://bun.com/reference/bun/RedisClient",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.WebView")).toBe(
      "https://bun.com/reference/bun/WebView",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.XML")).toBe(
      "https://bun.com/reference/bun/XML",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.JSONL")).toBe(
      "https://bun.com/reference/bun/JSONL",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.stringWidth")).toBe(
      "https://bun.com/reference/bun/stringWidth",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.connect")).toBe(
      "https://bun.com/reference/bun/connect",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.concatArrayBuffers")).toBe(
      "https://bun.com/reference/bun/concatArrayBuffers",
    );
    expect(
      resolveBunSymbolReferenceUrl("Bun.readableStreamToArrayBuffer"),
    ).toBe("https://bun.com/reference/bun/readableStreamToArrayBuffer");
    expect(resolveBunSymbolReferenceUrl("Bun.$")).toBe(
      "https://bun.com/reference/bun/$",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive.blob")).toBe(
      "https://bun.com/reference/bun/Archive/blob",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive.bytes")).toBe(
      "https://bun.com/reference/bun/Archive/bytes",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive.extract")).toBe(
      "https://bun.com/reference/bun/Archive/extract",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive.files")).toBe(
      "https://bun.com/reference/bun/Archive/files",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Archive.write")).toBe(
      "https://bun.com/reference/bun/Archive/write",
    );
    expect(resolveBunSymbolReferenceUrl("ArchiveInput")).toBe(
      "https://bun.com/reference/bun/ArchiveInput",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.ArchiveOptions")).toBe(
      "https://bun.com/reference/bun/ArchiveOptions",
    );
    expect(resolveBunSymbolReferenceUrl("ArchiveExtractOptions")).toBe(
      "https://bun.com/reference/bun/ArchiveExtractOptions",
    );
    expect(resolveBunSymbolReferenceUrl("bun:bundle")).toBe(
      "https://bun.com/reference/bun/bundle",
    );
    expect(resolveBunSymbolReferenceUrl("bun:ffi")).toBe(
      "https://bun.com/reference/bun/ffi",
    );
    expect(resolveBunSymbolReferenceUrl("bun:jsc")).toBe(
      "https://bun.com/reference/bun/jsc",
    );
    expect(resolveBunSymbolReferenceUrl("bun:sqlite")).toBe(
      "https://bun.com/reference/bun/sqlite",
    );
    expect(resolveBunSymbolReferenceUrl("bun:test")).toBe(
      "https://bun.com/reference/bun/test",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.cron")).toBe(
      "https://bun.com/reference/bun/cron",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.SQL")).toBe(
      "https://bun.com/reference/bun/SQL",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.S3Client")).toBe(
      "https://bun.com/reference/bun/S3Client",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.CookieMap")).toBe(
      "https://bun.com/reference/bun/CookieMap",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.CryptoHasher")).toBe(
      "https://bun.com/reference/bun/CryptoHasher",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.Glob")).toBe(
      "https://bun.com/reference/bun/Glob",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.YAML")).toBe(
      "https://bun.com/reference/bun/YAML",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.secrets")).toBe(
      "https://bun.com/reference/bun/secrets",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.semver")).toBe(
      "https://bun.com/reference/bun/semver",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.CronController")).toBe(
      "https://bun.com/reference/bun/CronController",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.MatchedRoute")).toBe(
      "https://bun.com/reference/bun/MatchedRoute",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.BuildConfig")).toBe(
      "https://bun.com/reference/bun/BuildConfig",
    );
    expect(resolveBunSymbolReferenceUrl("Bun.ServerWebSocket")).toBe(
      "https://bun.com/reference/bun/ServerWebSocket",
    );
    expect(resolveBunSymbolReferenceUrl("toString")).toBeNull();
    expect(resolveBunSymbolReferenceUrl("constructor")).toBeNull();
    expect(
      resolveBunSymbolReferenceUrl("unknown_nonexistent_symbol"),
    ).toBeNull();
  });

  test("findBunReferenceSymbolsInText extracts symbols present in text", () => {
    const text =
      "Use `AnsiTheme` with Bun.markdown.ansi, `Bun.markdown.Options`, Bun.markdown.html, Bun.markdown.render, Bun.markdown.react, Bun.markdown.ListItemMeta, Bun.Archive.extract, `Bun.$`, bun:sqlite, and Bun.serve to build CLI tools.";
    const symbols = findBunReferenceSymbolsInText(text);
    const names = symbols.map((s) => s.symbolName);
    expect(names).toContain("AnsiTheme");
    expect(names).toContain("ansi");
    expect(names).toContain("Options");
    expect(names).toContain("html");
    expect(names).toContain("render");
    expect(names).toContain("react");
    expect(names).toContain("ListItemMeta");
    expect(names).toContain("extract");
    expect(names).toContain("$");
    expect(names).toContain("sqlite");
    expect(names).toContain("serve");
    // Repeated call returns identical results without regex lastIndex drift
    expect(findBunReferenceSymbolsInText(text)).toEqual(symbols);
  });

  test("linkifyBunSymbolsInMarkdown transforms code spans into OSC 8 markdown links", () => {
    const input =
      "Configure `Bun.markdown.Options` and `AnsiTheme`, render via `Bun.markdown.ansi`, `Bun.markdown.html`, `Bun.markdown.render` (`Bun.markdown.ListItemMeta`), or `Bun.markdown.react`, unpack with `Bun.Archive.extract`, run `Bun.$` with `Bun.TerminalOptions`, or query `bun:sqlite`.";
    const linked = linkifyBunSymbolsInMarkdown(input);
    expect(linked).toContain(
      "[`Bun.markdown.Options`](https://bun.com/reference/bun/markdown/Options)",
    );
    expect(linked).toContain(
      "[`AnsiTheme`](https://bun.com/reference/bun/markdown/AnsiTheme)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.ansi`](https://bun.com/reference/bun/markdown/ansi)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.html`](https://bun.com/reference/bun/markdown/html)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.render`](https://bun.com/reference/bun/markdown/render)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.ListItemMeta`](https://bun.com/reference/bun/markdown/ListItemMeta)",
    );
    expect(linked).toContain(
      "[`Bun.markdown.react`](https://bun.com/reference/bun/markdown/react)",
    );
    expect(linked).toContain(
      "[`Bun.Archive.extract`](https://bun.com/reference/bun/Archive/extract)",
    );
    expect(linked).toContain("[`Bun.$`](https://bun.com/reference/bun/$)");
    expect(linked).toContain(
      "[`Bun.TerminalOptions`](https://bun.com/reference/bun/TerminalOptions)",
    );
    expect(linked).toContain(
      "[`bun:sqlite`](https://bun.com/reference/bun/sqlite)",
    );
    // Idempotent when called a second time
    expect(linkifyBunSymbolsInMarkdown(linked)).toBe(linked);
  });

  test("sanitizeBunUrl strips tracking parameters while preserving text fragments", () => {
    const raw =
      "https://bun.com/docs/runtime/networking/dns?_gl=1*shxskr*_ga*MTcxOTc4NTQzNS4xNzk0MjM5MTE0*_ga_3683R8TZ5M*czE3OTQyMzkxMTQkbzEkZzEkdDE3OTQyNDE4NDAkajYwJGwwJGgzMzY2NDYyNzg.#:~:text=%22c%2Dares%22,a%20thread%20pool.";
    const sanitized = sanitizeBunUrl(raw);
    expect(sanitized).toBe(
      "https://bun.com/docs/runtime/networking/dns#:~:text=%22c%2Dares%22,a%20thread%20pool.",
    );
  });
});
