/**
 * Chrome's "Chrome process closed the pipe" hides the cause on stderr. These pin the classifier and
 * the remediation, with an injected probe so no test spawns a browser.
 */
import { describe, expect, test } from "bun:test";

import {
  chromeFailureAdvice,
  classifyChromeFailure,
  diagnoseChromeBackend,
  type ChromeProbeResult,
} from "../lib/webview_backend_diagnostics.ts";

const SANDBOX_STDERR = `Failed to initialize sandbox.[WARNING:crashpad/util/process/process_memory_mac.cc:94] mach_vm_read: invalid address
ERROR:gpu_process_host.cc:1044] GPU process exited unexpectedly: exit_code=6
sandbox initialization failed: Operation not permitted
ERROR:file_io_posix.cc:153] open /Users/x/Library/Application Support/Google/Chrome/Crashpad/new/a.dmp: Operation not permitted (1)
FATAL:gpu_data_manager_impl_private.cc:389] GPU process isn't usable. Goodbye.`;

// `/bin/sh` is on every POSIX test runner; BUN_CHROME_PATH's existsSync() check short-circuits
// resolveChromeBinary without the previous resolveBinary injection point.
const FAKE_CHROME = "/bin/sh";

function diagnosisWith(result: ChromeProbeResult) {
  return diagnoseChromeBackend({
    env: { BUN_CHROME_PATH: FAKE_CHROME },
    runProbe: async () => result,
  });
}

describe("classifyChromeFailure", () => {
  test("sandbox denial outranks its GPU and Crashpad symptoms", () => {
    expect(classifyChromeFailure(SANDBOX_STDERR)).toBe("sandbox-denied");
  });

  test("isolated symptoms still classify", () => {
    expect(classifyChromeFailure("GPU process isn't usable. Goodbye.")).toBe(
      "gpu-denied",
    );
    expect(
      classifyChromeFailure("Crashpad/new/a.dmp: Operation not permitted (1)"),
    ).toBe("crashpad-denied");
    expect(
      classifyChromeFailure("The user data directory is already in use"),
    ).toBe("profile-locked");
    expect(classifyChromeFailure("chrome: unknown flag")).toBe("launch-failed");
    expect(classifyChromeFailure("")).toBe("unknown");
  });
});

describe("diagnoseChromeBackend", () => {
  test("a sandbox denial is unavailable with remediation, and never suggests --no-sandbox", async () => {
    const diagnosis = await diagnosisWith({
      exitCode: 1,
      stdout: "",
      stderr: SANDBOX_STDERR,
    });
    expect(diagnosis.available).toBe(false);
    expect(diagnosis.failure).toBe("sandbox-denied");
    expect(diagnosis.binary).toBe(FAKE_CHROME);
    expect(diagnosis.stderrTail).toContain("Operation not permitted");
    const advice = chromeFailureAdvice(diagnosis);
    expect(advice.join("\n")).toContain("outside the agent/harness sandbox");
    expect(advice.join("\n")).toContain("Do not add --no-sandbox");
  });

  test("a healthy probe is available with no advice", async () => {
    const diagnosis = await diagnosisWith({
      exitCode: 0,
      stdout: "<html></html>",
      stderr: "",
    });
    expect(diagnosis.available).toBe(true);
    expect(chromeFailureAdvice(diagnosis)).toEqual([]);
  });

  test("no binary is reported as not-found with an install hint", async () => {
    // Force resolveChromeBinary's `exists(configured) ? configured : null` to return null by
    // pointing BUN_CHROME_PATH at a path that genuinely does not exist on the test machine.
    const diagnosis = await diagnoseChromeBackend({
      env: {
        BUN_CHROME_PATH: "/nonexistent-chrome-for-diagnostics-test-20261104",
      },
    });
    expect(diagnosis.available).toBe(false);
    expect(diagnosis.failure).toBe("not-found");
    expect(diagnosis.binary).toBeNull();
    expect(chromeFailureAdvice(diagnosis).join("\n")).toContain(
      "BUN_CHROME_PATH",
    );
  });

  test("a locked profile points at the other browser, not at the sandbox", async () => {
    const diagnosis = await diagnosisWith({
      exitCode: 1,
      stdout: "",
      stderr: "The user data directory is already in use by another Chrome.",
    });
    expect(diagnosis.failure).toBe("profile-locked");
    expect(chromeFailureAdvice(diagnosis).join("\n")).toContain(
      "Quit the Chrome instance",
    );
  });
});
