/**
 * @file lib/ticket_html.ts
 * @description Turn printable HTML (e.g. `getTicketDetailPrint`) into text and links.
 *
 * Canonical `HTMLRewriter` contract (`docs/runtime/html-rewriter.mdx` & `bun.d.ts`):
 * - `transform()` accepts `Response`, `string`, or `ArrayBuffer` directly (returning `string`
 *   synchronously when given a `string`).
 * - Text chunks arrive **entity-encoded** (`text.text`, `text.lastInTextNode`, `text.removed`), and
 *   an entity can span two chunks, so decoding happens after joining.
 * - `element.remove()` removes an element and marks its child text chunks as `text.removed === true`,
 *   though `onDocument({ text })` still visits raw chunks unless `text.removed` is checked or
 *   `script`/`style`/`noscript` blocks are stripped upfront.
 * - Void elements (`<br>`, `<img>`, `<input>`, `<hr>`, `<meta>`, `<link>`) have `element.canHaveContent === false`
 *   and throw if `element.onEndTag(...)` is registered on them.
 */

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aacute: "á",
  Aacute: "Á",
  eacute: "é",
  Eacute: "É",
  iacute: "í",
  Iacute: "Í",
  oacute: "ó",
  Oacute: "Ó",
  uacute: "ú",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  ccedil: "ç",
  Ccedil: "Ç",
  iexcl: "¡",
  iquest: "¿",
  deg: "°",
  middot: "·",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const value =
        code[1]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      if (
        Number.isFinite(value) &&
        value > 0 &&
        value <= 0x10ffff &&
        !(value >= 0xd800 && value <= 0xdfff)
      ) {
        try {
          return String.fromCodePoint(value);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = "p,div,tr,li,h1,h2,h3,h4,td,th,section,article";

/**
 * Remove script/style/noscript/template bodies before parsing.
 *
 * `element.remove()` suppresses the markup, and we also check `!text.removed` inside handlers for
 * defense in depth.
 */
export function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");
}

export function htmlToText(html: string): string {
  const chunks: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, template", {
      element(element) {
        element.remove();
      },
    })
    // `<br>` is void (`element.canHaveContent === false`): asking for `onEndTag` throws.
    .on("br", {
      element() {
        chunks.push("\n");
      },
    })
    .on(BLOCK_TAGS, {
      element(element) {
        if (element.canHaveContent !== false) {
          element.onEndTag(() => {
            chunks.push("\n");
          });
        }
      },
    })
    .onDocument({
      text(text) {
        if (!text.removed) chunks.push(text.text);
      },
    });

  rewriter.transform(stripNonContent(html));
  return decodeEntities(chunks.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Links with their visible text; fragments with no href are dropped. */
export function extractLinks(html: string): PageLink[] {
  const links: PageLink[] = [];
  let href = "";
  let label = "";

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, template", {
      element(element) {
        element.remove();
      },
    })
    .on("a", {
      element(element) {
        href = element.getAttribute("href") ?? "";
        label = "";
        if (element.canHaveContent !== false) {
          element.onEndTag(() => {
            if (href !== "")
              links.push({ href, text: decodeEntities(label).trim() });
            href = "";
            label = "";
          });
        }
      },
      text(text) {
        if (!text.removed && href !== "") label += text.text;
      },
    });

  rewriter.transform(stripNonContent(html));
  return links;
}
