import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  isLoopbackAddress,
  startServer,
} from "../services/sportsdesk_webview_server.ts";

describe("isLoopbackAddress", () => {
  test("accepts every local form Bun can report", () => {
    for (const address of [
      "127.0.0.1",
      "127.0.0.53",
      "::1",
      "::",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "localhost",
      " 127.0.0.1 ",
      "[::1]",
    ]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
  });

  test("treats a unix socket (no address) as local", () => {
    expect(isLoopbackAddress(null)).toBe(true);
    expect(isLoopbackAddress(undefined)).toBe(true);
    expect(isLoopbackAddress("")).toBe(true);
  });

  test("rejects LAN and public peers", () => {
    for (const address of [
      "192.168.1.92",
      "10.0.0.5",
      "172.16.4.4",
      "::ffff:192.168.1.92",
      "203.0.113.7",
      "fe80::1",
    ]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });
});

describe("PII endpoints from loopback", () => {
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

  test("stay readable locally without a token", async () => {
    for (const path of ["api/live-bets", "api/agent-tree"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status).toBe(200);
    }
  });

  test("the retired get-pending route fails loudly instead of answering", async () => {
    const res = await fetch(`${server.url}api/f402/get-pending`);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/api/live-bets");
  });
});
