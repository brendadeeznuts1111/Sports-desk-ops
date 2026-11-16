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
    "/binary-cookie/:id": {
      GET: (req: BunRequest<"/binary-cookie/:id">): Response => {
        req.cookies.set("__Host-bdo_ops_sid", "tok", {
          secure: true,
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    },
    "/params/:value": {
      GET: (req: BunRequest<"/params/:value">): Response =>
        Response.json({
          value: req.params.value,
          codes: [...req.params.value].map((char) => char.codePointAt(0)),
        }),
    },
    "/surface/:id": {
      POST: async (req: BunRequest<"/surface/:id">): Promise<Response> => {
        const bodyUsedBefore = req.bodyUsed;
        const clone = req.clone();
        const bytes = await clone.bytes();
        const bodyIsStream =
          req.body === null || req.body instanceof ReadableStream;
        const text = await req.text();
        return Response.json({
          params: req.params,
          method: req.method,
          urlIsString: typeof req.url === "string",
          query: new URL(req.url).searchParams.get("q"),
          headersAreHeaders: req.headers instanceof Headers,
          cookie: req.cookies.get("probe"),
          cookiesAreCookieMap: req.cookies instanceof Bun.CookieMap,
          bodyIsStream,
          bodyUsedBefore,
          bodyUsedAfterClone: false,
          bodyUsedAfterText: req.bodyUsed,
          cache: req.cache,
          credentials: req.credentials,
          destination: req.destination,
          integrity: req.integrity,
          // Measured Bun 1.4.4: `keepalive` is typed boolean but is absent on
          // server-side BunRequest, so expose the observed value explicitly.
          keepaliveValue:
            typeof req.keepalive === "boolean" ? req.keepalive : null,
          keepaliveType: typeof req.keepalive,
          mode: req.mode,
          redirect: req.redirect,
          referrer: req.referrer,
          referrerPolicy: req.referrerPolicy,
          cloneParams: clone.params,
          cloneCookiesAreCookieMap: clone.cookies instanceof Bun.CookieMap,
          cloneBytes: bytes.byteLength,
          text,
        });
      },
    },
    "/consume/:kind": {
      POST: async (req: BunRequest<"/consume/:kind">): Promise<Response> => {
        switch (req.params.kind) {
          case "array-buffer": {
            const body = await req.arrayBuffer();
            return Response.json({
              isArrayBuffer: body instanceof ArrayBuffer,
              bytes: body.byteLength,
            });
          }
          case "blob": {
            const body = await req.blob();
            return Response.json({
              isBlob: body instanceof Blob,
              size: body.size,
              type: body.type,
              text: await body.text(),
            });
          }
          case "json": {
            return Response.json({ value: await req.json() });
          }
          case "form": {
            const body = await req.formData();
            return Response.json({
              name: body.get("name"),
              email: body.get("email"),
            });
          }
          case "bytes": {
            const body = await req.bytes();
            return Response.json({
              isUint8Array: body instanceof Uint8Array,
              bytes: body.byteLength,
            });
          }
          case "stream": {
            let text = "";
            for await (const chunk of req.textStream()) text += chunk;
            return Response.json({ text });
          }
          default: {
            return Response.json({ text: await req.text() });
          }
        }
      },
    },
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
    expectTypeOf<EchoRequest["body"]>().toMatchTypeOf<ReadableStream | null>();
    expectTypeOf<EchoRequest["bodyUsed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<EchoRequest["cache"]>().toMatchTypeOf<string>();
    expectTypeOf<EchoRequest["credentials"]>().toMatchTypeOf<string>();
    expectTypeOf<EchoRequest["destination"]>().toMatchTypeOf<string>();
    expectTypeOf<EchoRequest["integrity"]>().toEqualTypeOf<string>();
    expectTypeOf<EchoRequest["mode"]>().toMatchTypeOf<string>();
    expectTypeOf<EchoRequest["redirect"]>().toMatchTypeOf<string>();
    expectTypeOf<ReturnType<EchoRequest["arrayBuffer"]>>().toMatchTypeOf<
      Promise<ArrayBuffer>
    >();
    expectTypeOf<ReturnType<EchoRequest["blob"]>>().toMatchTypeOf<
      Promise<Blob>
    >();
    expectTypeOf<ReturnType<EchoRequest["json"]>>().toMatchTypeOf<
      Promise<unknown>
    >();
    expectTypeOf<ReturnType<EchoRequest["text"]>>().toEqualTypeOf<
      Promise<string>
    >();
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

  test("cookies.set flushes Set-Cookie onto a manually built binary Response", async () => {
    const response = await fetch(`${base}/binary-cookie/1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-bdo_ops_sid=tok; Path=/; Secure; HttpOnly; SameSite=Strict",
    ]);
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });

  test("params decode valid UTF-8 and replace malformed sequences", async () => {
    const cases: ReadonlyArray<{
      raw: string;
      value: string;
      codes: readonly number[];
    }> = [
      { raw: "a%20b", value: "a b", codes: [97, 32, 98] },
      { raw: "%E2%82%AC", value: "€", codes: [8364] },
      { raw: "%F0%9F%92%A9", value: "💩", codes: [128169] },
      // Bun's SIMD param decoder substitutes U+FFFD instead of throwing.
      { raw: "a%ZZb", value: "a\uFFFDb", codes: [97, 65533, 98] },
      { raw: "%E2%82", value: "\uFFFD", codes: [65533] },
      { raw: "%FF", value: "\uFFFD", codes: [65533] },
      { raw: "a+b", value: "a+b", codes: [97, 43, 98] },
      { raw: "%2F", value: "/", codes: [47] },
    ];
    for (const testCase of cases) {
      const response = await fetch(`${base}/params/${testCase.raw}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        value: testCase.value,
        codes: [...testCase.codes],
      });
    }

    // The Web decoder is stricter; this is why the route boundary must reject
    // U+FFFD rather than assuming decodeURIComponent semantics.
    expect(() => decodeURIComponent("a%ZZb")).toThrow(URIError);
    expect(() => decodeURIComponent("%E2%82")).toThrow(URIError);
    expect(() => decodeURIComponent("%FF")).toThrow(URIError);
  });

  test("the standard Request surface is present and coherent", async () => {
    const response = await fetch(`${base}/surface/abc?q=1`, {
      method: "POST",
      headers: { cookie: "probe=ok", "content-type": "text/plain" },
      body: "hello",
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.params).toEqual({ id: "abc" });
    expect(body.method).toBe("POST");
    expect(body.urlIsString).toBe(true);
    expect(body.query).toBe("1");
    expect(body.headersAreHeaders).toBe(true);
    expect(body.cookie).toBe("ok");
    expect(body.cookiesAreCookieMap).toBe(true);
    expect(body.bodyIsStream).toBe(true);
    expect(body.bodyUsedBefore).toBe(false);
    expect(body.bodyUsedAfterClone).toBe(false);
    expect(body.bodyUsedAfterText).toBe(true);
    expect(typeof body.cache).toBe("string");
    expect(typeof body.credentials).toBe("string");
    expect(typeof body.destination).toBe("string");
    expect(typeof body.integrity).toBe("string");
    expect(body.keepaliveValue).toBeNull();
    expect(body.keepaliveType).toBe("undefined");
    expect(typeof body.mode).toBe("string");
    expect(typeof body.redirect).toBe("string");
    expect(typeof body.referrer).toBe("string");
    expect(typeof body.referrerPolicy).toBe("string");
    expect(body.cloneParams).toEqual({ id: "abc" });
    expect(body.cloneCookiesAreCookieMap).toBe(true);
    expect(body.cloneBytes).toBe(5);
    expect(body.text).toBe("hello");
  });

  test("every standard body consumer parses the body once", async () => {
    const consume = async (
      kind: string,
      body: string,
      contentType: string,
    ): Promise<unknown> => {
      const response = await fetch(`${base}/consume/${kind}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    expect(await consume("array-buffer", "hello", "text/plain")).toEqual({
      isArrayBuffer: true,
      bytes: 5,
    });
    expect(await consume("blob", "hello", "text/plain")).toEqual({
      isBlob: true,
      size: 5,
      type: "text/plain;charset=utf-8",
      text: "hello",
    });
    expect(await consume("json", '{"a":1}', "application/json")).toEqual({
      value: { a: 1 },
    });
    expect(
      await consume(
        "form",
        "name=Ada&email=ada%40example.com",
        "application/x-www-form-urlencoded",
      ),
    ).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(await consume("bytes", "hello", "text/plain")).toEqual({
      isUint8Array: true,
      bytes: 5,
    });
    expect(await consume("stream", "héllo", "text/plain")).toEqual({
      text: "héllo",
    });
    expect(await consume("text", "hello", "text/plain")).toEqual({
      text: "hello",
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
