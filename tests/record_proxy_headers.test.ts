import { describe, expect, test } from "bun:test";

import { forwardableHeaders } from "../scripts/net/record_proxy.ts";

/**
 * The recording proxy fetches the target URL with the forwarded headers. A client-supplied Host
 * must not be relayed: fetch derives it from the URL, and before Bun 1.4.1 that header also
 * selected TLS verification (Host-header injection).
 */
describe("record_proxy forwardableHeaders", () => {
  test("drops the client Host and hop-by-hop headers", () => {
    const forwarded = forwardableHeaders(
      new Headers({
        Host: "evil.example",
        Connection: "keep-alive",
        "proxy-authorization": "secret",
        "x-test": "1",
        cookie: "session=1",
      }),
    );
    expect(forwarded.has("host")).toBe(false);
    expect(forwarded.has("connection")).toBe(false);
    expect(forwarded.has("proxy-authorization")).toBe(false);
    expect(forwarded.get("x-test")).toBe("1");
    expect(forwarded.get("cookie")).toBe("session=1");
  });
});
