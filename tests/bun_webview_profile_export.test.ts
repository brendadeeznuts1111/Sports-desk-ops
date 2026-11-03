import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManagedWebView } from "../scripts/capture/webview.ts";

/**
 * Chrome integration test for `session:login --from-profile`.
 *
 * Seeds a real Chrome dataStore profile with an HttpOnly cookie via a local
 * page, then runs the CLI against that profile and verifies the session file
 * contains the cookie, is 0600, and honors `--ttl-min`. The CLI is spawned as
 * a separate process so the profile singleton is released between steps.
 *
 * Skipped on non-darwin or when Chrome is unavailable.
 */

const PATH_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
  "microsoft-edge",
] as const;
const MAC_APP_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

function detectChromeExecutable(): string | null {
  const configured = Bun.env.BUN_CHROME_PATH;
  if (configured !== undefined && configured.length > 0) {
    return existsSync(configured) ? configured : null;
  }
  for (const name of PATH_CANDIDATES) {
    const found = Bun.which(name);
    if (found !== null && found.length > 0) return found;
  }
  if (process.platform === "darwin") {
    for (const path of MAC_APP_CANDIDATES) {
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const chromePath = detectChromeExecutable();

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";

const root = mkdtempSync(join(tmpdir(), "profile-export-integration-"));
afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(chromePath === null)(
  "session:login --from-profile (Chrome dataStore)",
  () => {
    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          const headers = new Headers({ "content-type": "text/html" });
          headers.append(
            "Set-Cookie",
            "session=EXPORTED-SESSION-VALUE; Path=/cloud; HttpOnly; SameSite=Lax",
          );
          headers.append(
            "Set-Cookie",
            "visible=EXPORTED-VISIBLE-VALUE; Path=/; SameSite=Lax",
          );
          headers.append(
            "Set-Cookie",
            "__cf_bm=EXPORTED-CF-VALUE; Path=/; HttpOnly; SameSite=Lax",
          );
          return new Response("<title>profile-export</title><h1>ok</h1>", {
            headers,
          });
        },
      });
      baseUrl = `http://127.0.0.1:${server!.port}`;
    });

    test("exports cookies from a real Chrome profile to a 0600 session file", async () => {
      const profile = join(root, "profile");
      const sessionPath = join(root, "session.json");

      // 1) Seed the profile through a real Chrome dataStore.
      const seed = ManagedWebView.launch({
        backend: "chrome",
        width: 400,
        height: 300,
        dataStoreDir: profile,
      });
      await seed.navigate(`${baseUrl}/`);
      const cookies = await seed.getAllCookies();
      expect(cookies.length).toBeGreaterThanOrEqual(3);
      await seed.close();
      Bun.WebView.closeAll();
      await Bun.sleep(1_000); // release the parent's Chrome/profile singleton

      // 2) Export the profile via the CLI.
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          "scripts/session_login.ts",
          "--from-profile",
          profile,
          "--out",
          sessionPath,
          "--ttl-min",
          "5",
        ],
        cwd: "/Users/nolarose/code/sportsdesk-ops",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: Bun.env["PATH"] ?? "",
          HOME: Bun.env["HOME"] ?? "",
          F402_BASE_URL: baseUrl,
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("session cookies=[");
      expect(stdout).toContain("session");
      expect(stdout).not.toContain("EXPORTED-SESSION-VALUE");
      expect(stdout).not.toContain("EXPORTED-VISIBLE-VALUE");

      const session = (await Bun.file(sessionPath).json()) as {
        cookieHeader: string;
        cookieNames: string[];
        obtainedAtIso: string;
        expiresAtIso: string;
      };
      expect(session.cookieNames).toContain("session");
      expect(session.cookieNames).toContain("visible");
      expect(session.cookieNames).toContain("__cf_bm");
      expect(session.cookieHeader).toContain("session=EXPORTED-SESSION-VALUE");
      expect(session.cookieHeader).toContain("visible=EXPORTED-VISIBLE-VALUE");
      expect(session.cookieHeader).toContain("__cf_bm=EXPORTED-CF-VALUE");
      expect((statSync(sessionPath).mode & 0o777).toString(8)).toBe("600");
      expect(
        Date.parse(session.expiresAtIso) - Date.parse(session.obtainedAtIso),
      ).toBe(5 * 60 * 1000);
    }, 60_000);

    test("lock conflict exits 1 with ProfileInUseError and no leakage", async () => {
      const profile = join(root, "lock-profile");
      const sessionPath = join(root, "lock-session.json");

      // Seed.
      const seed = ManagedWebView.launch({
        backend: "chrome",
        width: 400,
        height: 300,
        dataStoreDir: profile,
      });
      await seed.navigate(`${baseUrl}/`);
      await seed.close();
      Bun.WebView.closeAll();
      await Bun.sleep(1_000);

      // Hold the lock externally.
      const { acquireProfileLock } =
        await import("../lib/f402_profile_lock.ts");
      const lock = acquireProfileLock(profile);

      try {
        const proc = Bun.spawn({
          cmd: [
            process.execPath,
            "run",
            "scripts/session_login.ts",
            "--from-profile",
            profile,
            "--out",
            sessionPath,
            "--ttl-min",
            "5",
          ],
          cwd: "/Users/nolarose/code/sportsdesk-ops",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: Bun.env["PATH"] ?? "",
            HOME: Bun.env["HOME"] ?? "",
            F402_BASE_URL: baseUrl,
          },
        });
        const [stdout, stderr, code] = await Promise.all([
          proc.stdout.text(),
          proc.stderr.text(),
          proc.exited,
        ]);

        expect(code).toBe(1);
        expect(stderr).toContain("already in use by pid");
        expect(stderr).not.toContain("EXPORTED-SESSION-VALUE");
        expect(stderr).not.toContain("EXPORTED-VISIBLE-VALUE");
        expect(stdout).not.toContain("EXPORTED-SESSION-VALUE");
      } finally {
        lock.release();
      }
    }, 60_000);
  },
);
