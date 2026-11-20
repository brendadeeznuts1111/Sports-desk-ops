/**
 * @file tests/raw_http_tcp.test.ts
 * @description Offline RFC 9110/9112 framing, smuggling rejection, and chunked-decoding tests for `src/lib/raw_http_tcp.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  buildRequestPayload,
  decodeChunkedBody,
  findHeaderEnd,
  formatHostHeader,
  parseResponseHead,
} from "../src/lib/raw_http_tcp.ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

describe("formatHostHeader", () => {
  test("formats domains, IPv4, and IPv6 literals while omitting matching defaultPort", () => {
    expect(formatHostHeader("example.com", 80)).toBe("example.com");
    expect(formatHostHeader("example.com", 443, 443)).toBe("example.com");
    expect(formatHostHeader("example.com", 8080)).toBe("example.com:8080");
    expect(formatHostHeader("127.0.0.1", 4024)).toBe("127.0.0.1:4024");
    expect(formatHostHeader("::1", 80)).toBe("[::1]");
    expect(formatHostHeader("::1", 4024)).toBe("[::1]:4024");
    expect(formatHostHeader("[2001:db8::1]", 443, 443)).toBe("[2001:db8::1]");
    expect(formatHostHeader("[::1]", 8443, 443)).toBe("[::1]:8443");
  });

  test("rejects invalid ports, embedded ports, zone IDs, and malformed IPv6/host inputs", () => {
    for (const badPort of [0, -1, 65536, 80.5, Number.NaN]) {
      expect(() => formatHostHeader("example.com", badPort)).toThrow(
        "ERR_RAW_TCP_INVALID_PORT",
      );
    }
    expect(() => formatHostHeader("example.com", 80, 0)).toThrow(
      "ERR_RAW_TCP_INVALID_PORT",
    );

    const invalidHosts = [
      "",
      "   ",
      "example.com:8080",
      "example.com/path",
      "user@example.com",
      "example.com?a=1",
      "example.com#frag",
      "fe80::1%eth0",
      "[::1",
      "::1]",
      "[[::1]]",
      "[not-an-ip]",
      "not:an:ipv6",
      "bad host.com",
      "bad\u0000host.com",
    ];
    for (const badHost of invalidHosts) {
      expect(() => formatHostHeader(badHost, 80), badHost).toThrow(
        "ERR_RAW_TCP_INVALID_HEADER",
      );
    }
  });
});

describe("buildRequestPayload", () => {
  test("constructs GET/POST payloads with Host, Connection, Content-Length, and first-wins header dedup", () => {
    const getBytes = buildRequestPayload(
      "/static/./hello.txt",
      "GET",
      "127.0.0.1",
      4024,
      {
        "X-Trace": " first ",
        "x-trace": "second",
        "X-Tab": "a\tb",
      },
      null,
    );
    expect(DEC.decode(getBytes)).toBe(
      [
        "GET /static/./hello.txt HTTP/1.1",
        "Host: 127.0.0.1:4024",
        "Connection: close",
        "X-Trace: first",
        "X-Tab: a\tb",
        "",
        "",
      ].join("\r\n"),
    );

    const postBody = ENC.encode('{"ok":true}');
    const postBytes = buildRequestPayload(
      "/api/echo",
      "POST",
      "example.com",
      443,
      { "Content-Type": "application/json" },
      postBody,
      { defaultPort: 443, connection: "keep-alive" },
    );
    expect(DEC.decode(postBytes)).toBe(
      [
        "POST /api/echo HTTP/1.1",
        "Host: example.com",
        "Connection: keep-alive",
        "Content-Type: application/json",
        `Content-Length: ${postBody.byteLength}`,
        "",
        '{"ok":true}',
      ].join("\r\n"),
    );

    const explicitCl = buildRequestPayload(
      "/api/echo",
      "POST",
      "example.com",
      80,
      { "Content-Length": "4" },
      ENC.encode("ping"),
    );
    expect(DEC.decode(explicitCl)).toContain("Content-Length: 4\r\n\r\nping");

    const emptyPost = buildRequestPayload(
      "/api/empty",
      "POST",
      "example.com",
      80,
      {},
      new Uint8Array(0),
    );
    expect(DEC.decode(emptyPost)).toContain("Content-Length: 0\r\n\r\n");
  });

  test("rejects CRLF injection, invalid methods/targets, header smuggling, and CL mismatches", () => {
    expect(() =>
      buildRequestPayload("/a", "GET\r\nX: 1", "example.com", 80, {}, null),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      buildRequestPayload("/a\r\n", "GET", "example.com", 80, {}, null),
    ).toThrow("ERR_RAW_TCP_INVALID_TARGET".replace("TARGET", "HEADER"));
    expect(() =>
      buildRequestPayload(
        "/a",
        "GET",
        "example.com",
        80,
        { "X-Bad\r\n": "1" },
        null,
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      buildRequestPayload(
        "/a",
        "GET",
        "example.com",
        80,
        { "X-Bad": "1\n2" },
        null,
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");

    expect(() =>
      buildRequestPayload("/a", "BAD METHOD", "example.com", 80, {}, null),
    ).toThrow("ERR_RAW_TCP_INVALID_METHOD");

    for (const badTarget of ["", "/a b", "/a#frag", "/a\u0000b", "/café"]) {
      expect(
        () =>
          buildRequestPayload(badTarget, "GET", "example.com", 80, {}, null),
        badTarget,
      ).toThrow("ERR_RAW_TCP_INVALID_TARGET");
    }

    expect(() =>
      buildRequestPayload(
        "/a",
        "GET",
        "example.com",
        80,
        { "X-Val": "café" },
        null,
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      buildRequestPayload(
        "/a",
        "GET",
        "example.com",
        80,
        { "Bad Header": "1" },
        null,
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");

    expect(() =>
      buildRequestPayload(
        "/a",
        "POST",
        "example.com",
        80,
        { "Content-Length": "4", "Transfer-Encoding": "chunked" },
        ENC.encode("ping"),
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");

    for (const badCl of ["5", "abc", "9007199254740993"]) {
      expect(
        () =>
          buildRequestPayload(
            "/a",
            "POST",
            "example.com",
            80,
            { "Content-Length": badCl },
            ENC.encode("ping"),
          ),
        badCl,
      ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    }
  });
});

describe("parseResponseHead & findHeaderEnd", () => {
  test("parses status lines, multi-value headers, chunked, content-length, and eof framing", () => {
    const chunked = parseResponseHead(
      [
        "HTTP/1.1 200 OK",
        "Set-Cookie: a=1",
        "Set-Cookie: b=2",
        "Transfer-Encoding: gzip, chunked",
        "",
        "",
      ].join("\r\n"),
    );
    expect(chunked.status).toBe(200);
    expect(chunked.reason).toBe("OK");
    expect(chunked.framing).toBe("chunked");
    expect(chunked.contentLength).toBeNull();
    expect(chunked.headers["set-cookie"]).toEqual(["a=1", "b=2"]);

    const cl = parseResponseHead(
      [
        "HTTP/1.0 201 Created",
        "Content-Length: 12",
        "Content-Length: 12",
        "",
        "",
      ].join("\r\n"),
    );
    expect(cl.status).toBe(201);
    expect(cl.framing).toBe("content-length");
    expect(cl.contentLength).toBe(12);

    const eof = parseResponseHead("HTTP/1.1 204\r\nX-Ok: yes\r\n\r\n");
    expect(eof.status).toBe(204);
    expect(eof.reason).toBe("");
    expect(eof.framing).toBe("eof");

    const wire = ENC.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
    expect(findHeaderEnd(wire)).toBe(34);
    expect(findHeaderEnd(ENC.encode("HTTP/1.1 200 OK\r\n"))).toBe(-1);
  });

  test("rejects malformed status lines, bad headers, TE/CL conflicts, and CL smuggling", () => {
    expect(() => parseResponseHead("HTTP/2 200 OK\r\n\r\n")).toThrow(
      "ERR_RAW_TCP_INVALID_STATUS",
    );
    expect(() =>
      parseResponseHead("HTTP/1.1 200 OK\r\nBadHeader\r\n\r\n"),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead("HTTP/1.1 200 OK\r\nBad Name: 1\r\n\r\n"),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead("HTTP/1.1 200 OK\r\nX-Ok: café\r\n\r\n"),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n",
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n"),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead(
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 7\r\n\r\n",
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
    expect(() =>
      parseResponseHead(
        "HTTP/1.1 200 OK\r\nContent-Length: 9007199254740993\r\n\r\n",
      ),
    ).toThrow("ERR_RAW_TCP_INVALID_HEADER");
  });
});

describe("decodeChunkedBody", () => {
  test("decodes multi-chunk payloads with chunk extensions and valid trailers", () => {
    const body = decodeChunkedBody(
      ENC.encode(
        "5;ext=1\r\nhello\r\n6\r\n world\r\n0;done=yes\r\nX-Checksum: abc123\r\n\r\n",
      ),
    );
    expect(DEC.decode(body)).toBe("hello world");

    expect(decodeChunkedBody(ENC.encode("0\r\n\r\n")).byteLength).toBe(0);
  });

  test("rejects malformed chunks, missing trailer terminators, bad trailers, and trailing bytes", () => {
    const invalidBodies = [
      "5",
      "xyz\r\nhello\r\n0\r\n\r\n",
      "ffffffffffffff\r\n",
      "5\r\nhi",
      "5\r\nhelloXX0\r\n\r\n",
      "5\r\nhello\r\n",
      "0\r\n",
      "0\r\nBadTrailer\r\n\r\n",
      "0\r\nBad Name: 1\r\n\r\n",
      "0\r\n\r\nGET /smuggled HTTP/1.1\r\n\r\n",
    ];
    for (const raw of invalidBodies) {
      expect(() => decodeChunkedBody(ENC.encode(raw)), raw).toThrow(
        "ERR_RAW_TCP_INVALID_CHUNK",
      );
    }
  });
});
