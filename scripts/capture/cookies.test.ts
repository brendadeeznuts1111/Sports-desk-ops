import { describe, expect, test } from "bun:test";
import {
  buildCookieHeader,
  CookieError,
  cookieHandoffForHost,
  parseCdpCookies,
  redactCookieHeader,
  selectCookiesForHost,
  summarizeCookies,
  type CdpCookie,
} from "./cookies.ts";

const HOST = "portal.f402.test";
const NOW = 1_800_000_000_000; // fixed ms clock; expires is seconds

function cdpCookie(
  overrides: Partial<CdpCookie> & { name: string },
): CdpCookie {
  return {
    value: `v-${overrides.name}`,
    domain: HOST,
    path: "/",
    httpOnly: true,
    secure: true,
    ...overrides,
  };
}

/** Split a Cookie header into name/value pairs, preserving wire order. */
function headerPairs(header: string): Array<[string, string]> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const equals = part.indexOf("=");
      return [part.slice(0, equals), part.slice(equals + 1)] as [
        string,
        string,
      ];
    });
}

function headerValue(header: string, name: string): string | undefined {
  return headerPairs(header).find(([key]) => key === name)?.[1];
}

describe("selectCookiesForHost: path scope is opt-in", () => {
  test("no requestPath keeps a Path=/cloud cookie (whole-domain jar)", () => {
    const jar = [
      cdpCookie({ name: "root" }),
      cdpCookie({ name: "session", path: "/cloud", value: "cloud-value" }),
    ];
    const selected = selectCookiesForHost(jar, HOST, undefined, NOW);
    expect(selected.map((cookie) => cookie.name).sort()).toEqual([
      "root",
      "session",
    ]);
  });

  test("explicit /cloud/api/x includes the /cloud cookie", () => {
    const jar = [
      cdpCookie({ name: "root" }),
      cdpCookie({ name: "session", path: "/cloud", value: "cloud-value" }),
    ];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, "/cloud/api/x", NOW),
    );
    expect(headerValue(header, "session")).toBe("cloud-value");
    expect(headerValue(header, "root")).toBe("v-root");
  });

  test("exact path match is included", () => {
    const jar = [cdpCookie({ name: "session", path: "/cloud" })];
    expect(selectCookiesForHost(jar, HOST, "/cloud", NOW)).toHaveLength(1);
  });

  test("/cloudy does NOT include the /cloud cookie", () => {
    const jar = [
      cdpCookie({ name: "root" }),
      cdpCookie({ name: "session", path: "/cloud", value: "cloud-value" }),
    ];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, "/cloudy", NOW),
    );
    expect(headerValue(header, "session")).toBeUndefined();
    expect(headerValue(header, "root")).toBe("v-root");
  });

  test("a Path=/cloudy cookie does cover /cloudy but not /cloud", () => {
    const jar = [cdpCookie({ name: "cloudy", path: "/cloudy" })];
    expect(selectCookiesForHost(jar, HOST, "/cloudy", NOW)).toHaveLength(1);
    expect(selectCookiesForHost(jar, HOST, "/cloud", NOW)).toHaveLength(0);
  });

  test("a query string is ignored when matching the path", () => {
    const jar = [cdpCookie({ name: "session", path: "/cloud" })];
    expect(
      selectCookiesForHost(jar, HOST, "/cloud/api/x?page=2", NOW),
    ).toHaveLength(1);
  });
});

describe("selectCookiesForHost: domain and expiry", () => {
  test("expired cookies are dropped", () => {
    const jar = [
      cdpCookie({ name: "fresh", expires: Math.floor(NOW / 1000) + 60 }),
      cdpCookie({ name: "stale", expires: Math.floor(NOW / 1000) - 60 }),
      cdpCookie({ name: "session-cookie" }), // no expires => session cookie
      cdpCookie({ name: "epoch", expires: 0 }), // CDP session marker
    ];
    expect(
      selectCookiesForHost(jar, HOST, undefined, NOW).map(
        (cookie) => cookie.name,
      ),
    ).toEqual(["epoch", "fresh", "session-cookie"]);
  });

  test("wrong domain is dropped; host-only does not leak to subdomains", () => {
    const jar = [
      cdpCookie({ name: "right" }),
      cdpCookie({ name: "other", domain: "evil.test" }),
      cdpCookie({ name: "parent", domain: ".f402.test" }),
      // Host-only cookie (no leading dot) for the parent domain: RFC 6265
      // domain-match requires an exact host match, so it must NOT reach
      // portal.f402.test.
      cdpCookie({ name: "hostonly", domain: "f402.test" }),
    ];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, undefined, NOW),
    );
    expect(headerValue(header, "right")).toBe("v-right");
    expect(headerValue(header, "parent")).toBe("v-parent");
    expect(headerValue(header, "hostonly")).toBeUndefined();
    expect(headerValue(header, "other")).toBeUndefined();
  });

  test("host-only cookie for the exact host is kept", () => {
    const jar = [cdpCookie({ name: "session", domain: HOST })];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, undefined, NOW),
    );
    expect(headerValue(header, "session")).toBe("v-session");
  });

  test("dot-domain cookie reaches subdomains and its own apex", () => {
    const jar = [cdpCookie({ name: "parent", domain: ".f402.test" })];
    expect(
      selectCookiesForHost(jar, "portal.f402.test", undefined, NOW),
    ).toHaveLength(1);
    expect(selectCookiesForHost(jar, "f402.test", undefined, NOW)).toHaveLength(
      1,
    );
    expect(selectCookiesForHost(jar, "evil.test", undefined, NOW)).toHaveLength(
      0,
    );
  });

  test("host port is ignored for domain matching", () => {
    const jar = [cdpCookie({ name: "session" })];
    expect(
      selectCookiesForHost(jar, "portal.f402.test:8443", undefined, NOW),
    ).toHaveLength(1);
  });

  test("IPv6 [::1] host matches a ::1 cookie and vice versa", () => {
    const fromBracketedHost = selectCookiesForHost(
      [cdpCookie({ name: "ipv6", domain: "::1" })],
      "[::1]:443",
      undefined,
      NOW,
    );
    expect(fromBracketedHost).toHaveLength(1);

    const fromBareHost = selectCookiesForHost(
      [cdpCookie({ name: "ipv6", domain: "[::1]" })],
      "::1",
      undefined,
      NOW,
    );
    expect(fromBareHost).toHaveLength(1);

    expect(
      selectCookiesForHost(
        [cdpCookie({ name: "ipv6", domain: "::1" })],
        "::2",
        undefined,
        NOW,
      ),
    ).toHaveLength(0);
  });
});

describe("selectCookiesForHost: ordering and dedupe", () => {
  test("most specific path comes first and a duplicated name appears once", () => {
    const jar = [
      cdpCookie({ name: "dupe", path: "/", value: "D1" }),
      cdpCookie({ name: "dupe", path: "/cloud", value: "D2" }),
    ];

    const wholeJar = selectCookiesForHost(jar, HOST, undefined, NOW);
    expect(wholeJar).toHaveLength(1);
    expect(buildCookieHeader(wholeJar)).toBe("dupe=D2");

    const cloud = selectCookiesForHost(jar, HOST, "/cloud/api/x", NOW);
    expect(cloud).toHaveLength(1);
    expect(cloud[0]?.value).toBe("D2");

    const root = selectCookiesForHost(jar, HOST, "/", NOW);
    expect(root).toHaveLength(1);
    expect(root[0]?.value).toBe("D1");

    // Regression guard for the old `dupe=D1; dupe=D2` header.
    expect(buildCookieHeader(wholeJar)).not.toContain("dupe=D1");
  });

  test("distinct names are ordered by path length then name", () => {
    const jar = [
      cdpCookie({ name: "zeta", path: "/" }),
      cdpCookie({ name: "alpha", path: "/cloud" }),
      cdpCookie({ name: "beta", path: "/" }),
    ];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, undefined, NOW),
    );
    expect(headerPairs(header).map(([name]) => name)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("same name+path on two domains picks one deterministically", () => {
    const domainCookie = cdpCookie({
      name: "session",
      domain: ".f402.test",
      value: "domain-value",
    });
    const hostCookie = cdpCookie({
      name: "session",
      domain: HOST,
      value: "host-value",
    });
    const forwards = selectCookiesForHost(
      [domainCookie, hostCookie],
      HOST,
      undefined,
      NOW,
    );
    const backwards = selectCookiesForHost(
      [hostCookie, domainCookie],
      HOST,
      undefined,
      NOW,
    );
    expect(forwards).toHaveLength(1);
    expect(backwards).toHaveLength(1);
    // Domain lexical tie-break: ".f402.test" < "portal.f402.test".
    expect(forwards[0]?.value).toBe("domain-value");
    expect(backwards[0]?.value).toBe("domain-value");
  });

  test("path specificity outranks the domain tie-break", () => {
    const jar = [
      cdpCookie({
        name: "session",
        domain: ".f402.test",
        path: "/",
        value: "wide-value",
      }),
      cdpCookie({
        name: "session",
        domain: HOST,
        path: "/cloud",
        value: "cloud-value",
      }),
    ];
    const selected = selectCookiesForHost(jar, HOST, undefined, NOW);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.value).toBe("cloud-value");
  });
});

describe("selectCookiesForHost: transport scope", () => {
  test("secure cookies are dropped for a plain-http request", () => {
    const jar = [
      cdpCookie({ name: "secure", secure: true, value: "s-value" }),
      cdpCookie({ name: "plain", secure: false, value: "p-value" }),
    ];
    const header = buildCookieHeader(
      selectCookiesForHost(jar, HOST, undefined, NOW, {
        requestSecure: false,
      }),
    );
    expect(headerValue(header, "secure")).toBeUndefined();
    expect(headerValue(header, "plain")).toBe("p-value");
  });

  test("secure cookies are kept for an https request", () => {
    const jar = [
      cdpCookie({ name: "secure", secure: true, value: "s-value" }),
      cdpCookie({ name: "plain", secure: false, value: "p-value" }),
    ];
    for (const options of [{ requestSecure: true }, undefined]) {
      const header = buildCookieHeader(
        selectCookiesForHost(jar, HOST, undefined, NOW, options),
      );
      expect(headerValue(header, "secure")).toBe("s-value");
      expect(headerValue(header, "plain")).toBe("p-value");
    }
  });

  test("handoff drops secure cookies over http and keeps them over https", () => {
    const jar = [
      cdpCookie({ name: "secure", secure: true, value: "s-value" }),
      cdpCookie({ name: "plain", secure: false, value: "p-value" }),
    ];
    const http = cookieHandoffForHost(jar, HOST, undefined, NOW, {
      requestSecure: false,
    });
    expect(http.header).toBe("plain=p-value");
    expect(http.summary.names).toEqual(["plain"]);

    const https = cookieHandoffForHost(jar, HOST, undefined, NOW, {
      requestSecure: true,
    });
    expect(headerValue(https.header, "secure")).toBe("s-value");
    expect(headerValue(https.header, "plain")).toBe("p-value");
    expect(https.summary.names).toEqual(["plain", "secure"]);
  });

  test("a secure-only jar over http throws a value-free CookieError", () => {
    const jar = [cdpCookie({ name: "secure", value: "super-secret" })];
    expect(() =>
      cookieHandoffForHost(jar, HOST, undefined, NOW, {
        requestSecure: false,
      }),
    ).toThrow(CookieError);
    try {
      cookieHandoffForHost(jar, HOST, undefined, NOW, { requestSecure: false });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
    }
  });
});

describe("cookieHandoffForHost", () => {
  test("default handoff includes a Path=/cloud session cookie", () => {
    const jar = [
      cdpCookie({ name: "root" }),
      cdpCookie({ name: "session", path: "/cloud", value: "cloud-value" }),
    ];
    const handoff = cookieHandoffForHost(jar, HOST, undefined, NOW);
    expect(headerValue(handoff.header, "session")).toBe("cloud-value");
    expect(handoff.summary.names).toEqual(["root", "session"]);
    expect(handoff.summary.headerPresent).toBe(true);
    expect(handoff.summary.count).toBe(2);
    expect(handoff.summary.redactedHeader).not.toContain("cloud-value");
  });

  test("default handoff (no argument at all) uses the whole-domain jar", () => {
    const jar = [cdpCookie({ name: "session", path: "/manager" })];
    expect(cookieHandoffForHost(jar, HOST).header).toBe("session=v-session");
  });

  test("explicit path narrows the handoff", () => {
    const jar = [
      cdpCookie({ name: "root", value: "root-value" }),
      cdpCookie({ name: "session", path: "/cloud", value: "cloud-value" }),
    ];
    expect(
      headerValue(
        cookieHandoffForHost(jar, HOST, "/cloud/api/x", NOW).header,
        "session",
      ),
    ).toBe("cloud-value");
    expect(
      headerValue(
        cookieHandoffForHost(jar, HOST, "/manager/api/x", NOW).header,
        "session",
      ),
    ).toBeUndefined();
  });

  test("throws CookieError when nothing is scoped to the host", () => {
    const jar = [cdpCookie({ name: "session", domain: "evil.test" })];
    expect(() => cookieHandoffForHost(jar, HOST, undefined, NOW)).toThrow(
      CookieError,
    );
  });
});

describe("parseCdpCookies", () => {
  test("accepts a well-formed CDP result and defaults path to /", () => {
    const cookies = parseCdpCookies({
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: HOST,
          httpOnly: true,
          secure: true,
        },
      ],
    });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.path).toBe("/");
    expect(cookies[0]?.httpOnly).toBe(true);
  });

  test("rejects malformed entries", () => {
    expect(() => parseCdpCookies(null)).toThrow(CookieError);
    expect(() => parseCdpCookies({})).toThrow(CookieError);
    expect(() => parseCdpCookies({ cookies: "nope" })).toThrow(CookieError);
    expect(() => parseCdpCookies({ cookies: [null] })).toThrow(CookieError);
    expect(() => parseCdpCookies({ cookies: [{ value: "abc" }] })).toThrow(
      CookieError,
    );
    expect(() =>
      parseCdpCookies({ cookies: [{ name: "", value: "abc" }] }),
    ).toThrow(CookieError);
    expect(() =>
      parseCdpCookies({ cookies: [{ name: "session", value: 42 }] }),
    ).toThrow(CookieError);
  });
});

describe("unchanged helpers", () => {
  test("buildCookieHeader joins name=value pairs", () => {
    expect(
      buildCookieHeader([
        cdpCookie({ name: "a", value: "1" }),
        cdpCookie({ name: "b", value: "2" }),
      ]),
    ).toBe("a=1; b=2");
  });

  test("redactCookieHeader and summarizeCookies never expose values", () => {
    const cookies = [cdpCookie({ name: "session", value: "super-secret" })];
    const header = buildCookieHeader(cookies);
    expect(redactCookieHeader(header)).toBe("session=<redacted>");
    const summary = summarizeCookies(cookies, header);
    expect(summary.names).toEqual(["session"]);
    expect(JSON.stringify(summary)).not.toContain("super-secret");
  });
});
