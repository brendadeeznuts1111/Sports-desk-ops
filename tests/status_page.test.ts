/**
 * @file tests/status_page.test.ts
 * @description Contract and live-server tests for the enhanced SportsDesk `/status` console (`static/status.html`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";

const ROOT = resolve(import.meta.dir, "..");
const STATUS_HTML_PATH = resolve(ROOT, "static/status.html");

describe("static/status.html operational console contract", () => {
  const html = readFileSync(STATUS_HTML_PATH, "utf8");

  test("enforces zero innerHTML/outerHTML/insertAdjacentHTML and zero hardcoded loopback origins", () => {
    expect(html).not.toMatch(/\.innerHTML\b/);
    expect(html).not.toMatch(/\.outerHTML\b/);
    expect(html).not.toMatch(/\binsertAdjacentHTML\b/);
    expect(html).not.toMatch(
      /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/,
    );
  });

  test("wires public operational routes and operator landmarks without mislabeling CPU", () => {
    for (const endpoint of [
      "/api/status",
      "/health",
      "/api/bridge3c/status",
      "/api/dns/telemetry",
    ]) {
      expect(html).toContain(`"${endpoint}"`);
    }

    for (const landmark of [
      'id="summary"',
      'id="alert-banner"',
      'id="schedule-search"',
      'id="payload"',
      'id="btn-refresh"',
      'id="btn-copy-json"',
      'id="btn-auto"',
    ]) {
      expect(html).toContain(landmark);
    }

    expect(html).toContain("Cumulative CPU since start (not load %)");
    expect(html).toContain("daemon4020");
    expect(html).not.toContain("Cron / TZ");
    expect(html).toContain('"Cron"');
    expect(html).toContain('"TZ"');
    expect(html).toContain('"cron"');
    expect(html).toContain('"tz"');
    expect(html).not.toContain("Dependencies / Targets");
    expect(html).toContain('"Dependencies"');
    expect(html).toContain('"Targets"');
    expect(html).toContain('"dependencies"');
    expect(html).toContain('"targets"');
  });

  test("inline script parses cleanly with zero syntax or redeclaration errors", () => {
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const scriptBody = match?.[1] ?? "";
    expect(scriptBody.length).toBeGreaterThan(100);
    const transpiler = new Bun.Transpiler({ loader: "js" });
    expect(() => transpiler.transformSync(scriptBody)).not.toThrow();
  });
});

describe("sportsdesk_webview_server GET /status and /status/", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("serves the enhanced static/status.html at /status and /status/", async () => {
    const expected = readFileSync(STATUS_HTML_PATH, "utf8");
    for (const path of ["/status", "/status/"]) {
      const res = await fetch(new URL(path, server.url));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toBe(expected);
      expect(body).toContain("SportsDesk Status");
      expect(body).toContain('id="schedule-search"');
    }
  });
});
