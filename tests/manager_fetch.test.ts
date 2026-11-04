import { afterEach, describe, expect, test } from "bun:test";
import {
  assertBunFloor,
  assertJsonResponse,
  BUN_FLOOR,
  fetchManagerJson,
  fetchWithRetry,
  requireGsid,
  writeJsonFile,
  writeJsonFileIfChanged,
  writeTextFileIfChanged,
  MANAGER_REFERER,
  MANAGER_USER_AGENT,
} from "../lib/manager_fetch.ts";

describe("requireGsid", () => {
  test("returns the cookie string and never logs it", () => {
    expect(requireGsid("tool-x", () => "abc123")).toBe("GSID=abc123");
  });

  test("prefers GSLIVE_SESSION_ID and still reads the pre-rename GSID", () => {
    const read = (values: Record<string, string>) => (name: string) =>
      values[name];
    expect(
      requireGsid("t", read({ GSLIVE_SESSION_ID: "new", GSID: "old" })),
    ).toBe("GSID=new");
    expect(requireGsid("t", read({ GSID: "old" }))).toBe("GSID=old");
  });

  test("throws fail-closed when the session id is missing", () => {
    expect(() => requireGsid("tool-x", () => undefined)).toThrow(
      /GSLIVE_SESSION_ID is empty/,
    );
  });
});

describe("assertJsonResponse", () => {
  test("passes on ok + json", () => {
    expect(() =>
      assertJsonResponse(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "tool-x",
      ),
    ).not.toThrow();
  });

  test("302 surfaces as expired-session redirect", () => {
    expect(() =>
      assertJsonResponse(
        new Response("", {
          status: 302,
          headers: { location: "/login" },
        }),
        "tool-x",
      ),
    ).toThrow(/redirected.*GSID likely expired/);
  });

  test("non-ok throws HTTP status", () => {
    expect(() =>
      assertJsonResponse(new Response("x", { status: 500 }), "tool-x"),
    ).toThrow(/HTTP 500/);
  });

  test("200 html triggers the login-page trap", () => {
    expect(() =>
      assertJsonResponse(
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        "tool-x",
      ),
    ).toThrow(/not JSON.*login HTML page/);
  });
});

describe("fetchWithRetry (Bun.sleep backoff)", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base = "";
  let attempts = 0;
  let failuresBeforeSuccess = 0;

  function start() {
    attempts = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/flaky": () => {
          attempts++;
          if (attempts <= failuresBeforeSuccess) {
            return new Response("boom", { status: 500 });
          }
          return Response.json({ ok: true });
        },
        "/down": () => {
          attempts++;
          return new Response("boom", { status: 500 });
        },
        "/missing": () => {
          attempts++;
          return new Response("nope", { status: 404 });
        },
        "/login-redirect": () => {
          attempts++;
          return new Response("", {
            status: 302,
            headers: { location: "/login" },
          });
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("retries 500s with backoff, then returns the good response", async () => {
    start();
    failuresBeforeSuccess = 2;
    const res = await fetchWithRetry(() => fetch(`${base}/flaky`), "tool-x", {
      attempts: 4,
      baseMs: 5,
    });
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("gives up after the configured attempts", async () => {
    start();
    await expect(
      fetchWithRetry(() => fetch(`${base}/down`), "tool-x", {
        attempts: 3,
        baseMs: 1,
      }),
    ).rejects.toThrow(/HTTP 500 after 3 attempts/);
    expect(attempts).toBe(3);
  });

  test("404 and 302-to-login fail immediately without retry", async () => {
    start();
    await expect(
      fetchWithRetry(
        () => fetchManagerJson(`${base}/missing`, "GSID=x"),
        "tool-x",
        {
          attempts: 4,
          baseMs: 1,
        },
      ),
    ).rejects.toThrow(/HTTP 404/);
    expect(attempts).toBe(1);

    await expect(
      fetchWithRetry(
        () => fetchManagerJson(`${base}/login-redirect`, "GSID=x"),
        "tool-x",
        {
          attempts: 4,
          baseMs: 1,
        },
      ),
    ).rejects.toThrow(/redirected/);
    expect(attempts).toBe(2); // one attempt per endpoint, no retries
  });
});

describe("assertBunFloor (repo floor gate)", () => {
  test("passes on the running Bun", () => {
    expect(() => assertBunFloor("tool-x")).not.toThrow();
    expect(Bun.semver.satisfies(Bun.version, BUN_FLOOR)).toBe(true);
  });

  test("the floor predicate rejects stale runtimes", () => {
    expect(Bun.semver.satisfies("1.4.4", BUN_FLOOR)).toBe(true);
    expect(Bun.semver.satisfies("1.3.99", BUN_FLOOR)).toBe(false);
  });
});

describe("writeJsonFileIfChanged / writeTextFileIfChanged (Wyhash compare)", () => {
  const dir = `tests/.tmp-write-if-changed-${Date.now()}`;

  test("writes new files, skips identical reruns, rewrites on change", async () => {
    const jsonPath = `${dir}/a.json`;
    const first = await writeJsonFileIfChanged(jsonPath, { a: 1 });
    expect(first.wrote).toBe(true);
    expect(first.pretty).toContain('"a": 1');

    const same = await writeJsonFileIfChanged(jsonPath, { a: 1 });
    expect(same.wrote).toBe(false);

    const changed = await writeJsonFileIfChanged(jsonPath, { a: 2 });
    expect(changed.wrote).toBe(true);
    expect(await Bun.file(jsonPath).json()).toEqual({ a: 2 });

    const txtPath = `${dir}/b.txt`;
    expect(await writeTextFileIfChanged(txtPath, "hello")).toBe(true);
    expect(await writeTextFileIfChanged(txtPath, "hello")).toBe(false);
    expect(await writeTextFileIfChanged(txtPath, "hello!")).toBe(true);

    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("fetchManagerJson + writeJsonFile (local server)", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base = "";

  function start() {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/json": () =>
          Response.json(
            { ok: true },
            { headers: { "content-type": "application/json" } },
          ),
        "/html": () =>
          new Response("<html>login</html>", {
            headers: { "content-type": "text/html" },
          }),
        "/redir": () =>
          new Response("", {
            status: 302,
            headers: { location: "/login" },
          }),
        "/echo": (req) =>
          Response.json({
            cookie: req.headers.get("cookie"),
            userAgent: req.headers.get("user-agent"),
            referer: req.headers.get("referer"),
          }),
      },
      fetch: () => new Response("not found", { status: 404 }),
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("sends cookie + UA + referer headers", async () => {
    start();
    const res = await fetchManagerJson(`${base}/echo`, "GSID=abc123");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cookie).toBe("GSID=abc123");
    expect(body.userAgent).toBe(MANAGER_USER_AGENT);
    expect(body.referer).toBe(MANAGER_REFERER);
  });

  test("does not follow redirects (manual)", async () => {
    start();
    const res = await fetchManagerJson(`${base}/redir`, "GSID=abc123");
    expect(res.status).toBe(302);
    expect(() => assertJsonResponse(res, "tool-x")).toThrow(/redirected/);
  });

  test("html body fails the guard before JSON.parse", async () => {
    start();
    const res = await fetchManagerJson(`${base}/html`, "GSID=abc123");
    expect(() => assertJsonResponse(res, "tool-x")).toThrow(/not JSON/);
  });

  test("writeJsonFile round-trips pretty JSON", async () => {
    const path = `tests/.tmp-manager-fetch-${Date.now()}/out.json`;
    const pretty = await writeJsonFile(path, { a: 1 });
    expect(pretty).toContain('"a": 1');
    expect(await Bun.file(path).json()).toEqual({ a: 1 });
    const { rm } = await import("node:fs/promises");
    await rm("tests/.tmp-manager-fetch", { recursive: true, force: true });
  });
});
