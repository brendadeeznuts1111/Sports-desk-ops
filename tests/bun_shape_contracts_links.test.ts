import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  assertUrlReturnsSymbolContent,
  probeShapeReferenceUrl,
} from "../scripts/bun_shape_contracts.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures/bun-docs");

describe("bun shape reference link validator", () => {
  test("rejects HTTP 200 soft-404 shell containing sentinel text", async () => {
    const html = await Bun.file(
      path.join(FIXTURES_DIR, "fetch-session-soft-200.html"),
    ).text();
    const res = assertUrlReturnsSymbolContent(html, "FetchSession");
    expect(res.ok).toBe(false);
  });

  test("rejects HTTP 200 HTML when symbol is missing from <title> and <h1>", () => {
    const html =
      "<html><head><title>Bun Reference</title></head><body><h1>OtherSymbol</h1><p>unrelated</p></body></html>";
    const res = assertUrlReturnsSymbolContent(html, "FetchSession");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("FetchSession");
    }
  });

  test("accepts genuine reference HTML matching symbol heading", async () => {
    const html = await Bun.file(
      path.join(FIXTURES_DIR, "serve-200.html"),
    ).text();
    expect(assertUrlReturnsSymbolContent(html, "serve")).toEqual({ ok: true });
  });

  test("probeShapeReferenceUrl downgrades soft-404 200s to 404 and preserves real statuses", async () => {
    const softHtml = await Bun.file(
      path.join(FIXTURES_DIR, "fetch-session-soft-200.html"),
    ).text();
    const okHtml = await Bun.file(
      path.join(FIXTURES_DIR, "serve-200.html"),
    ).text();

    expect(
      await probeShapeReferenceUrl(
        "https://bun.com/reference/globals/bun/FetchSession",
        "FetchSession",
        async () =>
          new Response(softHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    ).toBe(404);

    expect(
      await probeShapeReferenceUrl(
        "https://bun.com/reference/globals/bun/serve",
        "serve",
        async () =>
          new Response(okHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    ).toBe(200);

    expect(
      await probeShapeReferenceUrl(
        "https://bun.com/reference/globals/bun/FetchSessionInit",
        "FetchSessionInit",
        async () => new Response("Not Found", { status: 404 }),
      ),
    ).toBe(404);

    expect(
      await probeShapeReferenceUrl(
        "https://bun.com/reference/globals/bun/FetchSession",
        "FetchSession",
        async () => {
          throw new Error("network down");
        },
      ),
    ).toBe(0);
  });
});
