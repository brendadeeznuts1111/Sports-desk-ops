import { describe, expect, test } from "bun:test";
import {
  bearerFromHar,
  cookieHeaderFrom,
  cookiesFromHar,
  parseCookieHeader,
  parseSetCookieHeader,
} from "../lib/cookie_jar.ts";

const HAR = {
  log: {
    entries: [
      {
        request: {
          url: "https://fantasy402.com/manager.html",
          headers: [
            { name: "Accept", value: "text/html" },
            { name: "Cookie", value: "session=abc; csrftoken=xyz" },
          ],
        },
        response: {
          headers: [
            {
              name: "Set-Cookie",
              value: "cf_clearance=live123; Path=/; Max-Age=3600; HttpOnly",
            },
            {
              name: "Set-Cookie",
              value: "expired_tok=gone; Path=/; Max-Age=0",
            },
          ],
        },
      },
      {
        request: {
          url: "https://fantasy402.com/cloud/api/Manager/getInfoPlayer",
          headers: [
            { name: "cookie", value: "session=abc; agent=118" },
            { name: "Authorization", value: "Bearer eyJ.test.token" },
          ],
        },
      },
      {
        request: {
          url: "https://example.com/elsewhere",
          headers: [{ name: "Cookie", value: "other=1" }],
        },
      },
    ],
  },
};

describe("cookie jar", () => {
  test("parses a Cookie header into a CookieMap", () => {
    const map = parseCookieHeader("a=1; b=2; bare");
    expect(map.get("a")).toBe("1");
    expect(map.get("b")).toBe("2");
    // CookieMap drops a token with no `=`, so a malformed jar loses that name rather than yielding "".
    expect(map.get("bare")).toBeNull();
    expect([...map].map(([name]) => name)).toEqual(["a", "b"]);
  });

  test("parses Set-Cookie with Bun.Cookie.parse and drops expired cookies", () => {
    expect(
      parseSetCookieHeader("session=xyz; Path=/; Max-Age=3600; HttpOnly"),
    ).toEqual({
      name: "session",
      value: "xyz",
    });
    expect(parseSetCookieHeader("session=xyz; Path=/; Max-Age=0")).toBeNull();
    expect(
      parseSetCookieHeader(
        "session=xyz; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
      ),
    ).toBeNull();
  });

  test("CookieMap.set and delete emit only their Set-Cookie mutations", () => {
    const map = new Bun.CookieMap("a=1; b=2");
    map.set("__Host-x", "t", {
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    expect([...map].map(([name]) => name)).toEqual(["__Host-x", "a", "b"]);
    expect(map.toSetCookieHeaders()).toEqual([
      "__Host-x=t; Path=/; Secure; HttpOnly; SameSite=Strict",
    ]);

    map.delete("a", { path: "/" });
    expect([...map].map(([name]) => name)).toEqual(["__Host-x", "b"]);
    expect(map.toSetCookieHeaders()).toEqual([
      "__Host-x=t; Path=/; Secure; HttpOnly; SameSite=Strict",
      "a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax",
    ]);
  });

  test("serializes without the CookieMap toString trap", () => {
    const header = cookieHeaderFrom([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(header).toBe("a=1; b=2");
    expect(String(parseCookieHeader("a=1"))).toBe("[object CookieMap]");
  });

  test("extracts and merges request Cookie and non-expired response Set-Cookie headers for one host", () => {
    const cookies = cookiesFromHar(HAR, "fantasy402.com");
    const names = cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual(["agent", "cf_clearance", "csrftoken", "session"]);
    // Later entries win, so the second request's session value replaces the first.
    expect(cookies.find((cookie) => cookie.name === "agent")?.value).toBe(
      "118",
    );
    expect(
      cookies.find((cookie) => cookie.name === "cf_clearance")?.value,
    ).toBe("live123");
    expect(cookies.some((cookie) => cookie.name === "expired_tok")).toBe(false);
    expect(cookies.some((cookie) => cookie.name === "other")).toBe(false);
  });

  test("extracts non-redacted Bearer token for the matching host", () => {
    expect(bearerFromHar(HAR, "fantasy402.com")).toBe("Bearer eyJ.test.token");
    expect(bearerFromHar(HAR, "example.com")).toBeNull();
    expect(
      bearerFromHar(
        {
          log: {
            entries: [
              {
                request: {
                  url: "https://fantasy402.com/cloud/api/Manager/Pending",
                  headers: [
                    { name: "Authorization", value: "Bearer <redacted>" },
                  ],
                },
              },
            ],
          },
        },
        "fantasy402.com",
      ),
    ).toBeNull();
  });

  test("rejects a HAR without log.entries and returns nothing for another host", () => {
    expect(() => cookiesFromHar({}, "fantasy402.com")).toThrow("log.entries");
    expect(() => cookiesFromHar(null, "fantasy402.com")).toThrow(
      "not an object",
    );
    expect(cookiesFromHar(HAR, "unknown.example")).toEqual([]);
  });
});
