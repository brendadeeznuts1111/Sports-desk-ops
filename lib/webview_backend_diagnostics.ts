/**
 * Why the Chrome-backed WebView is unavailable, in a form the operator can act on.
 *
 * Bun's Chrome backend spawns a headless Chrome and talks CDP over `--remote-debugging-pipe`. When
 * that browser dies, the first navigation rejects with the opaque "Chrome process closed the pipe"
 * and the real cause only exists on Chrome's stderr (silenced unless `stderr: "inherit"`). This
 * module runs a minimal headless probe, classifies the stderr, and returns remediation text.
 *
 * It never works around a denial: `--no-sandbox` is deliberately not suggested or added.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ChromeFailureClass =
  | "sandbox-denied"
  | "gpu-denied"
  | "crashpad-denied"
  | "profile-locked"
  | "not-found"
  | "launch-failed"
  | "unknown";

/** Ordered: the first matching class wins, so the root cause beats its symptoms. */
const CLASSIFIERS: readonly (readonly [ChromeFailureClass, RegExp])[] = [
  [
    "sandbox-denied",
    /sandbox initialization failed|failed to initialize sandbox/i,
  ],
  ["gpu-denied", /GPU process isn't usable|GPU process exited unexpectedly/i],
  ["crashpad-denied", /Crashpad[\s\S]{0,400}Operation not permitted/i],
  [
    "profile-locked",
    /user data directory is already in use|profile appears to be in use|DevToolsActivePort/i,
  ],
];

export function classifyChromeFailure(stderr: string): ChromeFailureClass {
  for (const [failure, pattern] of CLASSIFIERS) {
    if (pattern.test(stderr)) return failure;
  }
  return /chrome|chromium|browser/i.test(stderr) ? "launch-failed" : "unknown";
}

export interface ChromeBackendDiagnosis {
  readonly available: boolean;
  readonly binary: string | null;
  readonly failure: ChromeFailureClass;
  readonly reason: string;
  readonly stderrTail: string;
  readonly exitCode: number | null;
}

const CANDIDATE_BINARIES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "brave-browser",
  "microsoft-edge",
  "chrome",
] as const;

const MAC_INSTALL_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
] as const;

/** Bun's documented search order, minus the Playwright cache (not needed on the desk machines). */
export function resolveChromeBinary(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync,
): string | null {
  const configured = (env.BUN_CHROME_PATH ?? "").trim();
  if (configured !== "") return exists(configured) ? configured : null;
  for (const name of CANDIDATE_BINARIES) {
    const found = which(name);
    if (found !== null && found !== "") return found;
  }
  for (const path of MAC_INSTALL_PATHS) {
    if (exists(path)) return path;
  }
  return null;
}

export interface ChromeProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DiagnoseChromeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveBinary?: typeof resolveChromeBinary;
  /** Injectable runner so tests never spawn a browser. */
  readonly runProbe?: (argv: readonly string[]) => Promise<ChromeProbeResult>;
  readonly timeoutMs?: number;
}

async function runChromeProbe(
  argv: readonly string[],
  timeoutMs: number,
): Promise<ChromeProbeResult> {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill(9);
    } catch {
      // Already exited.
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);
    return { exitCode: exitCode ?? null, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function lastLines(text: string, limit = 8): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-limit)
    .join("\n");
}

const REASON: Record<ChromeFailureClass, string> = {
  "sandbox-denied":
    "Chrome could not initialize its own sandbox (Operation not permitted). This happens when Chrome is launched inside a restrictive agent/CI sandbox.",
  "gpu-denied":
    "Chrome's GPU process was killed at startup (a symptom of the same sandbox denial).",
  "crashpad-denied":
    "Chrome's Crashpad handler could not write its dump directory (Operation not permitted).",
  "profile-locked":
    "Chrome's user-data directory is already in use by another browser process.",
  "not-found":
    "No Chrome/Chromium executable was found (BUN_CHROME_PATH, PATH, or the standard install paths).",
  "launch-failed": "Chrome exited before the DevTools pipe was ready.",
  unknown: "Chrome exited without a recognizable error on stderr.",
};

/** Run a minimal headless page load and classify why it does or does not work. */
export async function diagnoseChromeBackend(
  options: DiagnoseChromeOptions = {},
): Promise<ChromeBackendDiagnosis> {
  const resolveBinary = options.resolveBinary ?? resolveChromeBinary;
  const binary = resolveBinary(options.env ?? Bun.env);
  if (binary === null) {
    return {
      available: false,
      binary: null,
      failure: "not-found",
      reason: REASON["not-found"],
      stderrTail: "",
      exitCode: null,
    };
  }
  const runProbe =
    options.runProbe ??
    ((argv: readonly string[]) =>
      runChromeProbe(argv, options.timeoutMs ?? 20_000));
  const store = await mkdtemp(join(tmpdir(), "bun-chrome-diagnose-"));
  let probe: ChromeProbeResult;
  try {
    probe = await runProbe([
      binary,
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${store}`,
      "--dump-dom",
      "about:blank",
    ]);
  } catch (error) {
    return {
      available: false,
      binary,
      failure: "launch-failed",
      reason: `${REASON["launch-failed"]} (${error instanceof Error ? error.message : String(error)})`,
      stderrTail: "",
      exitCode: null,
    };
  } finally {
    await rm(store, { recursive: true, force: true });
  }
  const failure =
    probe.exitCode === 0 ? "unknown" : classifyChromeFailure(probe.stderr);
  return {
    available: probe.exitCode === 0 && failure === "unknown",
    binary,
    failure,
    reason: REASON[failure],
    stderrTail: lastLines(probe.stderr),
    exitCode: probe.exitCode,
  };
}

/**
 * Actionable lines for a failed WebView login. Deliberately does not suggest `--no-sandbox`:
 * disabling the browser's sandbox to make a credential login pass is not a fix.
 */
export function chromeFailureAdvice(
  diagnosis: ChromeBackendDiagnosis,
): readonly string[] {
  const advice: string[] = [];
  if (diagnosis.failure === "not-found") {
    return [
      "Install Google Chrome/Chromium, or point BUN_CHROME_PATH at the executable.",
      "If a WebView profile already holds the cookies, export it instead:",
      "  bun run session:login --from-profile <dir>",
    ];
  }
  if (
    diagnosis.failure === "sandbox-denied" ||
    diagnosis.failure === "gpu-denied" ||
    diagnosis.failure === "crashpad-denied"
  ) {
    advice.push(
      "Run the login in a normal terminal (outside the agent/harness sandbox); the sandbox blocks Chrome's own sandbox.",
      "Do not add --no-sandbox: that disables the browser's security boundary rather than fixing the denial.",
      "If a WebView profile already holds the cookies, export it instead:",
      "  bun run session:login --from-profile <dir>",
    );
  } else if (diagnosis.failure === "profile-locked") {
    advice.push(
      "Quit the Chrome instance using that profile (or pass a fresh dataStore) and retry.",
    );
  } else {
    advice.push(
      "Re-run the probe with stderr visible to see the cause:",
      "  bun run session:status --diagnose",
    );
  }
  if (diagnosis.available) advice.length = 0;
  return advice;
}
