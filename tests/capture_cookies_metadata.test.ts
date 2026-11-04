import { describe, expect, test } from "bun:test";

import {
  describeCookiesForHost,
  parseCdpCookies,
} from "../scripts/capture/cookies.ts";

const NOW = Date.parse("2026-11-02T16:00:00Z");
const SECRET = "s3cr3t-cookie-value";

const cookies = parseCdpCookies({
  cookies: [
    {
      name: "session",
      value: SECRET,
      domain: ".fantasy402.com",
      path: "/",
      httpOnly: true,
      secure: true,
      expires: -1,
      session: true,
    },
    {
      name: "agent",
      value: `${SECRET}-2`,
      domain: "www.fantasy402.com",
      path: "/",
      httpOnly: false,
      secure: true,
      expires: Date.parse("2026-11-01T00:00:00Z") / 1000,
    },
    {
      name: "cf_clearance",
      value: `${SECRET}-3`,
      domain: ".fantasy402.com",
      path: "/",
      httpOnly: true,
      secure: true,
      expires: Date.parse("2027-01-01T00:00:00Z") / 1000,
    },
    {
      name: "tracker",
      value: `${SECRET}-4`,
      domain: ".example.com",
      path: "/",
      httpOnly: false,
      secure: false,
      expires: -1,
    },
  ],
});

describe("describeCookiesForHost", () => {
  const described = describeCookiesForHost(cookies, "www.fantasy402.com", NOW);

  test("keeps only cookies scoped to the host, sorted by name", () => {
    expect(described.map((cookie) => cookie.name)).toEqual([
      "agent",
      "cf_clearance",
      "session",
    ]);
  });

  test("never carries a value, in any field or when serialized", () => {
    for (const cookie of described) expect("value" in cookie).toBe(false);
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(Bun.inspect(described)).not.toContain(SECRET);
  });

  test("CDP expires -1 is a session cookie, not 1969", () => {
    const session = described.find((cookie) => cookie.name === "session");
    expect(session?.expires).toBe("session");
    expect(session?.expired).toBe(false);
  });

  test("keeps expired cookies and marks them, so a stale profile is visible", () => {
    const agent = described.find((cookie) => cookie.name === "agent");
    expect(agent?.expires).toBe("2026-11-01T00:00:00.000Z");
    expect(agent?.expired).toBe(true);
    expect(
      described.find((cookie) => cookie.name === "cf_clearance")?.expired,
    ).toBe(false);
  });

  test("a port in the host does not hide the cookies", () => {
    expect(
      describeCookiesForHost(cookies, "www.fantasy402.com:443", NOW),
    ).toHaveLength(3);
  });
});
