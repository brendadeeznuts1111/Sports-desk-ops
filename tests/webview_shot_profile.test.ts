import { describe, expect, test } from "bun:test";

import {
  WebViewError,
  type WebViewErrorCode,
} from "../scripts/capture/webview.ts";
import {
  navigateWithRetry,
  parseSignedOutMarkers,
} from "../scripts/capture/shot.ts";
import {
  boundedInt,
  parseShotArgs,
  renderShotTable,
  ShotUsageError,
} from "../scripts/webview_shot_cli.ts";

describe("parseShotArgs", () => {
  test("--flag=value and --flag value parse the same", () => {
    const spaced = parseShotArgs([
      "https://x",
      "--out",
      "a.png",
      "--thumb",
      "64",
    ]);
    const equals = parseShotArgs(["https://x", "--out=a.png", "--thumb=64"]);
    expect(equals).toEqual(spaced);
    expect(equals?.out).toBe("a.png");
    expect(equals?.thumb).toBe(64);
  });

  test("an unknown or misspelled flag is a usage error, not ignored", () => {
    for (const argv of [
      ["https://x", "--thumbs", "64"],
      ["https://x", "--jsno"],
    ]) {
      expect(() => parseShotArgs(argv)).toThrow(ShotUsageError);
    }
  });

  test("--out and --profile take a file:// URL but refuse other schemes", () => {
    expect(
      parseShotArgs(["https://x", "--out=file:///tmp/a%20b.png"])?.out,
    ).toBe("/tmp/a b.png");
    expect(() =>
      parseShotArgs(["https://x", "--profile", "https://evil.example/p"]),
    ).toThrow("only local paths and file:// URLs are accepted, not https:");
  });

  test("a bad enum or out-of-range number is a usage error, never a silent default", () => {
    for (const argv of [
      ["https://x", "--backend", "firefox"],
      ["https://x", "--format", "gif"],
      ["https://x", "--encoding", "hex"],
      ["https://x", "--width", "0"],
      ["https://x", "--height", "16385"],
      ["https://x", "--width", "wide"],
      ["https://x", "--quality", "101"],
      ["https://x", "--resize", "0x10"],
      ["https://x", "--resize", "99999"],
    ]) {
      expect(() => parseShotArgs(argv)).toThrow(ShotUsageError);
    }
  });

  test("jpg is an alias for jpeg, and raw-buffer is an accepted encoding", () => {
    expect(parseShotArgs(["https://x", "--format", "jpg"])?.format).toBe(
      "jpeg",
    );
    expect(
      parseShotArgs(["https://x", "--encoding", "raw-buffer"])?.encoding,
    ).toBe("raw-buffer");
    expect(parseShotArgs(["https://x", "--width", "200"])?.width).toBe(200);
  });

  test("--upload-blob, --blob-gateway and --blob-key parse", () => {
    const options = parseShotArgs([
      "https://x",
      "--upload-blob",
      "--blob-gateway",
      "http://127.0.0.1:9",
      "--blob-key=shots/a.png",
    ]);
    expect(options?.uploadBlob).toBe(true);
    expect(options?.blobGateway).toBe("http://127.0.0.1:9");
    expect(options?.blobKey).toBe("shots/a.png");
    expect(parseShotArgs(["https://x"])?.uploadBlob).toBe(false);
  });

  test("a value flag with no value is a usage error", () => {
    expect(() => parseShotArgs(["https://x", "--out"])).toThrow(ShotUsageError);
  });

  test("a second URL is a usage error instead of being dropped", () => {
    expect(() => parseShotArgs(["https://a", "https://b"])).toThrow(
      "expected at most one URL, got 2",
    );
  });

  test("-h and --help return null", () => {
    expect(parseShotArgs(["-h"])).toBeNull();
    expect(parseShotArgs(["https://x", "--help"])).toBeNull();
  });
});

describe("parseSignedOutMarkers", () => {
  test("keeps the known markers in page order", () => {
    expect(parseSignedOutMarkers(["session-expired", "login-form"])).toEqual([
      "session-expired",
      "login-form",
    ]);
  });

  test("drops anything the page returned that is not a known marker", () => {
    expect(
      parseSignedOutMarkers(["login-form", "logged-in", 1, null, {}]),
    ).toEqual(["login-form"]);
  });

  test("a non-array evaluation result means no markers seen", () => {
    for (const value of [undefined, null, "login-form", { 0: "login-form" }]) {
      expect(parseSignedOutMarkers(value)).toEqual([]);
    }
  });
});

describe("boundedInt", () => {
  test("accepts integers inside the range, including both ends", () => {
    expect(boundedInt("16", 16, 2048)).toBe(16);
    expect(boundedInt("2048", 16, 2048)).toBe(2048);
  });

  test("rejects out-of-range, fractional and non-numeric input", () => {
    for (const raw of ["15", "2049", "16.5", "abc", "", "-1"]) {
      expect(boundedInt(raw, 16, 2048)).toBeUndefined();
    }
  });
});

describe("navigateWithRetry", () => {
  function flakyView(failures: number, code: WebViewErrorCode) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async navigate() {
        calls += 1;
        if (calls <= failures) throw new WebViewError(code, "boom");
        return { url: "https://x", title: "", loading: false };
      },
    };
  }
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };

  test("retries a failed navigation with growing waits, then succeeds", async () => {
    waits.length = 0;
    const view = flakyView(2, "navigate-failed");
    expect(
      await navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 2,
        sleep,
      }),
    ).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  test("gives up after --retries and rethrows the last error", async () => {
    const view = flakyView(5, "load-timeout");
    await expect(
      navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 1,
        sleep,
      }),
    ).rejects.toThrow("boom");
    expect(view.calls).toBe(2);
  });

  test("never retries an error that a retry cannot fix", async () => {
    const view = flakyView(1, "invalid-url");
    await expect(
      navigateWithRetry(view, "https://x", {
        timeoutMs: 1000,
        retries: 3,
        sleep,
      }),
    ).rejects.toThrow("boom");
    expect(view.calls).toBe(1);
  });
});

describe("renderShotTable", () => {
  const base = {
    screenshot: "/tmp/s.png",
    screenshotUrl: "file:///tmp/s.png",
    bytes: 10,
    sha256: "ab".repeat(32),
    mimeType: "image/png",
    backend: "webkit",
    format: "png",
    encoding: "blob",
    title: "Manager",
    url: "https://www.fantasy402.com/manager.html",
  } as const;

  test("one row per field, keyed by name, without colour when asked", () => {
    const text = renderShotTable(base, false);
    expect(text).toContain("screenshot");
    expect(text).toContain("webkit (png)");
    expect(text).not.toContain("signedOutMarkers");
    expect(text).not.toContain("\x1b[");
  });

  test("summarises the long fields instead of printing them", () => {
    const text = renderShotTable(
      {
        ...base,
        profile: "/p",
        signedOutMarkers: [],
        placeholder: `data:image/png;base64,${"A".repeat(500)}`,
        console: [{ level: "log", text: "hello" }],
      },
      false,
    );
    expect(text).toContain("none seen");
    expect(text).toContain("522 chars");
    expect(text).toContain("1 line(s)");
    expect(text).not.toContain("AAAA");
    expect(text).not.toContain("hello");
  });

  test("cookies show as a count and names", () => {
    const cookie = {
      domain: ".fantasy402.com",
      path: "/",
      httpOnly: true,
      secure: true,
    };
    const text = renderShotTable(
      {
        ...base,
        cookies: [
          {
            ...cookie,
            name: "agent",
            expires: "2026-11-01T00:00:00.000Z",
            expired: true,
          },
          { ...cookie, name: "session", expires: "session", expired: false },
        ],
      },
      false,
    );
    expect(text).toContain("2 portal (1 expired): agent, session");
    expect(renderShotTable({ ...base, cookies: [] }, false)).toContain(
      "no portal cookies",
    );
  });
});
