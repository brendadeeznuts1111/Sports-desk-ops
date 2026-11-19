import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The two published portal pages are hand-maintained, and nothing verified their `<head>` beyond
 * `docs/index.html`'s Scalar pin. These cases pin the metadata and landmark structure both pages
 * need: a real title and description, a canonical URL and Open Graph/Twitter preview, and an
 * identified `<header>` so the document has landmarks to link to.
 *
 * The canonical origin is the R2 public gateway the pages are actually served from — both URLs were
 * fetched and returned 200 before being written into the markup, so this is not a guessed host.
 */

const ROOT = join(import.meta.dir, "..");
const PAGES = [
  { file: "docs/index.html", slug: "index.html" },
  { file: "docs/graph.html", slug: "graph.html" },
] as const;

const ORIGIN = "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

function attr(html: string, pattern: RegExp): string | null {
  return pattern.exec(html)?.[1]?.trim() ?? null;
}

describe.each(PAGES)("$file head and landmarks", ({ file, slug }) => {
  test("declares a language, charset, viewport, title and description", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<meta charset="utf-8"\s*\/?>/);
    expect(html).toMatch(/name="viewport"/);
    expect(attr(html, /<title>([\s\S]*?)<\/title>/)).toBeTruthy();
    expect(attr(html, /name="description"\s+content="([^"]+)"/)).toBeTruthy();
  });

  test("carries a canonical URL and a social preview that agree", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const canonical = attr(html, /rel="canonical"\s+href="([^"]+)"/);
    expect(canonical).toBe(`${ORIGIN}/${slug}`);

    expect(attr(html, /property="og:type"\s+content="([^"]+)"/)).toBe(
      "website",
    );
    expect(attr(html, /property="og:title"\s+content="([^"]+)"/)).toBeTruthy();
    expect(
      attr(html, /property="og:description"\s+content="([^"]+)"/),
    ).toBeTruthy();
    expect(attr(html, /property="og:url"\s+content="([^"]+)"/)).toBe(canonical);
    // An image card is the correct summary type once og:image is present.
    expect(attr(html, /name="twitter:card"\s+content="([^"]+)"/)).toBe(
      "summary_large_image",
    );
  });

  test("the social title matches the document title", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const title = attr(html, /<title>([\s\S]*?)<\/title>/);
    const ogTitle = attr(html, /property="og:title"\s+content="([^"]+)"/);
    expect(ogTitle).toBe(title);
  });

  test("has an identified header landmark", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    expect(html).toMatch(/<header[\s\S]{0,120}?id="[a-z-]+"/);
  });
});

describe("docs/index.html landmarks", () => {
  test("the header nav and the reference mount are identified", async () => {
    const html = await Bun.file(join(ROOT, "docs/index.html")).text();
    expect(html).toMatch(/id="spec-banner"/);
    expect(html).toMatch(/<nav[\s\S]{0,160}?id="spec-nav"/);
    expect(html).toMatch(/<main id="reference" class="reference-root">/);
    // The Scalar mount must stay the element Scalar looks for.
    expect(html).toMatch(/id="api-reference"/);
    expect(html).toMatch(/data-url="\.\/openapi\.json"/);
  });
});

describe.each(PAGES)("$file social image", ({ file, slug }) => {
  const assetPath = (html: string): string | null => {
    const url = attr(html, /property="og:image"\s+content="([^"]+)"/);
    if (url === null) return null;
    return url.startsWith(`${ORIGIN}/assets/`)
      ? url.slice(`${ORIGIN}/assets/`.length)
      : null;
  };

  test("the card image is absolute, served from the portal origin, and exists", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const asset = assetPath(html);
    expect(asset).not.toBeNull();
    expect(asset).toMatch(/\.png$/);
    // The origin serves docs/assets/* at /assets/*; the file must exist to be published.
    expect(await Bun.file(join(ROOT, "docs", "assets", asset!)).exists()).toBe(
      true,
    );
    expect(attr(html, /name="twitter:image"\s+content="([^"]+)"/)).toBe(
      `${ORIGIN}/assets/${asset}`,
    );
  });

  test("the declared image dimensions are the file's real dimensions", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const asset = assetPath(html)!;
    const meta = await new Bun.Image(
      await Bun.file(join(ROOT, "docs", "assets", asset)).bytes(),
    ).metadata();
    expect(Number(attr(html, /og:image:width"\s+content="(\d+)"/))).toBe(
      meta.width,
    );
    expect(Number(attr(html, /og:image:height"\s+content="(\d+)"/))).toBe(
      meta.height,
    );
  });

  test("structured data parses and names the page it describes", async () => {
    const html = await Bun.file(join(ROOT, file)).text();
    const raw =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1];
    expect(raw).toBeTruthy();
    const json = JSON.parse(raw!) as {
      "@type": string;
      url: string;
      isPartOf?: { url?: string };
    };
    expect(json["@type"]).toBe("TechArticle");
    expect(json.url).toBe(`${ORIGIN}/${slug}`);
    // The portal origin's root is a 404, so the site node must name a real page.
    expect(json.isPartOf?.url).toBe(`${ORIGIN}/index.html`);
  });
});

describe("docs/index.html machine-readable alternate", () => {
  test("declares the OpenAPI spec as an alternate representation", async () => {
    const html = await Bun.file(join(ROOT, "docs/index.html")).text();
    expect(html).toMatch(
      /<link\s+rel="alternate"\s+type="application\/json"\s+href="\.\/openapi\.json"\s*\/?>/,
    );
  });
});
