import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  isPlainObject,
  sha256Hex,
  tryParseJson,
} from "../scripts/capture/json.ts";
import {
  assertNoPii,
  findPiiInValue,
  hasPii,
  PiiLeakError,
  redactError,
  redactHeaders,
  redactJson,
  redactString,
  redactUrlForLog,
  sanitizeReferer,
  scanPii,
} from "../scripts/capture/redact.ts";
import {
  inferFormSkeleton,
  inferSkeleton,
  inferSkeletonFromBytes,
} from "../scripts/capture/schema.ts";

const SECRET_TOKEN = "Bearer fixture-not-a-real-token";

/**
 * Build a credential-bearing URL at runtime so the repository credential
 * scanner never sees a committed `scheme://user:pass@` literal.
 */
function credentialUrl(
  scheme: string,
  credentials: string,
  rest: string,
): string {
  return `${scheme}://${credentials}@${rest}`;
}

const SESSION_COOKIE = "session=fixture-cookie-not-real";

describe("redactHeaders", () => {
  test("deny-listed header values become <redacted>, names survive", () => {
    const result = redactHeaders({
      Authorization: SECRET_TOKEN,
      Cookie: SESSION_COOKIE,
      "Set-Cookie": "session=abc; HttpOnly",
      "X-Csrf-Token": "csrf-value",
      Password: "hunter2",
      "X-Api-Key": "key-123456",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Custom-Header": "value-that-is-not-trusted",
    });
    expect(result.clean["authorization"]).toBe("<redacted>");
    expect(result.clean["cookie"]).toBe("<redacted>");
    expect(result.clean["set-cookie"]).toBe("<redacted>");
    expect(result.clean["x-csrf-token"]).toBe("<redacted>");
    expect(result.clean["password"]).toBe("<redacted>");
    expect(result.clean["x-api-key"]).toBe("<redacted>");
    expect(result.clean["accept"]).toBe("application/json");
    expect(result.clean["x-requested-with"]).toBe("XMLHttpRequest");
    // Unknown headers are not trusted with a value either.
    expect(result.clean["x-custom-header"]).toBe("<redacted>");
    expect(result.fieldsRedacted).toContain("authorization");
    expect(result.fieldsRedacted).toContain("cookie");
    expect(result.fieldsRedacted).toContain("x-custom-header");
  });

  test("no secret value survives header redaction", () => {
    const result = redactHeaders({
      authorization: SECRET_TOKEN,
      cookie: SESSION_COOKIE,
    });
    const serialized = JSON.stringify(result.clean);
    expect(serialized).not.toContain("fixture-not-a-real-token");
    expect(serialized).not.toContain("fixture-cookie-not-real");
  });

  test("referer keeps origin+path but strips query and userinfo", () => {
    expect(
      sanitizeReferer("https://portal.example/path?customerID=4821&token=abc"),
    ).toBe("https://portal.example/path");
    expect(
      sanitizeReferer(
        credentialUrl("https", "user:pass", "portal.example/path#frag"),
      ),
    ).toBe("https://<redacted>@portal.example/path");
    expect(sanitizeReferer("not a url")).toBe("<redacted>");
  });
});

describe("redactJson", () => {
  const body = {
    INFO: true,
    Player: {
      customerID: 4821,
      login: "BGD101",
      Login: "BGD101",
      agentID: "AGENT-X",
      ip: "203.0.113.9",
      ipAddress: "203.0.113.9",
      email: "bettor@example.com",
      password: "hunter2",
      token: "jwt-value",
      address: "1 Example Street",
      phone: "555-123-4567",
      Status: "Active",
      ConfirmationDelay: 0,
    },
    rows: [{ customerID: "7730", ShortDesc: "NFL" }],
  };

  test("sensitive keys are replaced with stable placeholders", () => {
    const result = redactJson(body);
    expect(isPlainObject(result.clean)).toBe(true);
    const player = isPlainObject(result.clean) ? result.clean["Player"] : null;
    expect(isPlainObject(player)).toBe(true);
    if (!isPlainObject(player)) throw new Error("expected Player object");
    expect(player["customerID"]).toBe("<redacted:customer-id>");
    expect(player["login"]).toBe("<redacted:login>");
    expect(player["Login"]).toBe("<redacted:login>");
    expect(player["agentID"]).toBe("<redacted:agent-id>");
    expect(player["ip"]).toBe("<redacted:ip>");
    expect(player["ipAddress"]).toBe("<redacted:ip>");
    expect(player["email"]).toBe("<redacted:email>");
    expect(player["password"]).toBe("<redacted:password>");
    expect(player["token"]).toBe("<redacted:token>");
    expect(player["address"]).toBe("<redacted:address>");
    expect(player["phone"]).toBe("<redacted:phone>");
    // Non-sensitive values survive.
    expect(player["Status"]).toBe("Active");
    expect(player["ConfirmationDelay"]).toBe(0);
    expect(result.fieldsRedacted).toContain("body.Player.customerID");
    expect(result.fieldsRedacted).toContain("body.rows[0].customerID");
    expect(result.piiRedacted).toContain("customer-id");
    expect(result.piiRedacted).toContain("agent-id");
  });

  test("redacts getInfoPlayer INFO.data and INFO.added sensitive keys (Passwordt, SMSPhoneNumber, HomePhone, BusinessPhone, Fax, NameMI, AgentLogin, TelegramID)", () => {
    const infoPlayerSample = {
      INFO: {
        data: {
          Login: "BILLY666  ",
          Password: " ",
          Passwordt: "temp-secret",
          NameFirst: "          ",
          NameMI: "M",
          AgentLogin: "MASTER1",
          SMSPhoneNumber: "555-000-1111",
          HomePhone: "555-000-2222",
          BusinessPhone: "555-000-3333",
          Fax: "555-000-4444",
          ParlayName: "8 Team Max               ",
        },
        added: {
          CustomerID: "BILLY666  ",
          TelegramID: "@billy_desk",
          RebatePercent: 0,
        },
      },
    };
    const result = redactJson(infoPlayerSample);
    const info = (result.clean as Record<string, Record<string, unknown>>)[
      "INFO"
    ]!;
    const data = info["data"] as Record<string, unknown>;
    const added = info["added"] as Record<string, unknown>;
    expect(data["Password"]).toBe("<redacted:password>");
    expect(data["Passwordt"]).toBe("<redacted:password>");
    expect(data["NameMI"]).toBe("<redacted:login>");
    expect(data["AgentLogin"]).toBe("<redacted:agent-id>");
    expect(data["SMSPhoneNumber"]).toBe("<redacted:phone>");
    expect(data["HomePhone"]).toBe("<redacted:phone>");
    expect(data["BusinessPhone"]).toBe("<redacted:phone>");
    expect(data["Fax"]).toBe("<redacted:phone>");
    expect(data["ParlayName"]).toBe("8 Team Max               ");
    expect(added["TelegramID"]).toBe("<redacted:customer-id>");
    expect(added["RebatePercent"]).toBe(0);
  });

  test("redaction is deterministic", () => {
    expect(JSON.stringify(redactJson(body))).toBe(
      JSON.stringify(redactJson(body)),
    );
  });

  test("PII embedded in ordinary string values is redacted in place", () => {
    const result = redactJson({
      note: "contact bettor@example.com from 203.0.113.9",
      safe: "NFL",
    });
    expect(isPlainObject(result.clean)).toBe(true);
    if (!isPlainObject(result.clean)) throw new Error("expected object");
    expect(String(result.clean["note"])).toContain("<redacted:email>");
    expect(String(result.clean["note"])).toContain("<redacted:ip>");
    expect(result.clean["safe"]).toBe("NFL");
  });
});

describe("PII scanning", () => {
  test("detects emails, public IPs, phones, JWTs and bearer tokens", () => {
    const kinds = scanPii(
      "a@example.com 203.0.113.9 555-123-4567 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U Bearer abcdefghijkl",
    ).map((finding) => finding.kind);
    expect(kinds).toContain("email");
    expect(kinds).toContain("ip");
    expect(kinds).toContain("phone");
    expect(kinds).toContain("jwt");
    expect(kinds).toContain("bearer");
  });

  test("private and loopback IPv4 addresses are not PII", () => {
    expect(scanPii("127.0.0.1 10.1.2.3 192.168.0.10 172.16.4.5")).toEqual([]);
  });

  test("findPiiInValue walks nested JSON strings", () => {
    const findings = findPiiInValue({
      rows: [{ where: "203.0.113.9" }, { safe: "NFL" }],
    });
    expect(findings.some((finding) => finding.kind === "ip")).toBe(true);
    expect(hasPii({ safe: "NFL" })).toBe(false);
  });

  test("assertNoPii throws a typed leak error and passes clean data", () => {
    expect(() =>
      assertNoPii({ email: "bettor@example.com" }, "record"),
    ).toThrow(PiiLeakError);
    expect(() =>
      assertNoPii({ sha: sha256Hex("x"), type: "string" }, "record"),
    ).not.toThrow();
  });
});

describe("schema skeletons carry no values", () => {
  const response = [
    {
      customerID: "4821",
      ipAddress: "203.0.113.9",
      timestamp: "2026-10-28T12:04:11Z",
      agentOwner: "AGENT-X",
    },
    {
      customerID: "7730",
      ipAddress: "198.51.100.7",
      timestamp: "2026-10-28T12:05:02Z",
      agentOwner: "AGENT-X",
    },
  ];

  test("skeleton contains field names and types, never PII values", () => {
    const skeleton = inferSkeleton(response);
    const serialized = JSON.stringify(skeleton);
    expect(serialized).toContain("customerID");
    expect(serialized).toContain("ipAddress");
    expect(serialized).not.toContain("4821");
    expect(serialized).not.toContain("7730");
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("198.51.100.7");
    expect(serialized).not.toContain("AGENT-X");
    expect(serialized).not.toContain("2026-10-28");
    expect(skeleton.type).toBe("array");
  });

  test("enum candidates are limited to approved, token-like keys", () => {
    const skeleton = inferSkeleton([
      { type: "B", Status: "Active", login: "BGD101", wagerNumber: 900001 },
      { type: "A", Status: "Inactive", login: "BGD102", wagerNumber: 900002 },
    ]);
    const serialized = JSON.stringify(skeleton);
    expect(serialized).toContain('"enumCandidates":["A","B"]');
    expect(serialized).toContain("Active");
    // A sensitive key and an unapproved numeric key publish no candidates.
    expect(serialized).not.toContain("BGD101");
    expect(serialized).not.toContain("900001");
  });

  test("form bodies become string-valued objects without values", () => {
    const skeleton = inferFormSkeleton(
      "agentID=AGENT-X&type=B&customerID=4821",
    );
    expect(skeleton.type).toBe("object");
    const serialized = JSON.stringify(skeleton);
    expect(serialized).toContain("agentID");
    expect(serialized).not.toContain("AGENT-X");
    expect(serialized).not.toContain("4821");
    const fromBytes = inferSkeletonFromBytes(
      new TextEncoder().encode("a=1&b=2"),
      "application/x-www-form-urlencoded; charset=UTF-8",
    );
    expect(fromBytes.type).toBe("object");
  });
});

const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("credential names with a prefix or suffix", () => {
  test.each([
    ["F402_PASSWORD=fixture-pass-value", "F402_PASSWORD=<redacted>"],
    ["sessionid=fixture-session-value", "sessionid=<redacted>"],
    ["ASP.NET_SessionId=fixture-session-value", "ASP.NET_SessionId=<redacted>"],
    ["auth_token=fixture-auth-value", "auth_token=<redacted>"],
    ["authToken=fixture-auth-value; x=1", "authToken=<redacted>; x=1"],
    ['{"F402_PASSWORD":"fixture-pass"}', '{"F402_PASSWORD":"<redacted>"}'],
  ])("%s", (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  test("a short password or secret has no length floor", () => {
    expect(redactString("password=abc12")).toBe("password=<redacted>");
    expect(redactString("client_secret=x")).toBe("client_secret=<redacted>");
  });

  test("words that merely contain a credential name are left alone", () => {
    for (const text of [
      "consider=abcdef123456",
      "residual=abcdef123456",
      "assessment=abcdefghij",
      "passwordless=enabled",
      "width=1440 timeout=30000",
    ]) {
      expect(redactString(text)).toBe(text);
    }
  });
});

describe("bare credential pairs", () => {
  test("sensitive name=value pairs keep the name and lose the value", () => {
    expect(redactString("session=fixture-session-value")).toBe(
      "session=<redacted>",
    );
    expect(redactString("csrftoken=fixture-csrf-value")).toBe(
      "csrftoken=<redacted>",
    );
    expect(
      redactString(
        "PHPSESSID=fixture-php-value; connect.sid=fixture-sid-value; __cf_bm=fixture-cf-value",
      ),
    ).toBe("PHPSESSID=<redacted>; connect.sid=<redacted>; __cf_bm=<redacted>");
    expect(redactString("session = fixture-session-value")).toBe(
      "session = <redacted>",
    );
  });

  test("benign name=value pairs are untouched", () => {
    expect(redactString("width=1440 timeout=30000")).toBe(
      "width=1440 timeout=30000",
    );
    expect(redactString("height=1080, retries=3; charset=utf-8")).toBe(
      "height=1080, retries=3; charset=utf-8",
    );
    // A separator-delimited prefix is still a credential (`F402_PASSWORD`), so
    // `my_session` is redacted; only an unseparated word like `consider` is not.
    expect(redactString("my_session=fixture-session-value")).toBe(
      "my_session=<redacted>",
    );
  });

  test("an already-redacted value is unchanged and never nests", () => {
    expect(redactString("session=<redacted>")).toBe("session=<redacted>");
    const once = redactString("session=fixture-session-value");
    expect(redactString(once)).toBe(once);
    expect(redactString("session=<redacted:<redacted>>")).toBe(
      "session=<redacted>",
    );
  });

  test("the pattern passes still fire, including inside a pair", () => {
    const redacted = redactString(
      `${JWT_FIXTURE} Bearer abcdefghijkl bettor@example.com 203.0.113.9 token=${JWT_FIXTURE}`,
    );
    expect(redacted).toContain("<redacted:jwt>");
    expect(redacted).toContain("<redacted:bearer>");
    expect(redacted).toContain("<redacted:email>");
    expect(redacted).toContain("<redacted:ip>");
    expect(redacted).toContain("token=<redacted>");
    expect(redacted).not.toContain(JWT_FIXTURE);
  });

  test("a sensitive name in a `;`-group redacts every value in the group", () => {
    expect(redactString("session=SECRET-SESSION; scoped=SECRET-SCOPED")).toBe(
      "session=<redacted>; scoped=<redacted>",
    );
    expect(redactString("foo=123456; session=abcdef")).toBe(
      "foo=<redacted>; session=<redacted>",
    );
    expect(redactString("session=<redacted>; scoped=<redacted>")).toBe(
      "session=<redacted>; scoped=<redacted>",
    );
  });

  test("a group with no sensitive name is untouched", () => {
    expect(redactString("width=1440; height=1080")).toBe(
      "width=1440; height=1080",
    );
    expect(redactString("foo=123456; bar=abcdef")).toBe(
      "foo=123456; bar=abcdef",
    );
    // Values under the six-character floor survive even in a redacted group.
    expect(redactString("session=abcdef; x=12")).toBe(
      "session=<redacted>; x=12",
    );
  });

  test("a labeled cookie header still loses the whole value", () => {
    expect(redactString("cookie: session=fixture-session-value")).toBe(
      "cookie: session=<redacted>",
    );
    expect(redactError("cookie: session=fixture-session-value")).toBe(
      "cookie: <redacted>",
    );
    expect(
      redactError(
        "cookie: session=fixture-session-value; foo=fixture-foo-value",
      ),
    ).toBe("cookie: <redacted>");
  });

  test("quoted pair values are redacted and keep their quotes", () => {
    expect(redactString(`session="abcdefghij"`)).toBe(`session="<redacted>"`);
    expect(redactString(`session='abcdefghij'`)).toBe(`session='<redacted>'`);
    expect(redactString(`session = "abcdefghij"`)).toBe(
      `session = "<redacted>"`,
    );
    // Short values are credentials once quotes delimit them.
    expect(redactString(`cookie="abc"`)).toBe(`cookie="<redacted>"`);
    // Already-redacted quoted values stay put and never nest.
    expect(redactString(`session="<redacted>"`)).toBe(`session="<redacted>"`);
  });

  test("JSON key/value pairs are redacted in place", () => {
    expect(redactString(`{"session":"abcdef123456"}`)).toBe(
      `{"session":"<redacted>"}`,
    );
    expect(redactString(`{"Session": "abcdef123456", "safe": "NFL"}`)).toBe(
      `{"Session": "<redacted>", "safe": "NFL"}`,
    );
    expect(redactString(`{"csrf-token":"abcdef123456"}`)).toBe(
      `{"csrf-token":"<redacted>"}`,
    );
    // An escaped quote or newline inside the value cannot break out of it.
    expect(redactString(String.raw`{"session":"abc\"defghij","ok":true}`)).toBe(
      `{"session":"<redacted>","ok":true}`,
    );
    expect(redactString(String.raw`{"session":"abc\ndefghij"}`)).toBe(
      `{"session":"<redacted>"}`,
    );
    // Double application is stable.
    const once = redactString(`{"session":"abcdef123456"}`);
    expect(redactString(once)).toBe(once);
    expect(redactError(`{"session":"abcdef123456"}`)).toBe(
      `{"session":"<redacted>"}`,
    );
  });

  test("labeled headers use the shared name list and consume the line", () => {
    expect(redactError("x-auth-token: abcdefgh")).toBe(
      "x-auth-token: <redacted>",
    );
    expect(redactError("x-csrf-token: abcdefgh")).toBe(
      "x-csrf-token: <redacted>",
    );
    expect(redactError("token: abcdefgh")).toBe("token: <redacted>");
    expect(redactError("session: abcdefgh")).toBe("session: <redacted>");
    expect(redactError("Cookie: a=1; b=2")).toBe("Cookie: <redacted>");
    expect(redactError("set-cookie: sid=abc; Path=/")).toBe(
      "set-cookie: <redacted>",
    );
  });

  test("double application is stable for every repro shape", () => {
    const inputs = [
      `session="abcdefghij"`,
      `cookie="abc"`,
      `{"session":"abcdef123456"}`,
      `x-auth-token: abcdefgh`,
      `Cookie: a=1; b=2`,
    ];
    for (const input of inputs) {
      const once = redactString(input);
      expect(redactString(once)).toBe(once);
      const errorOnce = redactError(input);
      expect(redactError(errorOnce)).toBe(errorOnce);
      expect(once).not.toContain("abcdefghij");
      expect(once).not.toContain("abcdef123456");
      expect(errorOnce).not.toContain("abcdefgh");
      expect(errorOnce).not.toContain("abcdef123456");
    }
  });

  test("benign quoted settings and groups stay untouched", () => {
    expect(redactString(`width="1440"`)).toBe(`width="1440"`);
    expect(redactString(`height=1080, retries=3; charset=utf-8`)).toBe(
      "height=1080, retries=3; charset=utf-8",
    );
    expect(redactError("height=1080, retries=3; charset=utf-8")).toBe(
      "height=1080, retries=3; charset=utf-8",
    );
  });

  test("redactError redacts a bare cookie thrown from page code", () => {
    const leaked = redactError(
      new Error("session=SECRET-SESSION; scoped=SECRET-SCOPED"),
    );
    expect(leaked).toBe("Error: session=<redacted>; scoped=<redacted>");
    expect(leaked).not.toContain("SECRET-SESSION");
    expect(leaked).not.toContain("SECRET-SCOPED");
  });
});

describe("hashing + error redaction", () => {
  test("canonical JSON is key-order independent and stable", () => {
    const left = canonicalJson({ b: [3, 2, 1], a: { d: true, c: null } });
    const right = canonicalJson({ a: { c: null, d: true }, b: [3, 2, 1] });
    expect(left).toBe(right);
    expect(sha256Hex(left)).toBe(sha256Hex(right));
    expect(sha256Hex("same")).toBe(sha256Hex("same"));
    expect(sha256Hex("same")).not.toBe(sha256Hex("different"));
  });

  test("redactError removes credentials, query values and tokens", () => {
    const leaked = redactError(
      new Error(
        `fetch failed for ${credentialUrl("https", "user:hunter2", "portal.example/api?token=SECRET123")} and Bearer abcdefghijkl`,
      ),
      ["hunter2"],
    );
    expect(leaked).not.toContain("hunter2");
    expect(leaked).not.toContain("SECRET123");
    expect(leaked).not.toContain("abcdefghijkl");
    expect(leaked).toContain("portal.example");
  });

  test("redactError strips cookie/authorization header-shaped text", () => {
    const leaked = redactError(
      "request headers: authorization: Bearer abcdefgh; cookie: session=SECRET",
    );
    expect(leaked).not.toContain("abcdefgh");
    expect(leaked).not.toContain("SECRET");
  });

  test("redactUrlForLog drops userinfo/query and masks numeric path ids", () => {
    expect(
      redactUrlForLog(
        credentialUrl(
          "https",
          "user:pass",
          "portal.example/customer/4821?token=abc",
        ),
      ),
    ).toBe("https://<redacted>@portal.example/customer/:id");
  });

  test("redactUrlForLog keeps the shape of a URL with no host", () => {
    expect(redactUrlForLog("about:blank")).toBe("about:blank");
    expect(redactUrlForLog("data:text/html,<h1>secret</h1>")).toBe(
      "data:text/html,…",
    );
    expect(redactUrlForLog("https://portal.example/a?token=abc")).toBe(
      "https://portal.example/a",
    );
  });

  test("redactString is idempotent for already-redacted text", () => {
    const once = redactString("mail bettor@example.com");
    expect(redactString(once)).toBe(once);
    expect(once).not.toContain("bettor@example.com");
  });

  test("tryParseJson returns undefined for non-JSON", () => {
    expect(tryParseJson("{not json")).toBeUndefined();
    expect(tryParseJson('{"ok":true}')).toEqual({ ok: true });
  });
});
