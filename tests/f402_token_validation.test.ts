import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  F402PendingFetchError,
  readF402TokenFile,
  resolveF402BearerToken,
  resolveF402BearerTokenDetailed,
  validateF402Token,
} from "../lib/f402_pending_fetch.ts";

const dir = mkdtempSync(join(tmpdir(), "f402-token-validation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;

function writeToken(content: string): string {
  counter += 1;
  const path = join(dir, `token-${counter}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

/**
 * Builds a JWT-shaped value at runtime. The segments are assembled so the source never carries a
 * contiguous three-segment token (bin/check-secrets.ts scans for that shape).
 */
function jwt(
  segments: readonly string[] = ["eyJ", "a".repeat(10), "b".repeat(10)],
): string {
  return segments.join(".");
}

describe("F402 token validation", () => {
  test("rejects shell text and multi-line files", () => {
    for (const content of [
      "umask 077\n",
      "umask077",
      "export F402_BEARER_TOKEN=abc",
      "exportFOO",
      "  umask 022  ",
      "token with spaces in it",
      "line-one\nline-two\n",
      "",
      "0",
      "short-token",
    ]) {
      expect(readF402TokenFile(writeToken(content))).toBeNull();
    }
  });

  test("rejects a JWT-looking value that is not three non-empty base64url segments", () => {
    for (const value of [
      // One segment: the header alone.
      "eyJ" + "a".repeat(30),
      // Two segments.
      jwt(["eyJ", "a".repeat(20)]),
      // Four segments.
      jwt(["eyJ", "a".repeat(10), "b".repeat(10), "c".repeat(10)]),
      // Empty middle segment.
      jwt(["eyJ" + "a".repeat(10), "", "b".repeat(10)]),
      // Non-base64url character in a segment.
      jwt(["eyJ" + "a".repeat(10), "b+c".repeat(4), "d".repeat(10)]),
    ]) {
      expect(validateF402Token(value)).toBeNull();
    }
  });

  test("accepts JWT-shaped and opaque tokens", () => {
    const jwtToken = jwt();
    expect(validateF402Token(jwtToken)).toBe(jwtToken);
    expect(validateF402Token(`Bearer ${jwtToken}`)).toBe(jwtToken);

    const opaque = "opaque-bearer-token-" + "x".repeat(30);
    expect(validateF402Token(opaque)).toBe(opaque);
    expect(validateF402Token(`  Bearer ${opaque}  `)).toBe(opaque);
    expect(validateF402Token("t".repeat(24))).toBe("t".repeat(24));
  });

  test("reads a valid token file and returns null for missing files", () => {
    const opaque = "file-token-" + "y".repeat(30);
    const path = writeToken(`${opaque}\n`);
    expect(readF402TokenFile(path)).toBe(opaque);
    expect(readF402TokenFile(join(dir, "absent"))).toBeNull();
  });

  test("resolveF402BearerToken uses the validating reader and fails closed", () => {
    const noSession = { readSession: () => null };
    const opaque = "resolved-token-" + "z".repeat(30);
    const validPath = writeToken(`${opaque}\n`);
    expect(
      resolveF402BearerToken({
        environment: { F402_TOKEN_FILE: validPath },
        ...noSession,
      }),
    ).toBe(opaque);

    const shellPath = writeToken("umask 077\n");
    expect(() =>
      resolveF402BearerToken({
        environment: { F402_TOKEN_FILE: shellPath },
        ...noSession,
      }),
    ).toThrow(F402PendingFetchError);

    const malformedJwtPath = writeToken(jwt(["eyJ", "a".repeat(20)]));
    expect(() =>
      resolveF402BearerToken({
        environment: { F402_TOKEN_FILE: malformedJwtPath },
        ...noSession,
      }),
    ).toThrow(F402PendingFetchError);
  });

  test("CLI and env sources still win over the file", () => {
    const path = writeToken("file-source-" + "f".repeat(30));
    const environment = { F402_TOKEN_FILE: path };
    expect(
      resolveF402BearerToken({
        cliToken: "cli-source-" + "c".repeat(30),
        environment,
      }),
    ).toBe("cli-source-" + "c".repeat(30));
    expect(
      resolveF402BearerToken({
        environment: {
          ...environment,
          F402_BEARER_TOKEN: "env-source-" + "e".repeat(30),
        },
      }),
    ).toBe("env-source-" + "e".repeat(30));
  });

  test("session authorizationHeader is the last resort before throwing", () => {
    const sessionToken = "session-bearer-" + "s".repeat(30);
    const resolved = resolveF402BearerTokenDetailed({
      environment: {},
      readFile: () => {
        throw new Error("file must not be read");
      },
      readSession: () => ({
        cookieHeader: "a=b",
        cookieNames: ["a"],
        authorizationHeader: `Bearer ${sessionToken}`,
        obtainedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(resolved).toEqual({ token: sessionToken, source: "session" });
    expect(() =>
      resolveF402BearerTokenDetailed({
        environment: {},
        readSession: () => null,
      }),
    ).toThrow(F402PendingFetchError);
  });

  test("a present-but-invalid explicit source fails closed", () => {
    const readFile = () => "must-not-be-read-" + "f".repeat(30);
    for (const token of ["0", "short", "umask 077"]) {
      expect(() =>
        resolveF402BearerToken({
          cliToken: token,
          environment: { F402_TOKEN_FILE: join(dir, "irrelevant") },
          readFile,
        }),
      ).toThrow(F402PendingFetchError);
    }
  });
});
