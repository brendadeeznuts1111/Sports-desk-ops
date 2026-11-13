import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cookieHeaderFromEnv,
  GANCHROW_SESSION_SECRET,
  GSID_SECRET,
  GSID_SECRET_LEGACY,
  GSID_SECRET_PRE_RENAME,
  requireManagerSession,
  resolveManagerSession,
  resolveManagerSessionGate,
  sessionGateFromEnv,
  writeManagerSessionGate,
  type ActiveManagerSession,
  type ManagerSession,
  type SecretReader,
} from "../lib/manager_session.ts";
import { getSecretBounded, KeychainTimeoutError } from "../lib/secrets.ts";

const SERVICE = "com.bookdeskops.sportsdesk";
const LEGACY_SERVICE = "sportsdesk-gslive";

/** Injectable reader: tests never touch the real OS keychain. */
const reader = (values: Record<string, string | null>): SecretReader => ({
  async get({ service, name }) {
    return values[`${service}/${name}`] ?? null;
  },
});

/** Narrow a resolved session to the active variant; the tests below always provision one. */
function active(session: ManagerSession): ActiveManagerSession {
  if (session.source === "none") throw new Error("expected an active session");
  return session;
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "manager-session-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSessionFile(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("cookieHeaderFromEnv", () => {
  test("is empty when no session is configured", () => {
    expect(cookieHeaderFromEnv({})).toBe("");
  });

  test("prefers GSLIVE_SESSION_ID over the legacy GSID name", () => {
    expect(cookieHeaderFromEnv({ GSLIVE_SESSION_ID: "new", GSID: "old" })).toBe(
      "GSID=new",
    );
    expect(cookieHeaderFromEnv({ GSLIVE_SESSION_ID: "  ", GSID: "old" })).toBe(
      "GSID=old",
    );
    expect(cookieHeaderFromEnv({ GSID: " old " })).toBe("GSID=old");
  });

  test("appends _ga only when GA is present", () => {
    expect(cookieHeaderFromEnv({ GSLIVE_SESSION_ID: "abc", GA: " ga1 " })).toBe(
      "GSID=abc; _ga=ga1",
    );
    expect(cookieHeaderFromEnv({ GSLIVE_SESSION_ID: "abc", GA: "  " })).toBe(
      "GSID=abc",
    );
  });
});

describe("resolveManagerSession", () => {
  test("prefers a host-exported GSID_COOKIE and accepts a bare id or a full header", async () => {
    const bare = await resolveManagerSession({ GSID_COOKIE: "raw-id" }, null);
    expect(bare).toEqual({
      source: "env-cookie",
      cookieHeader: "GSID=raw-id",
      sessionGate: "",
    });

    const full = await resolveManagerSession(
      { GSID_COOKIE: "GSID=x; _ga=y" },
      null,
    );
    expect(full.source).toBe("env-cookie");
    expect(full.cookieHeader).toBe("GSID=x; _ga=y");
  });

  test("prefers GSID_COOKIE over the session file and the keychain", async () => {
    const path = writeSessionFile("precedence/session", "file-id");
    const session = await resolveManagerSession(
      { GSID_COOKIE: "cookie-id", GSLIVE_SESSION_FILE: path },
      reader({ [`${SERVICE}/GSLIVE_SESSION_ID`]: "keychain-id" }),
    );
    expect(session.source).toBe("env-cookie");
    expect(session.cookieHeader).toBe("GSID=cookie-id");
  });

  test("reads an explicit GSLIVE_SESSION_FILE after the env cookie", async () => {
    const path = writeSessionFile("explicit/session", "  file-id \n");
    const session = await resolveManagerSession(
      { GSLIVE_SESSION_FILE: path },
      null,
    );
    expect(session).toEqual({
      source: "session-file",
      cookieHeader: "GSID=file-id",
      sessionGate: "",
    });
  });

  test("reads $XDG_CONFIG_HOME/sportsdesk/gslive-session when no explicit file is set", async () => {
    const configHome = join(root, "xdg");
    const path = join(configHome, "sportsdesk", "gslive-session");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "xdg-id", "utf8");
    const session = await resolveManagerSession(
      { XDG_CONFIG_HOME: configHome },
      null,
    );
    expect(session.source).toBe("session-file");
    expect(session.cookieHeader).toBe("GSID=xdg-id");
  });

  test("reads $HOME/.config/sportsdesk/gslive-session as the last file location", async () => {
    const home = join(root, "home");
    const path = join(home, ".config", "sportsdesk", "gslive-session");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "home-id", "utf8");
    const session = await resolveManagerSession({ HOME: home }, null);
    expect(session.source).toBe("session-file");
    expect(session.cookieHeader).toBe("GSID=home-id");
  });

  test("ignores an empty or unreadable session file", async () => {
    const empty = writeSessionFile("empty/session", "   \n");
    expect(
      (await resolveManagerSession({ GSLIVE_SESSION_FILE: empty }, null))
        .source,
    ).toBe("none");
    expect(
      (
        await resolveManagerSession(
          { GSLIVE_SESSION_FILE: join(root, "missing") },
          null,
        )
      ).source,
    ).toBe("none");
  });

  test("falls back to the keychain, trying the pre-rename and legacy entries in order", async () => {
    const current = await resolveManagerSession(
      {},
      reader({ [`${SERVICE}/GSLIVE_SESSION_ID`]: "kc-new" }),
    );
    expect(current).toEqual({
      source: "keychain",
      cookieHeader: "GSID=kc-new",
      sessionGate: "",
    });

    const preRename = await resolveManagerSession(
      {},
      reader({ [`${SERVICE}/${GSID_SECRET_PRE_RENAME.name}`]: "kc-pre" }),
    );
    expect(preRename.cookieHeader).toBe("GSID=kc-pre");

    const legacy = await resolveManagerSession(
      {},
      reader({ [`${LEGACY_SERVICE}/GSID`]: "kc-legacy" }),
    );
    expect(legacy.cookieHeader).toBe("GSID=kc-legacy");
  });

  test("an empty current keychain entry stops the fallback chain", async () => {
    // `?.trim() ?? next` only falls through on null/undefined: an entry that exists and
    // trims empty is not nullish, so the pre-rename entry is never consulted and the
    // resolver drops to the environment (here: nothing).
    const session = await resolveManagerSession(
      {},
      reader({
        [`${SERVICE}/GSLIVE_SESSION_ID`]: "",
        [`${SERVICE}/${GSID_SECRET_PRE_RENAME.name}`]: "kc-pre",
      }),
    );
    expect(session).toEqual({ source: "none", cookieHeader: "" });
  });

  test("uses the environment after the keychain when the reader fails", async () => {
    const throwing: SecretReader = {
      async get() {
        throw new Error("keychain locked");
      },
    };
    const session = await resolveManagerSession({ GSID: "env-id" }, throwing);
    expect(session).toEqual({
      source: "env",
      cookieHeader: "GSID=env-id",
      sessionGate: "",
    });
  });

  test("reports none when nothing is provisioned", async () => {
    expect(await resolveManagerSession({}, null)).toEqual({
      source: "none",
      cookieHeader: "",
    });
    expect(await resolveManagerSession({}, reader({}))).toEqual({
      source: "none",
      cookieHeader: "",
    });
  });

  test("resolves the gate independently of the cookie source", async () => {
    const session = await resolveManagerSession(
      { GSID_COOKIE: "c", GS_SESSION: " gate-env " },
      reader({
        [GANCHROW_SESSION_SECRET.service + "/" + GANCHROW_SESSION_SECRET.name]:
          "gate-kc",
      }),
    );
    expect(active(session).sessionGate).toBe("gate-env");

    const fromKeychain = await resolveManagerSession(
      { GSID_COOKIE: "c" },
      reader({
        [`${GANCHROW_SESSION_SECRET.service}/${GANCHROW_SESSION_SECRET.name}`]:
          "gate-kc",
      }),
    );
    expect(active(fromKeychain).sessionGate).toBe("gate-kc");

    const unavailable = await resolveManagerSession({ GSID_COOKIE: "c" }, null);
    expect(active(unavailable).sessionGate).toBe("");
  });
});

describe("requireManagerSession", () => {
  test("returns the active session", async () => {
    const session = await requireManagerSession({ GSID_COOKIE: "abc" }, null);
    expect(session.source).toBe("env-cookie");
    expect(session.cookieHeader).toBe("GSID=abc");
  });

  test("fails closed with the provisioning path and never echoes a cookie", async () => {
    await expect(requireManagerSession({}, null)).rejects.toThrow(
      "No manager session. Provision it in the OS keychain",
    );
    try {
      await requireManagerSession({}, null);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("com.bookdeskops.sportsdesk");
      expect(message).toContain("GSLIVE_SESSION_ID");
      expect(message).not.toContain("GSID=");
    }
  });
});

describe("gate resolution", () => {
  test("sessionGateFromEnv trims and defaults to empty", () => {
    expect(sessionGateFromEnv({})).toBe("");
    expect(sessionGateFromEnv({ GS_SESSION: " x " })).toBe("x");
  });

  test("resolveManagerSessionGate prefers the environment and survives a throwing reader", async () => {
    expect(await resolveManagerSessionGate({ GS_SESSION: "env" }, null)).toBe(
      "env",
    );
    expect(
      await resolveManagerSessionGate(
        {},
        reader({ [`${SERVICE}/${GANCHROW_SESSION_SECRET.name}`]: "kc" }),
      ),
    ).toBe("kc");
    const throwing: SecretReader = {
      async get() {
        throw new Error("locked");
      },
    };
    expect(await resolveManagerSessionGate({}, throwing)).toBe("");
  });

  test("writeManagerSessionGate ignores a blank value without touching the keychain", async () => {
    await expect(writeManagerSessionGate("   ")).resolves.toBeUndefined();
  });
});

describe("keychain entry constants", () => {
  test("are the documented service/name pairs", () => {
    expect(GSID_SECRET).toEqual({
      service: SERVICE,
      name: "GSLIVE_SESSION_ID",
    });
    expect(GSID_SECRET_PRE_RENAME).toEqual({ service: SERVICE, name: "GSID" });
    expect(GSID_SECRET_LEGACY).toEqual({
      service: LEGACY_SERVICE,
      name: "GSID",
    });
    expect(GANCHROW_SESSION_SECRET).toEqual({
      service: SERVICE,
      name: "GSLIVE_GANCHROW_SESSION",
    });
  });

  test("does not query GANCHROW_SESSION_SECRET when no session cookie exists", async () => {
    const queried: string[] = [];
    const spyReader: SecretReader = {
      async get({ name }) {
        queried.push(name);
        return null;
      },
    };
    const session = await resolveManagerSession({}, spyReader);
    expect(session).toEqual({ source: "none", cookieHeader: "" });
    expect(queried).not.toContain(GANCHROW_SESSION_SECRET.name);
  });

  test("bounded keychain reader times out and session helpers degrade cleanly", async () => {
    const hangingReader: SecretReader = {
      get: () => new Promise<string | null>(() => {}),
    };
    await expect(
      getSecretBounded(hangingReader, GANCHROW_SESSION_SECRET, 25),
    ).rejects.toBeInstanceOf(KeychainTimeoutError);

    const boundedReader: SecretReader = {
      get: (options) => getSecretBounded(hangingReader, options, 25),
    };
    expect(await resolveManagerSessionGate({}, boundedReader)).toBe("");
    expect(await resolveManagerSession({}, boundedReader)).toEqual({
      source: "none",
      cookieHeader: "",
    });
  });
});
