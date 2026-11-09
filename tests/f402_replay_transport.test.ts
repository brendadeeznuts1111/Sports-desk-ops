import { describe, expect, test } from "bun:test";

import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";

const baseEnv = {
  F402_REPLAY_PROXY_URL: "",
  F402_COOKIE: "",
} as const;

describe("createF402ReplayTransport", () => {
  test("replay transport retries once after 401 refresh", async () => {
    let calls = 0;
    let refreshed = 0;
    const transport = await createF402ReplayTransport({
      env: { ...baseEnv },
      readSession: () => ({
        cookieHeader: "session=test",
        cookieNames: ["session"],
        obtainedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 401 })
          : new Response("ok", { status: 200 });
      },
      refreshSession: async () => {
        refreshed += 1;
      },
    });

    const response = await transport.fetch("https://f402.example/x", {});
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(refreshed).toBe(1);
    await transport.close();
  });

  test("replay transport does not loop on repeated 401", async () => {
    let calls = 0;
    let refreshed = 0;
    const transport = await createF402ReplayTransport({
      env: { ...baseEnv },
      readSession: () => ({
        cookieHeader: "session=test",
        cookieNames: ["session"],
        obtainedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 401 });
      },
      refreshSession: async () => {
        refreshed += 1;
      },
    });

    const response = await transport.fetch("https://f402.example/x", {});
    expect(response.status).toBe(401);
    expect(calls).toBe(2);
    expect(refreshed).toBe(1);
    await transport.close();
  });

  test("re-reads session cookie on each attempt", async () => {
    let cookieReads = 0;
    const transport = await createF402ReplayTransport({
      env: { ...baseEnv },
      readSession: () => {
        cookieReads += 1;
        // Create-time label read + first fetch share the first cookie; later fetches re-read.
        const first = {
          cookieHeader: "session=first",
          cookieNames: ["session"],
          obtainedAtIso: new Date().toISOString(),
          expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
        };
        const second = {
          cookieHeader: "session=second",
          cookieNames: ["session"],
          obtainedAtIso: new Date().toISOString(),
          expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
        };
        return cookieReads <= 2 ? first : second;
      },
      fetchImpl: async (_url, init) => {
        const cookie = new Headers(init.headers).get("cookie");
        return new Response(cookie ?? "", { status: 200 });
      },
    });

    const first = await transport.fetch("https://f402.example/a", {});
    expect(await first.text()).toBe("session=first");

    const second = await transport.fetch("https://f402.example/b", {});
    expect(await second.text()).toBe("session=second");
    expect(cookieReads).toBe(3);
    await transport.close();
  });
});
