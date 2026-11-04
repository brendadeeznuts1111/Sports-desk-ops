import { describe, expect, test } from "bun:test";
import {
  assertOkJson,
  isJsonContentType,
  parsePartnerConfig,
} from "../fetch-config.ts";

describe("isJsonContentType", () => {
  test("accepts application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
  });
  test("accepts json with charset", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });
  test("rejects html and null", () => {
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("parsePartnerConfig", () => {
  test("partners-array shape", () => {
    const { shape, entryCount } = parsePartnerConfig({
      partners: [{ id: "1" }, { id: "2" }],
    });
    expect(shape).toBe("partners-array");
    expect(entryCount).toBe(2);
  });

  test("keyed-map shape", () => {
    const { shape, entryCount } = parsePartnerConfig({
      p1: { id: "p1" },
      p2: { id: "p2" },
      p3: { id: "p3" },
    });
    expect(shape).toBe("keyed-map");
    expect(entryCount).toBe(3);
  });

  test("data-meta shape", () => {
    const { shape, entryCount } = parsePartnerConfig({
      data: { theme: "dark" },
      meta: { version: 1 },
    });
    expect(shape).toBe("data-meta");
    expect(entryCount).toBe(1); // data is an object with 1 key
  });

  test("unknown shape for non-objects", () => {
    expect(parsePartnerConfig(null).shape).toBe("unknown");
    expect(parsePartnerConfig("not json").shape).toBe("unknown");
    expect(parsePartnerConfig([1, 2, 3]).shape).toBe("unknown");
  });
});

describe("assertOkJson", () => {
  test("happy path: ok + json does not throw", () => {
    const r = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(() => assertOkJson(r)).not.toThrow();
  });

  test("302 redirect to login throws with location", () => {
    const r = new Response("", {
      status: 302,
      headers: { location: "/login?next=/manager-tools/" },
    });
    expect(() => assertOkJson(r)).toThrow(/redirected/);
    expect(() => assertOkJson(r)).toThrow(/GSID likely expired/);
  });

  test("non-ok status throws", () => {
    const r = new Response("Not Found", { status: 404 });
    expect(() => assertOkJson(r)).toThrow(/HTTP 404/);
  });

  test("200 html login page throws (the GSID-expired trap)", () => {
    const r = new Response("<html><body>Login</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    expect(() => assertOkJson(r)).toThrow(/not JSON/);
    expect(() => assertOkJson(r)).toThrow(/login HTML page/);
  });
});
