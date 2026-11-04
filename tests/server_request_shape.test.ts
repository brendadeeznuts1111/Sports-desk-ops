import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * Request-shape edges that used to reach the handler in a state it did not expect.
 *
 * Measured before the fix: a 6 MiB JSON body was accepted by `/api/telegram/alert` (no
 * `maxRequestBodySize`), `/api/logo/%E0%A4%A` answered 500 "URI error" from an uncaught
 * `decodeURIComponent`, and `HEAD /api/status` 404'd because the arm compared `req.method` to
 * `"GET"` while `GET` answered 200.
 */

/** `Bun.env`/`process.env` properties are typed readonly; mutate through Reflect. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, key);
  else Reflect.set(Bun.env, key, value);
}

const savedToken = Bun.env["SPORTSDESK_ADMIN_TOKEN"];
setEnv("SPORTSDESK_ADMIN_TOKEN", "limits-token");

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  setEnv("SPORTSDESK_ADMIN_TOKEN", savedToken);
});

describe("request bodies are bounded", () => {
  test("a body over the cap is refused before any arm reads it", async () => {
    const body = JSON.stringify({
      customerId: "RF2003",
      pad: "x".repeat(2 << 20),
    });
    const response = await fetch(`${base}/api/telegram/alert`, {
      method: "POST",
      headers: {
        authorization: "Bearer limits-token",
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(413);
  });

  test("a normal-sized body still reaches its handler", async () => {
    const form = new FormData();
    form.set("hello", "world");
    const response = await fetch(`${base}/api/parse-formdata`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });
  });
});

describe("malformed input is a client error", () => {
  test("a broken percent-escape in a logo name is 400, not 500", async () => {
    const response = await fetch(`${base}/api/logo/%E0%A4%A`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid logo name");
  });

  test("an invalid analysis selection is 400 with its issues", async () => {
    const response = await fetch(
      `${base}/api/analysis?report=CP&week=1&activity=x`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues?: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });
});

describe("read routes answer HEAD like GET", () => {
  for (const path of ["/api/status", "/status.json", "/api/telegram/status"]) {
    test(`${path} answers HEAD`, async () => {
      const get = await fetch(`${base}${path}`, {
        headers: { authorization: "Bearer limits-token" },
      });
      const head = await fetch(`${base}${path}`, {
        method: "HEAD",
        headers: { authorization: "Bearer limits-token" },
      });
      expect(head.status).toBe(get.status);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });
  }
});
