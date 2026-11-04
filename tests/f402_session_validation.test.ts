import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readF402Session,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";

const dir = mkdtempSync(join(tmpdir(), "f402-session-validation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-01T11:10:00.000Z");

const VALID: F402Session = {
  cookieHeader: "session=abc123; csrftoken=def456",
  cookieNames: ["session", "csrftoken"],
  obtainedAtIso: "2026-11-01T11:00:00.000Z",
  expiresAtIso: "2026-11-01T11:30:00.000Z",
};

let counter = 0;

/** Write one raw session file at the private mode the reader requires. */
function writeRaw(content: string): string {
  counter += 1;
  const path = join(dir, `raw-${counter}.json`);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function readRaw(content: string, now = NOW): F402Session | null {
  return readF402Session({ path: writeRaw(content), now });
}

describe("readF402Session validation", () => {
  test("rejects content that is not a JSON object", () => {
    for (const content of [
      "",
      "not json",
      "null",
      "42",
      '"cookieHeader=session=abc"',
      "[]",
      "[1,2,3]",
      '{"cookieHeader":"session=abc"',
    ]) {
      expect(readRaw(content)).toBeNull();
    }
  });

  test("rejects a missing, empty, or unparseable cookieHeader", () => {
    for (const content of [
      "{}",
      '{"cookieHeader":null}',
      '{"cookieHeader":42}',
      '{"cookieHeader":{}}',
      '{"cookieHeader":""}',
      '{"cookieHeader":"   "}',
      '{"cookieNames":["session"]}',
      // A cookie header is name=value pairs; bare text is not one.
      '{"cookieHeader":"session"}',
      '{"cookieHeader":"abc; def"}',
      // CR/LF would be header injection.
      '{"cookieHeader":"session=abc\\r\\nX-Evil: 1"}',
    ]) {
      expect(readRaw(content)).toBeNull();
    }
  });

  test("rejects a present authorizationHeader that is not `Bearer <token>`", () => {
    for (const authorizationHeader of [
      "",
      " ",
      "token abc",
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer ",
      "Bearer  ",
      "bearer abc",
      "Bearer abc def",
      "Bearer\nabc",
      null,
      42,
      {},
    ]) {
      const content = JSON.stringify({
        ...VALID,
        authorizationHeader,
      });
      expect(readRaw(content)).toBeNull();
    }
  });

  test("accepts a well-formed session and drops non-string cookie names", () => {
    const path = writeRaw(
      JSON.stringify({
        ...VALID,
        cookieNames: ["session", 7, null, "csrftoken"],
        authorizationHeader: "Bearer portal-jwt",
      }),
    );
    const session = readF402Session({ path, now: NOW });
    expect(session).not.toBeNull();
    expect(session?.cookieHeader).toBe(VALID.cookieHeader);
    expect(session?.cookieNames).toEqual(["session", "csrftoken"]);
    expect(session?.authorizationHeader).toBe("Bearer portal-jwt");
    expect(session?.expiresAtIso).toBe(VALID.expiresAtIso);
  });

  test("keeps the expiry, missing-file, and file-mode checks", () => {
    const path = writeRaw(JSON.stringify(VALID));
    expect(readF402Session({ path, now: NOW })).not.toBeNull();
    expect(
      readF402Session({ path, now: Date.parse("2026-11-01T13:00:00.000Z") }),
    ).toBeNull();
    expect(readF402Session({ path: join(dir, "absent.json") })).toBeNull();

    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      expect(readF402Session({ path, now: NOW })).toBeNull();
    }
  });
});

describe("writeF402Session atomicity", () => {
  function assertPrivateFile(path: string): void {
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  }

  test("leaves a 0600 file, no .tmp, and a 0700 directory", () => {
    const nested = join(dir, "cache", "session.json");
    const path = writeF402Session(VALID, { path: nested });

    expect(path).toBe(nested);
    assertPrivateFile(path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
    expect(readF402Session({ path, now: NOW })?.cookieHeader).toBe(
      VALID.cookieHeader,
    );
  });

  test("replaces an existing file in one rename and leaves no .tmp", () => {
    const path = join(dir, "replace.json");
    writeF402Session(VALID, { path });
    const replacement: F402Session = {
      ...VALID,
      cookieHeader: "session=replacement",
      cookieNames: ["session"],
    };
    writeF402Session(replacement, { path });

    assertPrivateFile(path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readF402Session({ path, now: NOW })?.cookieHeader).toBe(
      "session=replacement",
    );
    // The file is the pretty-printed JSON the old writer produced.
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify(replacement, null, 2)}\n`,
    );
  });

  test("creates a missing parent directory 0700 before writing", () => {
    const deep = join(dir, "created", "inner");
    mkdirSync(join(dir, "created"), { mode: 0o755 });
    const path = writeF402Session(VALID, {
      path: join(deep, "session.json"),
    });
    if (process.platform !== "win32") {
      expect(statSync(deep).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
