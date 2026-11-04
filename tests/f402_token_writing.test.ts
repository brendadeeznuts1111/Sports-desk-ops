/**
 * `session:login --mint-bearer` writes the token that `resolveF402BearerToken` reads. That file
 * must be 0600, atomic, validated, and path-resolved the same way the reader resolves it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  F402PendingFetchError,
  readF402TokenFile,
  resolveF402TokenFilePath,
  writeF402BearerToken,
} from "../lib/f402_pending_fetch.ts";

const dir = mkdtempSync(join(tmpdir(), "f402-token-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function jwt(): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ exp: 2_000_000_000 }),
    "c".repeat(43),
  ].join(".");
}

describe("token-file path", () => {
  test("F402_TOKEN_FILE wins", () => {
    expect(
      resolveF402TokenFilePath({ F402_TOKEN_FILE: "/tmp/x-token", HOME: "/h" }),
    ).toBe("/tmp/x-token");
  });

  test("XDG_CONFIG_HOME, then HOME/.config", () => {
    expect(
      resolveF402TokenFilePath({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" }),
    ).toBe("/xdg/sportsdesk/f402-token");
    expect(resolveF402TokenFilePath({ HOME: "/h" })).toBe(
      "/h/.config/sportsdesk/f402-token",
    );
  });
});

describe("writeF402BearerToken", () => {
  test("writes exactly the token at 0600 and leaves no temp files", () => {
    const path = join(dir, "nested", "f402-token");
    const token = jwt();
    const written = writeF402BearerToken(token, { path });

    expect(written).toEqual({ path, chars: token.length });
    expect(readF402TokenFile(path)).toBe(token);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(
      readdirSync(join(dir, "nested")).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  test("an invalid token is refused before writing", () => {
    const path = join(dir, "invalid-token");
    expect(() => writeF402BearerToken("short", { path })).toThrow(
      F402PendingFetchError,
    );
  });
});
