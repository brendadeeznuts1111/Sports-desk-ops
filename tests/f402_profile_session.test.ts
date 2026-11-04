import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CdpCookie } from "../scripts/capture/cookies.ts";
import { hasCdp, hasChromeProfile } from "./support/capabilities.ts";
import {
  acquireProfileLock,
  ProfileInUseError,
  profileLockPath,
} from "../lib/f402_profile_lock.ts";
import {
  LOGIN_FORM_PROBE_EXPRESSION,
  ProfileSessionError,
  sessionFromWebViewProfile,
  type ProfileSessionView,
} from "../lib/f402_profile_session.ts";

const BASE_URL = "https://www.fantasy402.com";
const HOST = "www.fantasy402.com";

const root = mkdtempSync(join(tmpdir(), "f402-profile-session-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function profileDir(): string {
  const dir = mkdtempSync(join(root, "profile-"));
  return dir;
}

function cookie(
  overrides: Partial<CdpCookie> & { name: string; value: string },
): CdpCookie {
  return {
    domain: HOST,
    path: "/",
    httpOnly: true,
    secure: true,
    ...overrides,
  };
}

interface FakeViewOptions {
  readonly cookies?: readonly CdpCookie[];
  /** What the post-navigation password-field probe returns (default false). */
  readonly loginForm?: boolean;
  readonly navigateError?: Error;
  readonly evaluateError?: Error;
  readonly cookiesError?: Error;
}

/** Records navigation, the sign-in probe, cookie reads and close; never touches a browser. */
function fakeView(options: FakeViewOptions = {}): {
  view: ProfileSessionView;
  calls: string[];
} {
  const calls: string[] = [];
  const view: ProfileSessionView = {
    async navigate(url) {
      calls.push(`navigate:${url}`);
      if (options.navigateError !== undefined) throw options.navigateError;
    },
    async evaluate(expression) {
      calls.push(
        expression === LOGIN_FORM_PROBE_EXPRESSION
          ? "evaluate:password-field"
          : "evaluate:other",
      );
      if (options.evaluateError !== undefined) throw options.evaluateError;
      return options.loginForm ?? false;
    },
    async getAllCookies() {
      calls.push("getAllCookies");
      if (options.cookiesError !== undefined) throw options.cookiesError;
      return [...(options.cookies ?? [])];
    },
    async close() {
      calls.push("close");
    },
  };
  return { view, calls };
}

const SESSION_COOKIES: readonly CdpCookie[] = [
  cookie({
    name: "csrftoken",
    value: "v-csrf",
    path: "/cloud",
  }),
  cookie({ name: "session", value: "v-session" }),
  cookie({ name: "foreign", value: "v-foreign", domain: "other.example" }),
  cookie({ name: "stale", value: "v-stale", expires: 1_000_000 }),
];

describe.skipIf(!hasCdp)("sessionFromWebViewProfile", () => {
  test("builds a session from the scoped profile cookies only", async () => {
    const dir = profileDir();
    const { view, calls } = fakeView({ cookies: SESSION_COOKIES });

    const session = await sessionFromWebViewProfile({
      profileDir: dir,
      baseUrl: BASE_URL,
      viewFactory: async () => view,
    });

    expect(calls).toEqual([
      `navigate:${BASE_URL}/`,
      "evaluate:password-field",
      "getAllCookies",
      "close",
    ]);
    // Most specific path first (csrftoken is scoped to /cloud).
    expect(session.cookieHeader).toBe("csrftoken=v-csrf; session=v-session");
    expect(session.cookieNames).toEqual(["csrftoken", "session"]);
    expect(session.cookieHeader).not.toContain("v-foreign");
    expect(session.cookieHeader).not.toContain("v-stale");
  });

  test("honours ttlMinutes and now", async () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const { view } = fakeView({ cookies: SESSION_COOKIES });

    const session = await sessionFromWebViewProfile({
      profileDir: profileDir(),
      baseUrl: BASE_URL,
      ttlMinutes: 15,
      now,
      viewFactory: async () => view,
    });

    expect(session.obtainedAtIso).toBe("2026-11-02T12:00:00.000Z");
    expect(session.expiresAtIso).toBe("2026-11-02T12:15:00.000Z");
  });

  test("defaults the ttl to 30 minutes and carries no bearer token", async () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    const { view } = fakeView({ cookies: SESSION_COOKIES });

    const session = await sessionFromWebViewProfile({
      profileDir: profileDir(),
      baseUrl: BASE_URL,
      now,
      viewFactory: async () => view,
    });

    expect(session.expiresAtIso).toBe("2026-11-02T12:30:00.000Z");
    expect(session.authorizationHeader).toBeUndefined();
  });

  test("rejects an empty profileDir without launching a view", async () => {
    let launched = false;
    await expect(
      sessionFromWebViewProfile({
        profileDir: "   ",
        baseUrl: BASE_URL,
        viewFactory: async () => {
          launched = true;
          return fakeView().view;
        },
      }),
    ).rejects.toThrow(/--from-profile <dir>/);
    expect(launched).toBe(false);
  });

  test("rejects a profile path that does not exist", async () => {
    const missing = join(root, "no-such-profile");
    await expect(
      sessionFromWebViewProfile({
        profileDir: missing,
        baseUrl: BASE_URL,
        viewFactory: async () => fakeView().view,
      }),
    ).rejects.toThrow(ProfileSessionError);
    await expect(
      sessionFromWebViewProfile({
        profileDir: missing,
        baseUrl: BASE_URL,
        viewFactory: async () => fakeView().view,
      }),
    ).rejects.toThrow(missing);
  });

  test("rejects a profile path that is a file, not a directory", async () => {
    const file = join(root, "profile.json");
    writeFileSync(file, "{}\n");
    await expect(
      sessionFromWebViewProfile({
        profileDir: file,
        baseUrl: BASE_URL,
        viewFactory: async () => fakeView().view,
      }),
    ).rejects.toThrow(/is not a directory/);
  });

  test("rejects a profile with no scoped cookies, naming the profile", async () => {
    const dir = profileDir();
    const { view, calls } = fakeView({
      cookies: [
        cookie({ name: "foreign", value: "v", domain: "other.example" }),
      ],
    });

    await expect(
      sessionFromWebViewProfile({
        profileDir: dir,
        baseUrl: BASE_URL,
        viewFactory: async () => view,
      }),
    ).rejects.toThrow(/has no scoped session cookies/);
    expect(calls).toContain("close");
  });

  test("rejects an empty cookie jar", async () => {
    const { view } = fakeView({ cookies: [] });
    await expect(
      sessionFromWebViewProfile({
        profileDir: profileDir(),
        baseUrl: BASE_URL,
        viewFactory: async () => view,
      }),
    ).rejects.toThrow(/no scoped session cookies for www\.fantasy402\.com/);
  });

  test("rejects a signed-out profile that still shows a password field", async () => {
    const dir = profileDir();
    const { view, calls } = fakeView({
      cookies: SESSION_COOKIES,
      loginForm: true,
    });

    const error = await sessionFromWebViewProfile({
      profileDir: dir,
      baseUrl: BASE_URL,
      viewFactory: async () => view,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProfileSessionError);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("still presents a login form");
    expect(message).toContain(dir);
    expect(message).toContain(HOST);
    // The jar is never read, so no cookie value can reach the message.
    expect(message).not.toContain("v-session");
    expect(calls).toEqual([
      `navigate:${BASE_URL}/`,
      "evaluate:password-field",
      "close",
    ]);
  });

  test("closes the view when the sign-in probe throws", async () => {
    const { view, calls } = fakeView({
      cookies: SESSION_COOKIES,
      evaluateError: new Error("probe failed"),
    });

    await expect(
      sessionFromWebViewProfile({
        profileDir: profileDir(),
        baseUrl: BASE_URL,
        viewFactory: async () => view,
      }),
    ).rejects.toThrow("probe failed");
    expect(calls).toEqual([
      `navigate:${BASE_URL}/`,
      "evaluate:password-field",
      "close",
    ]);
  });

  test("closes the view when navigation throws", async () => {
    const { view, calls } = fakeView({
      cookies: SESSION_COOKIES,
      navigateError: new Error("boom"),
    });

    await expect(
      sessionFromWebViewProfile({
        profileDir: profileDir(),
        baseUrl: BASE_URL,
        viewFactory: async () => view,
      }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual([`navigate:${BASE_URL}/`, "close"]);
  });

  test("closes the view when the cookie read throws", async () => {
    const { view, calls } = fakeView({
      cookiesError: new Error("cdp failed"),
    });

    await expect(
      sessionFromWebViewProfile({
        profileDir: profileDir(),
        baseUrl: BASE_URL,
        viewFactory: async () => view,
      }),
    ).rejects.toThrow("cdp failed");
    expect(calls).toEqual([
      `navigate:${BASE_URL}/`,
      "evaluate:password-field",
      "getAllCookies",
      "close",
    ]);
  });

  test("rejects a non-http(s) baseUrl", async () => {
    await expect(
      sessionFromWebViewProfile({
        profileDir: profileDir(),
        baseUrl: "file:///tmp/portal",
        viewFactory: async () => fakeView().view,
      }),
    ).rejects.toThrow(/must be http\(s\)/);
  });

  test("refuses a profile another run holds", async () => {
    const dir = profileDir();
    const lock = acquireProfileLock(dir);
    try {
      const error = await sessionFromWebViewProfile({
        profileDir: dir,
        baseUrl: BASE_URL,
        viewFactory: async () => {
          throw new Error("must not launch while the profile is locked");
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProfileInUseError);
    } finally {
      lock.release();
    }
  });

  test("releases the profile lock when the view factory throws", async () => {
    const dir = profileDir();
    const factoryError = new Error("chrome failed to start");

    const error = await sessionFromWebViewProfile({
      profileDir: dir,
      baseUrl: BASE_URL,
      viewFactory: async () => {
        throw factoryError;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(factoryError);
    // `using _lock` disposes even though no view existed to close.
    expect(existsSync(profileLockPath(dir))).toBe(false);
    const again = acquireProfileLock(dir);
    again.release();
  });
});

function runSessionLogin(...args: string[]) {
  const script = join(import.meta.dir, "../scripts/session_login.ts");
  return Bun.spawnSync({
    cmd: ["bun", "run", script, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env["PATH"] ?? "",
      HOME: Bun.env["HOME"] ?? "",
    },
  });
}

describe.skipIf(!hasChromeProfile || Bun.env.DSH_SESSION_ID !== undefined)(
  "session:login --from-profile",
  () => {
    test("skips the credential login gate and names the missing profile", () => {
      const missing = join(root, "cli-absent-profile");
      const proc = runSessionLogin("--from-profile", missing);

      expect(proc.exitCode).toBe(1);
      const stderr = proc.stderr.toString();
      expect(stderr).toContain(missing);
      expect(stderr).not.toContain("F402_LIVE_LOGIN=1 to allow");
    });
  },
);

describe("session:login --ttl-min", () => {
  test("rejects a non-numeric ttl on the profile path with exit 2", () => {
    const proc = runSessionLogin(
      "--from-profile",
      join(root, "ttl-bad-profile"),
      "--ttl-min",
      "soon",
    );

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain(
      "--ttl-min must be a positive number of minutes",
    );
    expect(proc.stdout.toString()).toBe("");
  });

  test("rejects a non-positive ttl on the credential path with exit 2", () => {
    const proc = runSessionLogin("--ttl-min", "0");

    expect(proc.exitCode).toBe(2);
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("--ttl-min must be a positive number of minutes");
    expect(stderr).not.toContain("F402_LIVE_LOGIN=1 to allow");
  });

  test("rejects an empty ttl value with exit 2", () => {
    const proc = runSessionLogin(
      "--from-profile",
      join(root, "ttl-empty-profile"),
      "--ttl-min",
      "",
    );

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("--ttl-min must be");
  });

  test("accepts a positive ttl and proceeds to the profile check", () => {
    const missing = join(root, "ttl-valid-absent-profile");
    const proc = runSessionLogin("--from-profile", missing, "--ttl-min", "15");

    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr.toString();
    expect(stderr).toContain(missing);
    expect(stderr).not.toContain("--ttl-min must be");
  });
});
