/** Environment capability probes for suites that need real OS facilities. */
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ManagedWebView } from "../../scripts/capture/webview.ts";

export interface CapabilityDiagnostics {
  readonly cdp: { readonly available: boolean; readonly reason: string };
  readonly pty: { readonly available: boolean; readonly reason: string };
  readonly secretsWrite: {
    readonly available: boolean;
    readonly reason: string;
  };
  readonly chromeProfile: {
    readonly available: boolean;
    readonly reason: string;
  };
}

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

async function runCdpProbe(): Promise<CapabilityDiagnostics["cdp"]> {
  let view: ReturnType<typeof ManagedWebView.launch> | undefined;
  try {
    view = ManagedWebView.launch({
      backend: "chrome",
      width: 200,
      height: 150,
    });
    await withTimeout(view.navigate("about:blank"), 5_000, "CDP navigate");
    return {
      available: true,
      reason: "chrome backend instantiated and navigated",
    };
  } catch (error) {
    return {
      available: false,
      reason: `chrome/CDP unavailable: ${String(error).slice(0, 160)}`,
    };
  } finally {
    if (view !== undefined) {
      await withTimeout(view.close(), 3_000, "CDP close").catch(
        () => undefined,
      );
    }
  }
}

async function probeCdp(): Promise<CapabilityDiagnostics["cdp"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<CapabilityDiagnostics["cdp"]>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            available: false,
            reason: "CDP probe timed out (2500ms)",
          }),
        2_500,
      );
      timer.unref?.();
    });
    return await Promise.race([runCdpProbe(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Release a PTY-backed child completely: close the terminal master (`/dev/ptmx` fd), signal the
 * child only while it is still running, and reap it before the next probe. A probe that only kills
 * the child leaves the PTY master open, leaking one descriptor per run. Cleanup never throws.
 */
export async function closePtyProcess(
  proc: ReturnType<typeof Bun.spawn> | undefined,
): Promise<void> {
  if (proc === undefined) return;
  try {
    proc.terminal?.close();
  } catch {
    /* the terminal was never allocated, or was already closed */
  }
  if (proc.exitCode === null) {
    try {
      proc.kill();
    } catch {
      /* exited between the exitCode check and the signal */
    }
  }
  try {
    await proc.exited;
  } catch {
    /* the process died from a signal; exited is still settled and the child is reaped */
  }
}

async function probePty(): Promise<CapabilityDiagnostics["pty"]> {
  try {
    const fd = openSync("/dev/ptmx", constants.O_RDWR | constants.O_NOCTTY);
    closeSync(fd);
  } catch (error) {
    return {
      available: false,
      reason: `/dev/ptmx unavailable: ${String(error).slice(0, 120)}`,
    };
  }
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      terminal: { cols: 80, rows: 24, data() {} },
      stdout: "ignore",
      stderr: "ignore",
    });
    await withTimeout(proc.exited, 5_000, "PTY child");
    return {
      available: true,
      reason: "Bun.spawn terminal allocation succeeded",
    };
  } catch (error) {
    return {
      available: false,
      reason: `PTY spawn unavailable: ${String(error).slice(0, 120)}`,
    };
  } finally {
    await closePtyProcess(proc);
  }
}

async function probeSecretsWrite(): Promise<
  CapabilityDiagnostics["secretsWrite"]
> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      reason: "Bun.secrets keychain probe is darwin-only",
    };
  }
  if (Bun.env.CI) {
    return {
      available: false,
      reason: "Bun.secrets keychain probe skipped under CI",
    };
  }
  const service = "dx-probe";
  const name = Bun.randomUUIDv7();
  const script = [
    `const service = process.env.DX_PROBE_SERVICE!;`,
    `const name = process.env.DX_PROBE_NAME!;`,
    `try {`,
    `  await Bun.secrets.set({ service, name, value: "v" });`,
    `  const got = await Bun.secrets.get({ service, name });`,
    `  console.log(got === "v" ? "OK" : "EMPTY");`,
    `} finally {`,
    `  await Bun.secrets.delete({ service, name }).catch(() => undefined);`,
    `}`,
  ].join("\n");
  const proc = Bun.spawnSync(
    [process.execPath, "--no-env-file", "-e", script],
    {
      env: {
        ...Bun.env,
        NO_COLOR: "1",
        DX_PROBE_SERVICE: service,
        DX_PROBE_NAME: name,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1_500,
    },
  );
  if (proc.exitedDueToTimeout) {
    return {
      available: false,
      reason: "Bun.secrets keychain probe timed out after 1500ms",
    };
  }
  if (proc.exitCode === 0 && proc.stdout.toString().trim() === "OK") {
    return {
      available: true,
      reason: "Bun.secrets set/get round-trip succeeded",
    };
  }
  const detail = proc.stderr.toString().trim() || `exit ${proc.exitCode}`;
  return {
    available: false,
    reason: `Bun.secrets write denied: ${detail.slice(0, 120)}`,
  };
}

function chromeProfileDirs(): string[] {
  const configured = (Bun.env.CHROME_PROFILE_DIR ?? "").trim();
  if (configured !== "") return [configured];
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library/Application Support/Google/Chrome"),
      join(home, "Library/Application Support/Chromium"),
      join(home, "Library/Application Support/Microsoft Edge"),
    ];
  }
  if (process.platform === "win32") {
    const local = Bun.env.LOCALAPPDATA ?? home;
    return [
      join(local, "Google/Chrome/User Data"),
      join(local, "Chromium/User Data"),
    ];
  }
  return [join(home, ".config/google-chrome"), join(home, ".config/chromium")];
}

function probeChromeProfile(): CapabilityDiagnostics["chromeProfile"] {
  for (const dir of chromeProfileDirs()) {
    if (!existsSync(dir)) continue;
    for (const candidate of [
      join(dir, "Default/Cookies"),
      join(dir, "Default/Network/Cookies"),
      join(dir, "Cookies"),
    ]) {
      if (existsSync(candidate)) {
        return {
          available: true,
          reason: `readable Chrome cookie DB at ${candidate}`,
        };
      }
    }
  }
  return {
    available: false,
    reason: "no Chrome/Chromium profile with a Cookies DB found",
  };
}

const cdp = await probeCdp();
const pty = await probePty();
const secretsWrite = await probeSecretsWrite();
const chromeProfile = probeChromeProfile();

export const capabilityDiagnostics: CapabilityDiagnostics = {
  cdp,
  pty,
  secretsWrite,
  chromeProfile,
};
export const hasCdp: boolean = cdp.available;
export const hasPty: boolean = pty.available;
export const hasSecretsWrite: boolean = secretsWrite.available;
export const hasChromeProfile: boolean = chromeProfile.available;
