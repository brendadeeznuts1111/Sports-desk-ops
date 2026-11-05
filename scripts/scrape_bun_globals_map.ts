/**
 * Scrape the Bun global catalog into a symbol → href → type/value map.
 *
 * The catalog page lists 331 symbols. Each detail page carries a `data-algolia-id` wrapper whose
 * signature block is the declaration/type (function signature, `const …: …`, `type … = …`). This
 * script fetches both, then writes JSON, a colour-coded Markdown table, and a colour-coded HTML map.
 */
import { join } from "node:path";

const SOURCE = "https://bun.sh/reference/globals/bun";
const ROOT = join(import.meta.dir, "..");
const DOCS_DIR = join(ROOT, "docs");
const SCRATCH_DIR = join(ROOT, "scratch");

const SECTIONS = {
  functions: "function",
  classes: "class",
  interfaces: "interface",
  types: "type",
  variables: "variable",
  namespaces: "namespace",
} as const;

type Kind = (typeof SECTIONS)[keyof typeof SECTIONS];

interface CatalogRow {
  readonly kind: Kind;
  readonly display: string;
  readonly name: string;
  readonly href: string;
  readonly summary: string;
}

interface SymbolRow extends CatalogRow {
  readonly symbol: string;
  /** Declaration-space classification required by the map contract. */
  readonly signature: "type" | "value";
  /** Both spaces for declarations that are types and values (class, namespace). */
  readonly spaces: readonly ("type" | "value")[];
  /** The declaration text extracted from the detail page. */
  readonly declaration: string;
}

const KIND_COLOR: Readonly<Record<Kind, string>> = {
  function: "#22C55E",
  class: "#3B82F6",
  interface: "#A855F7",
  type: "#EAB308",
  variable: "#F97316",
  namespace: "#EF4444",
};

const KIND_EMOJI: Readonly<Record<Kind, string>> = {
  function: "🟩",
  class: "🟦",
  interface: "🟪",
  type: "🟨",
  variable: "🟧",
  namespace: "🟥",
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|#39|#x27|apos|nbsp);/g,
      (entity) => ENTITIES[entity] ?? entity,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function nameFrom(display: string): string {
  return display
    .replace(/^(?:class|interface|type|const|namespace)\s+/, "")
    .replace(/^Bun\./, "")
    .replace(/\(\)$/, "");
}

function shortSignature(signature: string): string {
  return signature.length > 220 ? `${signature.slice(0, 217)}…` : signature;
}

function classification(kind: Kind): {
  signature: "type" | "value";
  spaces: readonly ("type" | "value")[];
} {
  switch (kind) {
    case "interface":
    case "type":
      return { signature: "type", spaces: ["type"] };
    case "class":
    case "namespace":
      return { signature: "value", spaces: ["type", "value"] };
    case "function":
    case "variable":
      return { signature: "value", spaces: ["value"] };
  }
}

async function page(url: string, attempt = 0): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    if (attempt < 2) return page(url, attempt + 1);
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

const ALGOLIA_KIND: Readonly<Record<Kind, string>> = {
  function: "function",
  class: "class",
  interface: "interface",
  type: "type alias",
  variable: "variable",
  namespace: "namespace",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First child `<div>` block after `start`, with balanced nesting. */
function firstChildDivBlock(html: string, start: number): string {
  const open = html.indexOf("<div", start);
  if (open < 0) return "";
  let depth = 0;
  let cursor = open;
  while (cursor < html.length) {
    const nextOpen = html.indexOf("<div", cursor);
    const nextClose = html.indexOf("</div", cursor);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + 4;
    } else {
      depth -= 1;
      cursor = nextClose + 6;
      if (depth === 0) return html.slice(open, cursor);
    }
  }
  return html.slice(open);
}

function wrapperFor(html: string, symbol: string, kind: Kind): string {
  const id = escapeRegExp(symbol);
  const exact = new RegExp(
    `<div[^>]*data-algolia-id="${id}"[^>]*data-algolia-kind="${ALGOLIA_KIND[kind]}"[^>]*>`,
  ).exec(html);
  return exact?.[0] ?? "";
}

/** Text of the entry's declaration, cut before the first description block. */
function declarationText(entry: string): string {
  const openEnd = entry.indexOf(">") + 1;
  const inner = entry.slice(openEnd, entry.lastIndexOf("</div"));
  const cuts = [
    inner.indexOf("<p"),
    inner.indexOf('<div class="md-doc"'),
    inner.indexOf('<div class="text-fg-muted"'),
  ].filter((index) => index >= 0);
  const end = cuts.length === 0 ? inner.length : Math.min(...cuts);
  return text(inner.slice(0, end)).slice(0, 600);
}

function signatureFrom(
  html: string,
  symbol: string,
  kind: Kind,
  fallbackSummary: string,
  fallbackSignature: string,
): { signature: string; summary: string } {
  const wrapper = wrapperFor(html, symbol, kind);
  if (wrapper === "") {
    return { signature: fallbackSignature, summary: fallbackSummary };
  }
  const start = html.indexOf(wrapper) + wrapper.length;
  const entry = firstChildDivBlock(html, start);
  const extracted = entry === "" ? "" : declarationText(entry);
  const normalized = extracted;
  const summaryMatch = /data-algolia-summary="([^"]*)"/.exec(wrapper);
  return {
    signature: normalized === "" ? fallbackSignature : normalized,
    summary:
      summaryMatch === null ? fallbackSummary : text(summaryMatch[1] ?? ""),
  };
}

const catalogHtml = await page(SOURCE);
const catalog: CatalogRow[] = [];

for (const [id, kind] of Object.entries(SECTIONS)) {
  const sectionStart = catalogHtml.indexOf(`<section id="${id}"`);
  if (sectionStart < 0) throw new Error(`section ${id} not found`);
  const sectionEnd = catalogHtml.indexOf("</section>", sectionStart);
  const block = catalogHtml.slice(sectionStart, sectionEnd);
  for (const item of block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const inner = item[1] ?? "";
    const anchor = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(inner);
    if (anchor === null) continue;
    const href = new URL(anchor[1]!, SOURCE).href;
    const display = text(anchor[2]!);
    const summary = /<p[^>]*>([\s\S]*?)<\/p>/.exec(inner)?.[1] ?? "";
    catalog.push({
      kind: kind as Kind,
      display,
      name: nameFrom(display),
      href,
      summary: text(summary),
    });
  }
}

const symbols: SymbolRow[] = Array.from({
  length: catalog.length,
}) as SymbolRow[];
let cursor = 0;

async function worker(): Promise<void> {
  while (true) {
    const index = cursor;
    cursor += 1;
    const row = catalog[index];
    if (row === undefined) return;

    const html = await page(row.href);
    const idMatch = /data-algolia-id="([^"]+)"/.exec(html);
    const symbol = idMatch?.[1] ?? `globals.bun.${row.name}`;
    const extracted = signatureFrom(
      html,
      symbol,
      row.kind,
      row.summary,
      row.display,
    );
    const classified = classification(row.kind);
    symbols[index] = {
      ...row,
      symbol,
      summary: extracted.summary,
      declaration: extracted.signature,
      signature: classified.signature,
      spaces: classified.spaces,
    };
  }
}

await Promise.all(Array.from({ length: 8 }, () => worker()));

const counts = {
  functions: symbols.filter((row) => row.kind === "function").length,
  classes: symbols.filter((row) => row.kind === "class").length,
  interfaces: symbols.filter((row) => row.kind === "interface").length,
  types: symbols.filter((row) => row.kind === "type").length,
  variables: symbols.filter((row) => row.kind === "variable").length,
  namespaces: symbols.filter((row) => row.kind === "namespace").length,
};

const symbolCounts = new Map<string, number>();
for (const row of symbols) {
  symbolCounts.set(row.symbol, (symbolCounts.get(row.symbol) ?? 0) + 1);
}
const merged = [...symbolCounts.entries()]
  .filter(([, count]) => count > 1)
  .map(([symbol]) => ({
    symbol,
    kinds: [
      ...new Set(
        symbols.filter((row) => row.symbol === symbol).map((row) => row.kind),
      ),
    ],
  }));
const mergedExcess = merged.reduce(
  (total, entry) => total + entry.kinds.length - 1,
  0,
);
const signatureCounts = {
  type: symbols.filter((row) => row.signature === "type").length,
  value: symbols.filter((row) => row.signature === "value").length,
};

const expectedKindRows = {
  function: counts.functions,
  class: counts.classes,
  interface: counts.interfaces,
  type: counts.types,
  variable: counts.variables,
  namespace: counts.namespaces,
};

const meta = {
  scrapedAt: new Date().toISOString(),
  bunVersion: Bun.version,
  bunVersionWithSha: Bun.version_with_sha,
  sourceBuild: "bun.sh docs",
  source: SOURCE,
  symbolNormalization: "data-algolia-id",
  kindRowCount: symbols.length,
  distinctSymbolCount: symbolCounts.size,
  mergedExcess,
  merged,
  expectedKindRows,
  signatureCounts,
};

await Bun.write(
  join(DOCS_DIR, "bun-globals-map.json"),
  `${JSON.stringify(symbols, null, 2)}\n`,
);
await Bun.write(
  join(DOCS_DIR, "bun-globals-map.meta.json"),
  `${JSON.stringify(meta, null, 2)}\n`,
);

const markdown = [
  "# Bun global catalog map",
  "",
  `Source: ${SOURCE}`,
  `Scraped: ${meta.scrapedAt} · Bun ${meta.bunVersionWithSha} · ${meta.sourceBuild}`,
  `Kind rows: ${meta.kindRowCount} · distinct symbols: ${meta.distinctSymbolCount} · merged: ${merged.map((entry) => entry.symbol).join(", ") || "none"}`,
  "",
  "| Kind | Symbol | Space | Declaration | Href |",
  "| --- | --- | --- | --- | --- |",
  ...symbols.map(
    (row) =>
      `| ${KIND_EMOJI[row.kind]} ${row.kind} | \`${row.symbol}\` | ${row.signature} | ${row.declaration === "" ? "—" : `\`${shortSignature(row.declaration).replaceAll("|", "\\|")}\``} | ${row.href} |`,
  ),
  "",
].join("\n");

await Bun.write(join(SCRATCH_DIR, "bun-globals-map.md"), markdown);

const html = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  "<title>Bun global catalog map</title>",
  "<style>",
  "body{font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:24px;background:#0b1020;color:#e5e7eb}",
  "a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}",
  "table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #1f2937;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{position:sticky;top:0;background:#111827}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
  ".kind{font-weight:700;white-space:nowrap}",
  ...Object.entries(KIND_COLOR).map(
    ([kind, color]) => `.kind-${kind}{color:${color}}`,
  ),
  "</style></head><body>",
  `<h1>Bun global catalog map</h1><p>Source: <a href="${SOURCE}">${SOURCE}</a> · scraped ${meta.scrapedAt} · Bun ${meta.bunVersionWithSha} · ${meta.sourceBuild} · ${symbols.length} kind rows · ${symbolCounts.size} distinct symbols · merged: ${merged.join(", ") || "none"}</p>`,
  "<table><thead><tr><th>Kind</th><th>Symbol</th><th>Space</th><th>Declaration</th><th>Href</th></tr></thead><tbody>",
  ...symbols.map(
    (row) =>
      `<tr><td class="kind kind-${row.kind}">${KIND_EMOJI[row.kind]} ${row.kind}</td><td><code>${row.symbol}</code></td><td>${row.signature}</td><td><code>${row.declaration === "" ? "—" : shortSignature(row.declaration).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></td><td><a href="${row.href}">${row.href}</a></td></tr>`,
  ),
  "</tbody></table></body></html>",
  "",
].join("\n");

await Bun.write(join(SCRATCH_DIR, "bun-globals-map.html"), html);

const COUNT_KIND: Readonly<Record<string, Kind>> = {
  functions: "function",
  classes: "class",
  interfaces: "interface",
  types: "type",
  variables: "variable",
  namespaces: "namespace",
};

const reset = "\x1b[0m";
const colored = Object.entries(counts)
  .map(([kind, count]) => {
    const color = Bun.color(KIND_COLOR[COUNT_KIND[kind]!], "ansi") ?? "";
    return `${color}${kind}${reset}=${count}`;
  })
  .join("  ");

console.log(
  JSON.stringify({
    source: SOURCE,
    kindRowCount: meta.kindRowCount,
    distinctSymbolCount: meta.distinctSymbolCount,
    merged: meta.merged,
    signatureCounts: meta.signatureCounts,
    counts,
    colored,
    json: join(DOCS_DIR, "bun-globals-map.json"),
    meta: join(DOCS_DIR, "bun-globals-map.meta.json"),
    markdown: join(SCRATCH_DIR, "bun-globals-map.md"),
    html: join(SCRATCH_DIR, "bun-globals-map.html"),
  }),
);
