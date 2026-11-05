import { describe, expect, test } from "bun:test";

/**
 * `Bun.serve({ routes })` is the native router the blob gateway and docs server already use.
 * Pin the shapes the docs advertise: static responses, `:param` routes, per-method handlers,
 * a wildcard, a redirect, a lazy `Bun.file`, and the `fetch` fallback for unmatched paths.
 *
 * `port: 0` makes the OS pick the port; every request is built with `new URL(path, server.url)`
 * because `server.url.href` already ends in `/` (string-concatenating `/path` yields `//path`).
 */
describe("Bun.serve routes", () => {
  test("static, param, method, wildcard, redirect, file and fallback", async () => {
    const server = Bun.serve({
      port: 0,
      routes: {
        "/api/status": new Response("OK"),
        "/users/:id": (req) => Response.json({ id: req.params.id }),
        "/api/posts": {
          GET: () => new Response("list"),
          POST: async (req) => Response.json({ body: await req.json() }),
        },
        "/api/*": Response.json({ message: "not found" }, { status: 404 }),
        "/blog/hello": Response.redirect("/blog/hello/world"),
        "/self.ts": Bun.file(import.meta.path),
      },
      fetch: (req) =>
        new Response(`fallback:${new URL(req.url).pathname}`, { status: 404 }),
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBeInstanceOf(URL);
      expect(server.url.href.endsWith("/")).toBe(true);
      expect(new URL("api/status", server.url).href).toBe(
        `${server.url.href}api/status`,
      );

      const at = (path: string, init?: RequestInit) =>
        fetch(new URL(path, server.url), init);

      expect(await (await at("api/status")).text()).toBe("OK");

      const user = await at("users/42");
      expect(user.status).toBe(200);
      expect(await user.json()).toEqual({ id: "42" });

      expect(await (await at("api/posts")).text()).toBe("list");
      const created = await at("api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(await created.json()).toEqual({ body: { a: 1 } });

      const wildcard = await at("api/missing");
      expect(wildcard.status).toBe(404);
      expect(await wildcard.json()).toEqual({ message: "not found" });

      const redirect = await at("blog/hello", { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/blog/hello/world");

      expect(await (await at("self.ts")).text()).toContain("Bun.serve routes");

      const fallback = await at("other");
      expect(fallback.status).toBe(404);
      expect(await fallback.text()).toBe("fallback:/other");
    } finally {
      server.stop(true);
    }
  });
});
