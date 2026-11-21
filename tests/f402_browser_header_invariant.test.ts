/**
 * The manager API treats `X-Requested-With: XMLHttpRequest` as "a browser did this" because its
 * portal is a jQuery app (jQuery sets it for same-origin requests only). These tests pin the
 * value in one place and prove the replay transport attaches it for callers that forget, so a new
 * transport cannot silently drop the header and only fail at the live API.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  F402_BROWSER_HEADER,
  F402_BROWSER_HEADERS,
  F402_BROWSER_HEADER_VALUE,
} from "../lib/f402_browser_headers.ts";
import { inPageCloudApiHeadersJs } from "../lib/f402_in_page_fetch.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";

const ROOT = join(import.meta.dir, "..");

describe("the header constant", () => {
  test("is the jQuery same-origin value", () => {
    expect(F402_BROWSER_HEADER).toBe("x-requested-with");
    expect(F402_BROWSER_HEADER_VALUE).toBe("XMLHttpRequest");
    expect(F402_BROWSER_HEADERS).toEqual({
      "x-requested-with": "XMLHttpRequest",
    });
  });

  test("no lib/ literal disagrees with it", () => {
    // Only a stray hand-written literal can drift; the shared builders serialize the constant.
    const pattern = /["']x-requested-with["']\s*:\s*["']([^"']+)["']/gi;
    const files = [
      ...new Bun.Glob("lib/**/*.ts").scanSync({ cwd: ROOT }),
    ].filter((file) => !file.endsWith(".test.ts"));
    const wrong: string[] = [];
    for (const relative of files) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== F402_BROWSER_HEADER_VALUE) {
          wrong.push(`${relative}: ${match[1]}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the in-page header builder", () => {
  test("serializes the shared constant, not a copy", () => {
    const snippet = inPageCloudApiHeadersJs("application/json");
    expect(snippet).toContain(`"x-requested-with": "XMLHttpRequest"`);
    expect(snippet).toContain(`"content-type": "application/json"`);
  });
});

describe("createF402ReplayTransport", () => {
  async function capture(
    init: RequestInit,
  ): Promise<{ headers: Headers; calls: number }> {
    const seen: Headers[] = [];
    const transport = await createF402ReplayTransport({
      env: {},
      readSession: () => null,
      fetchImpl: async (_url, requestInit) => {
        seen.push(new Headers(requestInit.headers));
        return new Response("{}", { status: 200 });
      },
    });
    await transport.fetch("https://manager.example/cloud/api/Manager/x", init);
    await transport.close();
    return {
      headers: seen[0] ?? new Headers(),
      calls: seen.length,
    };
  }

  test("adds the browser header when the caller omits it", async () => {
    const { headers, calls } = await capture({
      method: "POST",
      headers: { accept: "application/json" },
    });
    expect(calls).toBe(1);
    expect(headers.get(F402_BROWSER_HEADER)).toBe(F402_BROWSER_HEADER_VALUE);
    expect(headers.get("accept")).toBe("application/json");
  });

  test("keeps an explicit value, so a future API change is one call site", async () => {
    const { headers } = await capture({
      method: "POST",
      headers: { [F402_BROWSER_HEADER]: "Other/1.0" },
    });
    expect(headers.get(F402_BROWSER_HEADER)).toBe("Other/1.0");
  });

  test("the proxy branch keeps Headers input and stamps the header", async () => {
    // The proxy branch used to spread `init.headers` into a plain object, which drops every
    // entry when the caller passed a `Headers` instance.
    const original = globalThis.fetch;
    const seen: Headers[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const transport = await createF402ReplayTransport({
        proxyUrl: "http://127.0.0.1:9",
        env: {},
      });
      await transport.fetch("https://manager.example/cloud/api/Manager/x?y=1", {
        headers: new Headers({ "x-custom": "one" }),
      });
      await transport.close();
    } finally {
      globalThis.fetch = original;
    }
    const headers = seen[0] ?? new Headers();
    expect(headers.get("x-custom")).toBe("one");
    expect(headers.get(F402_BROWSER_HEADER)).toBe(F402_BROWSER_HEADER_VALUE);
    expect(headers.get("x-f402-upstream")).toBe(
      "https://manager.example/cloud/api/Manager/x?y=1",
    );
  });

  test("carries caller headers whether given as an object or as Headers", async () => {
    const asObject = await capture({
      headers: { "x-custom": "one" },
    });
    expect(asObject.headers.get("x-custom")).toBe("one");
    const asHeaders = await capture({
      headers: new Headers({ "x-custom": "two" }),
    });
    expect(asHeaders.headers.get("x-custom")).toBe("two");
  });
});
