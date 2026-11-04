import { describe, expect, test } from "bun:test";

import { toLocalPath } from "../lib/local_path.ts";
import { UsageError } from "../lib/usage_error.ts";

describe("toLocalPath", () => {
  test("file:// URLs become paths, with percent-escapes decoded", () => {
    expect(toLocalPath("file:///tmp/a%20b/shot.png")).toBe("/tmp/a b/shot.png");
  });

  test("plain paths pass through, relative ones stay relative", () => {
    expect(toLocalPath("scratch/webview-profile")).toBe(
      "scratch/webview-profile",
    );
    expect(toLocalPath("/tmp/x.png")).toBe("/tmp/x.png");
    expect(toLocalPath("C:\\cfg\\desk.yaml")).toBe("C:\\cfg\\desk.yaml");
  });

  test("other schemes are refused, never treated as a relative path", () => {
    for (const raw of [
      "https://evil.example/cfg.yaml",
      "http://localhost/cfg.yaml",
      "s3://bucket/cfg.yaml",
      "data:text/plain,a: 1",
    ]) {
      expect(() => toLocalPath(raw)).toThrow(UsageError);
      expect(() => toLocalPath(raw)).toThrow("only local paths and file://");
    }
  });

  test("a file:// URL with a query or fragment is refused rather than half-read", () => {
    expect(() => toLocalPath("file:///tmp/config.yaml?v=1")).toThrow(
      "cannot carry a query or fragment",
    );
    expect(() => toLocalPath("file:///tmp/config.yaml#x")).toThrow(
      "cannot carry a query or fragment",
    );
  });
});
