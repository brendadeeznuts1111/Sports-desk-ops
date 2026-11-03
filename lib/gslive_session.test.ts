import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GSLIVE_MANAGER_URL,
  GsliveSessionError,
  sessionFromGsliveProfile,
  sessionFromRunningChrome,
} from "./gslive_session.ts";
import type { CdpCookie } from "../scripts/capture/cookies.ts";
import type { ProfileSessionView } from "./f402_profile_session.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function profileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gslive-profile-"));
  dirs.push(dir);
  return dir;
}

function cookie(overrides: Partial<CdpCookie> = {}): CdpCookie {
  return {
    name: "GSID",
    value: "fixture-gsid",
    domain: "plive.sportswidgets.pro",
    path: "/",
    httpOnly: false,
    secure: true,
    ...overrides,
  };
}

interface FakeView extends ProfileSessionView {
  readonly navigated: string[];
  closed: boolean;
  loginForm: boolean;
  cookies: CdpCookie[];
}

function fakeView(options: {
  loginForm?: boolean;
  cookies?: CdpCookie[];
}): FakeView {
  const view: FakeView = {
    navigated: [],
    closed: false,
    loginForm: options.loginForm ?? false,
    cookies: options.cookies ?? [],
    async navigate(url) {
      view.navigated.push(url);
    },
    async evaluate() {
      return view.loginForm;
    },
    async getAllCookies() {
      return view.cookies;
    },
    async close() {
      view.closed = true;
    },
  };
  return view;
}

describe("GSLive WebView profile session", () => {
  test("reads host cookies, requires GSID, and never leaks values in provenance", async () => {
    const dir = await profileDir();
    const view = fakeView({
      cookies: [
        cookie(),
        cookie({ name: "_ga", value: "GA1.1.1" }),
        cookie({ name: "other", value: "x", domain: "example.com" }),
      ],
    });
    const session = await sessionFromGsliveProfile({
      profileDir: dir,
      viewFactory: async () => view,
    });

    expect(session.source).toBe("webview-profile");
    expect(session.host).toBe("plive.sportswidgets.pro");
    expect(view.navigated).toEqual([GSLIVE_MANAGER_URL]);
    expect(session.cookieHeader).toContain("GSID=fixture-gsid");
    expect(session.cookieHeader).not.toContain("other=");
    expect(session.cookieNames).toContain("GSID");
    expect(session.redactedHeader).not.toContain("fixture-gsid");
    expect(view.closed).toBe(true);
  });

  test("a profile still showing a login form fails closed", async () => {
    const dir = await profileDir();
    const view = fakeView({ loginForm: true, cookies: [cookie()] });
    const error = await sessionFromGsliveProfile({
      profileDir: dir,
      viewFactory: async () => view,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GsliveSessionError);
    expect(String(error)).toContain("login form");
    expect(view.closed).toBe(true);
  });

  test("no scoped cookies and no GSID cookie are distinct failures", async () => {
    const dir = await profileDir();
    const noCookies = fakeView({ cookies: [] });
    await expect(
      sessionFromGsliveProfile({
        profileDir: dir,
        viewFactory: async () => noCookies,
      }),
    ).rejects.toThrow(/no session cookies/);

    const noGsid = fakeView({
      cookies: [cookie({ name: "session", value: "abc" })],
    });
    await expect(
      sessionFromGsliveProfile({
        profileDir: dir,
        viewFactory: async () => noGsid,
      }),
    ).rejects.toThrow(/no GSID/);
  });

  test("a missing profile directory is refused before launching a browser", async () => {
    let launched = false;
    await expect(
      sessionFromGsliveProfile({
        profileDir: join(tmpdir(), "definitely-not-a-profile-dir"),
        viewFactory: async () => {
          launched = true;
          return fakeView({});
        },
      }),
    ).rejects.toThrow(/does not exist/);
    expect(launched).toBe(false);
  });
});

describe("GSLive running Chrome attach", () => {
  test("reads the live tab's GSID without a profile directory", async () => {
    const view = fakeView({
      cookies: [cookie({ value: "live-gsid" }), cookie({ name: "_ga" })],
    });
    const session = await sessionFromRunningChrome({
      viewFactory: async () => view,
    });
    expect(session.source).toBe("running-chrome");
    expect(session.cookieNames).toContain("GSID");
    expect(session.cookieHeader).toContain("GSID=");
    expect(view.navigated).toEqual([GSLIVE_MANAGER_URL]);
    expect(view.closed).toBe(true);
  });

  test("fails closed and closes the tab when Chrome has no Manager session", async () => {
    const view = fakeView({ cookies: [cookie({ name: "_ga" })] });
    await expect(
      sessionFromRunningChrome({ viewFactory: async () => view }),
    ).rejects.toThrow(/no GSID session cookie/);
    expect(view.closed).toBe(true);
  });

  test("fails closed when Chrome still shows the login form", async () => {
    const view = fakeView({ loginForm: true });
    await expect(
      sessionFromRunningChrome({ viewFactory: async () => view }),
    ).rejects.toThrow(/login form/);
    expect(view.closed).toBe(true);
  });
});
