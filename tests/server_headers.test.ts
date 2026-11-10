import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("Server Headers & Security Policy Verification", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({ port: 0, hostname: "127.0.0.1" });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("test_assert_x_frame_options_absent_and_csp_frame_ancestors_present", async () => {
    const res = await fetch(`${server.url}health`);
    expect([200, 503]).toContain(res.status);

    // 1. Assert X-Frame-Options is strictly ABSENT
    const xFrameOptions = res.headers.get("x-frame-options");
    expect(xFrameOptions).toBeNull();

    // 2. Assert Content-Security-Policy contains required Telegram frame-ancestors
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://web.telegram.org");
    expect(csp).toContain("https://*.telegram.org");
    expect(csp).toContain("telegram:");
  });

  test("test_assert_dashboard_route_headers", async () => {
    const res = await fetch(`${server.url}`);
    expect(res.status).toBe(200);

    expect(res.headers.get("x-frame-options")).toBeNull();

    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://web.telegram.org");
    expect(csp).toContain("https://*.telegram.org");
    expect(csp).toContain("telegram:");
  });

  test("test_assert_miniapp_route_headers", async () => {
    const res = await fetch(`${server.url}miniapp`);
    expect(res.status).toBe(200);

    expect(res.headers.get("x-frame-options")).toBeNull();

    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://web.telegram.org");
    expect(csp).toContain("https://*.telegram.org");
    expect(csp).toContain("telegram:");
  });
});
