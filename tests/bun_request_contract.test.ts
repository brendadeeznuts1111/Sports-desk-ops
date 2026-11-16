/**
 * @file tests/bun_request_contract.test.ts
 * @description Runtime + type contract for `BunRequest` route handlers:
 * typed `params`, `cookies`, `url`, `headers`, `method`, and the Bun body
 * helpers (`bytes`, `textStream`, `clone`) used by the daemon route maps.
 */
import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";
import type { BunRequest } from "bun";

type EchoRequest = BunRequest<"/echo/:id">;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/text-stream/:id": {
      POST: async (req: BunRequest<"/text-stream/:id">): Promise<Response> => {
        let streamed = "";
        for await (const chunk of req.textStream()) streamed += chunk;

        let secondCallError: string | null = null;
        try {
          req.textStream();
        } catch (error) {
          secondCallError =
            error instanceof TypeError ? "TypeError" : String(error);
        }

        return Response.json({ id: req.params.id, streamed, secondCallError });
      },
    },
    "/echo/:id": {
      POST: async (req: EchoRequest): Promise<Response> => {
        // `bytes()` and `textStream()` both consume the body; clone one side.
        const bytes = await req.clone().bytes();
        let streamed = "";
        for await (const chunk of req.textStream()) streamed += chunk;
        return Response.json({
          id: req.params.id,
          method: req.method,
          pathname: new URL(req.url).pathname,
          query: new URL(req.url).searchParams.get("q"),
          cookie: req.cookies.get("probe") ?? null,
          header: req.headers.get("x-probe"),
          rawUrl: req.url,
          rawUrlIsString: typeof req.url === "string",
          bytes: new TextDecoder().decode(bytes),
          streamed,
        });
      },
    },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("BunRequest", () => {
  test("route params, cookies, url and body helpers are typed", () => {
    expectTypeOf<EchoRequest["params"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<EchoRequest["url"]>().toEqualTypeOf<string>();
    expectTypeOf<EchoRequest["method"]>().toEqualTypeOf<string>();
    expectTypeOf<EchoRequest["cookies"]>().toEqualTypeOf<Bun.CookieMap>();
    expectTypeOf<EchoRequest["headers"]>().toEqualTypeOf<Headers>();
    expectTypeOf<ReturnType<EchoRequest["bytes"]>>().toEqualTypeOf<
      Promise<Uint8Array<ArrayBufferLike>>
    >();
    expectTypeOf<ReturnType<EchoRequest["textStream"]>>().toEqualTypeOf<
      ReadableStream<string>
    >();
    expectTypeOf<
      ReturnType<EchoRequest["clone"]>
    >().toEqualTypeOf<EchoRequest>();
  });

  test("textStream decodes UTF-8 and throws once the body is consumed", async () => {
    const body = "héllo-🎲-world";
    const response = await fetch(`${base}/text-stream/abc`, {
      method: "POST",
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "abc",
      streamed: body,
      secondCallError: "TypeError",
    });
  });

  test("a live route sees typed params, cookies and the decoded body", async () => {
    const response = await fetch(`${base}/echo/769158444?q=abc`, {
      method: "POST",
      headers: {
        cookie: "probe=ok",
        "x-probe": "header-ok",
        "content-type": "text/plain",
      },
      body: "hello-body",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      id: string;
      method: string;
      pathname: string;
      query: string | null;
      cookie: string | null;
      header: string | null;
      rawUrl: string;
      rawUrlIsString: boolean;
      bytes: string;
      streamed: string;
    };
    expect(payload.rawUrlIsString).toBe(true);
    // `BunRequest.url` is the absolute request URL string, query included.
    expect(payload.rawUrl).toBe(`${base}/echo/769158444?q=abc`);
    expect(payload).toEqual({
      id: "769158444",
      method: "POST",
      pathname: "/echo/769158444",
      query: "abc",
      cookie: "ok",
      header: "header-ok",
      rawUrl: `${base}/echo/769158444?q=abc`,
      rawUrlIsString: true,
      bytes: "hello-body",
      streamed: "hello-body",
    });
  });
});
