/**
 * @file tests/bun_url_native_utils.test.ts
 * @description Verifies native Bun URL/ANSI/path/doc utilities in `src/lib/`.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath as nodeFileURLToPath } from "node:url";
import {
  BUN_UTILS_DOC_PATH,
  buildRuntimePinnedDocUrl,
  formatBunUtilReference,
} from "../src/lib/bun_doc_linker.ts";
import {
  daemonRoutesToSpecs,
  parseRouteSpec,
  renderRouteAuditTable,
} from "../src/lib/route_audit_table.ts";
import { DAEMON_ROUTES } from "../lib/daemon_routes.ts";
import {
  createSourceLocationUrl,
  openSourceLocationUrl,
} from "../src/lib/source_location_url.ts";
import {
  fitAnsiCols,
  htmlAnchorLink,
  osc8Link,
  renderWrappedLinkCell,
  visibleLinkWidth,
} from "../src/lib/terminal_links.ts";

describe("terminal_links (OSC-8, wrapAnsi, stringWidth, escapeHTML)", () => {
  test("osc8Link keeps url.href intact and hidden from Bun.stringWidth", () => {
    const url = new URL(
      "https://pub.example.r2.dev/f402-weblog/latest.json?v=1",
    );
    const label = "latest.json";
    const linked = osc8Link(url, label);

    expect(linked).toContain(url.href);
    expect(Bun.stringWidth(linked)).toBe(Bun.stringWidth(label));
    expect(visibleLinkWidth(linked)).toBe(label.length);
  });

  test("renderWrappedLinkCell preserves OSC-8 hyperlinks across wrapped lines", () => {
    const url = new URL(
      "https://github.com/oven-sh/bun/blob/0123456789abcdef0123456789abcdef01234567/docs/runtime/utils.mdx",
    );
    const wrapped = renderWrappedLinkCell(
      url,
      "Bun.wrapAnsi Documentation",
      12,
    );
    const lines = wrapped.split("\n");

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toContain(url.href);
      expect(visibleLinkWidth(line)).toBeLessThanOrEqual(12);
    }
    expect(Bun.stripANSI(wrapped).replace(/\n/g, " ")).toContain("wrapAnsi");
  });

  test("fitAnsiCols clips and pads to exact visible columns", () => {
    const red = "\u001b[31mhello world\u001b[0m";
    const clipped = fitAnsiCols(red, 5);
    expect(Bun.stripANSI(clipped)).toBe("hell…");
    expect(Bun.stringWidth(clipped)).toBe(5);
    expect(fitAnsiCols("ok", 5)).toBe("ok   ");
    expect(fitAnsiCols(red, 0)).toBe("");
    expect(fitAnsiCols(red, 1)).toBe("…");
    const linked = osc8Link(new URL("https://example.com/x"), "label");
    expect(Bun.stringWidth(fitAnsiCols(linked, 3))).toBe(3);
  });

  test("htmlAnchorLink escapes href query & label XSS payloads via Bun.escapeHTML", () => {
    const url = new URL('https://example.com/?a=1&b="bad"<tag>');
    const html = htmlAnchorLink(url, `View <script> & "logs"`);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });
});

describe("source_location_url (pathToFileURL, fileURLToPath, openInEditor)", () => {
  test("blocks forbidden local snapshot extensions with ERR_OPS_LOCAL_JSON_FORBIDDEN", () => {
    for (const ext of ["json", "jsonl", "sqlite", "dodbin"]) {
      expect(() =>
        createSourceLocationUrl(`/tmp/sportsdesk/data.${ext}`, 10, 2),
      ).toThrow("ERR_OPS_LOCAL_JSON_FORBIDDEN");
    }
  });

  test("round-trips source path + line/column metadata cleanly to Bun.openInEditor", () => {
    const locUrl = createSourceLocationUrl(
      "/Users/nolarose/code/sportsdesk-ops/src/lib/terminal links.ts",
      42,
      7,
    );
    expect(locUrl.protocol).toBe("file:");
    expect(locUrl.searchParams.get("line")).toBe("42");
    expect(locUrl.searchParams.get("column")).toBe("7");

    let capturedPath = "";
    let capturedOpts:
      { readonly line?: number; readonly column?: number } | undefined;
    openSourceLocationUrl(locUrl, (filePath, opts) => {
      capturedPath = filePath;
      capturedOpts = opts;
    });

    expect(capturedPath).toBe(
      "/Users/nolarose/code/sportsdesk-ops/src/lib/terminal links.ts",
    );
    expect(capturedOpts).toEqual({ line: 42, column: 7 });
  });

  test("rejects non-file URLs", () => {
    expect(() =>
      openSourceLocationUrl(new URL("https://example.com/a.ts")),
    ).toThrow("Expected file: URL, got https:");
  });
});

describe("bun_doc_linker (Bun.revision pinned URLs)", () => {
  test("pins doc URLs to Bun.revision (40-char hex) and validates explicit SHAs", () => {
    const url = buildRuntimePinnedDocUrl(BUN_UTILS_DOC_PATH, "Bun.wrapAnsi");
    expect(url.href).toMatch(
      /^https:\/\/github\.com\/oven-sh\/bun\/blob\/[0-9a-f]{40}\/docs\/runtime\/utils\.mdx#:~:text=Bun\.wrapAnsi$/,
    );
    expect(url.pathname).toContain(Bun.revision);

    expect(() =>
      buildRuntimePinnedDocUrl(BUN_UTILS_DOC_PATH, undefined, "main"),
    ).toThrow("ERR_SPEC_INVALID_BLOB_SHA");

    const ref = formatBunUtilReference("Bun.stringWidth");
    expect(ref).toContain(`Bun.stringWidth (${Bun.version})`);
    expect(Bun.stripANSI(ref)).toBe(`Bun.stringWidth (${Bun.version})`);
  });
});

describe("route_audit_table (URL.parse, URLPattern, Bun.inspect.table)", () => {
  test("parseRouteSpec rejects invalid URLs without throwing and renderRouteAuditTable prints clickable links", () => {
    expect(
      parseRouteSpec({
        name: "bad",
        pathname: "/api/*",
        sampleUrl: "not a url",
        docUrl: "https://example.com",
      }),
    ).toBeNull();

    const spec = parseRouteSpec({
      name: "shadow-pricing",
      pathname: "/api/shadow-pricing",
      sampleUrl: "http://127.0.0.1:4022/api/shadow-pricing?regime=live_in_play",
      docUrl: buildRuntimePinnedDocUrl(BUN_UTILS_DOC_PATH, "URLPattern").href,
    });
    expect(spec).not.toBeNull();

    const table = renderRouteAuditTable([spec!], { colors: false });
    expect(table).toContain("shadow-pricing");
    expect(table).toContain("/api/shadow-pricing");
    expect(table).toContain("true");
    expect(table).toContain("utils.mdx");
  });

  test("daemonRoutesToSpecs converts live DAEMON_ROUTES to matching URLPattern specs", () => {
    const specs = daemonRoutesToSpecs(DAEMON_ROUTES);
    expect(specs.length).toBe(DAEMON_ROUTES.length);
    for (const s of specs) {
      expect(s.pattern.test(s.sampleUrl)).toBe(true);
      expect(s.docUrl.pathname).toContain(Bun.revision);
    }
    const table = renderRouteAuditTable(specs, { colors: false });
    expect(table).toContain("/api/v2/live-bets");
  });
});

describe("Bun.fileURLToPath", () => {
  test("decodes a file URL exactly like node:url", () => {
    const encoded = new URL("file:///tmp/a%20b/unicod%C3%A9.txt");
    expect(Bun.fileURLToPath(encoded)).toBe(nodeFileURLToPath(encoded));
    expect(Bun.fileURLToPath("file:///path/to/file.txt")).toBe(
      nodeFileURLToPath("file:///path/to/file.txt"),
    );
  });

  test("refuses a non-file URL instead of returning a pathname", () => {
    expect(() => Bun.fileURLToPath("https://example.com/x")).toThrow(TypeError);
    expect(() => Bun.fileURLToPath(new URL("sqlite:///tmp/db"))).toThrow(
      TypeError,
    );
  });
});
