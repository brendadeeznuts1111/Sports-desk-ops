/**
 * Bun.Terminal PTY helpers — spawn-scoped and reusable terminals.
 *
 * @see {@link BUN_TERMINAL_V14_BLOG_URL}
 * @see {@link BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL} (write · resize · colored output · #25415 #29522)
 * @see {@link BUN_TERMINAL_DOCS}
 * @see tests/cli_terminal_automation.test.ts
 */

import { bunUrl, textFragment } from "./bun_urls.ts";
import {
  type Feature,
  type BuildTarget,
  BUILD_FEATURES,
} from "../types/features.ts";

export const BUN_TERMINAL_DOCS = bunUrl(
  "/docs/runtime/child-process#terminal-pty-support",
);

export const BUN_TERMINAL_V14_BLOG_URL = bunUrl("/blog/bun-v1.4#bun-terminal");

export const BUN_TERMINAL_V14_BLOG_SHIP_NOTE =
  "Bun.Terminal is a built-in pseudo-terminal, so you can drive bash, vim, or htop from JavaScript without node-pty. Pass terminal to Bun.spawn, write input, resize, and read the colored output. It works on Linux, macOS, and Windows." as const;

/** v1.4 blog capability line (#25415, #29522); {@link BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL} links to it. */
export const BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE =
  "Pass terminal to Bun.spawn, write input, resize, and read the colored output. It works on Linux, macOS, and Windows. #25415 #29522" as const;

export const BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL = bunUrl(
  `/blog/bun-v1.4#bun-terminal${textFragment({ start: BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE })}`,
);

/** Verbatim Bun v1.4 blog — {@link runBlogTerminalWriteHelloExample} implements the write line. */
export const BUN_TERMINAL_SPAWN_PTY_EXAMPLE =
  `const proc = Bun.spawn(["bash"], {
  terminal: {
    cols: 80,
    rows: 24,
    data(term, data) {
      process.stdout.write(data);
    },
  },
});

proc.terminal.write("echo Hello from PTY!\\n");` as const;

/** `proc.terminal.write(...)` payload from {@link BUN_TERMINAL_SPAWN_PTY_EXAMPLE}. */
export const BUN_TERMINAL_SPAWN_PTY_WRITE_PAYLOAD =
  "echo Hello from PTY!\n" as const;

export interface SpawnInPtyOptions {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtyRunResult {
  readonly code: number;
  readonly out: string;
}

export interface SpawnInPtyUntilOptions extends SpawnInPtyOptions {
  /** Stop waiting after this many ms and SIGTERM the child (interactive TUIs). */
  readonly maxMs?: number;
  /** Resolve early when captured output matches (after ANSI strip). */
  readonly untilOutput?: RegExp;
}

/** PTY watch outcome — `killed` is meaningful only when `mode` is `watch`. */
export type PtyRunUntilResult = PtyRunResult & {
  readonly rawBytes: number;
} & (
    | { readonly mode: "simple"; readonly killed: false }
    | { readonly mode: "watch"; readonly killed: boolean }
  );

/** Narrow `proc.terminal` after `Bun.spawn({ terminal })` — boundary guard. */
export function requireSubprocessTerminal(proc: {
  readonly terminal?: unknown;
}): { write: (input: string) => number; close: () => void } {
  const terminal = proc.terminal;
  if (terminal === undefined || terminal === null) {
    throw new Error(
      "Subprocess has no terminal handle; pass terminal to Bun.spawn",
    );
  }
  return terminal as { write: (input: string) => number; close: () => void };
}

/** Strip CR and SGR escapes from PTY capture (assertions on plain text). */
export function stripPtyCapture(raw: string): string {
  // eslint-disable-next-line no-control-regex -- PTY tests assert on plain text
  return raw.replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Runnable blog snippet — spawn bash PTY 80×24, write hello command, capture output. */
export async function runBlogTerminalWriteHelloExample(): Promise<PtyRunResult> {
  let raw = "";
  const proc = Bun.spawn(["bash"], {
    terminal: {
      cols: 80,
      rows: 24,
      data(_term, data) {
        raw += data;
      },
    },
  });
  const terminal = requireSubprocessTerminal(proc);
  terminal.write(BUN_TERMINAL_SPAWN_PTY_WRITE_PAYLOAD);
  // Blog leaves interactive bash at a prompt; tests send exit so proc.exited settles.
  terminal.write("exit\n");
  const code = await proc.exited;
  terminal.close();
  return { code, out: stripPtyCapture(raw) };
}

/** Run a command under a PTY; strip CR and ANSI escapes from captured output. */
export async function spawnInPty(
  cmd: readonly string[],
  options: SpawnInPtyOptions = {},
): Promise<PtyRunResult> {
  const run = await spawnInPtyUntil(cmd, options);
  return { code: run.code, out: run.out };
}

/**
 * PTY spawn for interactive programs — optional timeout/kill and early exit when output matches.
 */
export async function spawnInPtyUntil(
  cmd: readonly string[],
  options: SpawnInPtyUntilOptions = {},
): Promise<PtyRunUntilResult> {
  let raw = "";
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? process.cwd(),
    terminal: {
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      data(_terminal, data) {
        raw += data;
      },
    },
  });

  const maxMs = options.maxMs ?? 0;
  const needsWatch = maxMs > 0 || options.untilOutput !== undefined;
  let killed = false;

  if (needsWatch) {
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        const started = Date.now();
        const tick = (): void => {
          const plain = stripPtyCapture(raw);
          if (options.untilOutput?.test(plain)) {
            killed = true;
            proc.kill();
            resolve();
            return;
          }
          if (maxMs > 0 && Date.now() - started >= maxMs) {
            killed = true;
            proc.kill();
            resolve();
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      }),
    ]);
  }

  const code = await proc.exited;
  requireSubprocessTerminal(proc).close();
  const out = stripPtyCapture(raw);
  if (needsWatch) {
    return { code, out, rawBytes: raw.length, mode: "watch", killed };
  }
  return { code, out, rawBytes: raw.length, mode: "simple", killed: false };
}

/** Blog pattern: drive an shell with `terminal.write` lines (each should end with `\n`). */
export async function driveBashScript(
  lines: readonly string[],
  options?: SpawnInPtyOptions,
): Promise<PtyRunResult> {
  let raw = "";
  const proc = Bun.spawn(["bash"], {
    cwd: options?.cwd ?? process.cwd(),
    terminal: {
      cols: options?.cols ?? 80,
      rows: options?.rows ?? 24,
      data(_terminal, data) {
        raw += data;
      },
    },
  });
  const terminal = requireSubprocessTerminal(proc);
  for (const line of lines) {
    terminal.write(line.endsWith("\n") ? line : `${line}\n`);
  }
  const code = await proc.exited;
  terminal.close();
  return { code, out: stripPtyCapture(raw) };
}

export interface SpawnBunInPtyOptions extends SpawnInPtyOptions {
  readonly features?: readonly Feature[];
  readonly target?: BuildTarget;
}

/**
 * Spawns a Bun script inside a native Bun.Terminal PTY with type-safe compile-time feature flags.
 * Flags are placed before the script as `--feature=FLAG` to ensure safe CLI option parsing.
 */
export async function spawnBunInPty(
  scriptPath: string,
  scriptArgs: readonly string[] = [],
  options: SpawnBunInPtyOptions = {},
): Promise<PtyRunResult> {
  let resolvedFeatures: readonly Feature[] = [];
  if (options.target && Object.hasOwn(BUILD_FEATURES, options.target)) {
    resolvedFeatures = BUILD_FEATURES[options.target];
  } else if (options.features) {
    resolvedFeatures = options.features;
  }

  const featureArgs = resolvedFeatures.map((f) => `--feature=${f}`);
  const fullCmd = [process.execPath, ...featureArgs, scriptPath, ...scriptArgs];

  return await spawnInPty(fullCmd, options);
}

/** Accepted input data types for writing to a terminal. */
export type TerminalInputData = Parameters<Bun.Terminal["write"]>[0];

/** Thrown when a terminal session operation times out. */
export class TerminalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalTimeoutError";
  }
}

/** Thrown when a command is rejected by session authorization policy. */
export class TerminalUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnauthorizedError";
  }
}

/** Audit event emitted by TerminalSession lifecycle transitions. */
export type TerminalAuditEvent =
  | {
      readonly type: "start";
      readonly cmd: readonly string[];
      readonly pid: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "write";
      readonly bytes: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "resize";
      readonly cols: number;
      readonly rows: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "pty_close";
      readonly ptyCode: number;
      readonly signal: string | null;
      readonly timestamp: number;
    }
  | {
      readonly type: "exit";
      readonly exitCode: number;
      readonly durationMs: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "stop";
      readonly signal: "SIGTERM" | "SIGKILL";
      readonly timestamp: number;
    }
  | {
      readonly type: "timeout";
      readonly timeoutMs: number;
      readonly timestamp: number;
    };

/** Options for configuring a TerminalSession instance. */
export interface TerminalSessionOptions {
  /** Initial columns (default: 80). */
  readonly cols?: number;
  /** Initial rows (default: 24). */
  readonly rows?: number;
  /** Working directory (default: process.cwd()). */
  readonly cwd?: string;
  /** Environment variables. TERM defaults to "xterm-256color". */
  readonly env?: Record<string, string | undefined>;
  /** Overall session timeout in milliseconds (0 or undefined for no timeout). */
  readonly timeoutMs?: number;
  /** Compile-time feature flags to forward when executing bun. */
  readonly features?: readonly Feature[];
  /** Compile-time build target to forward when executing bun. */
  readonly target?: BuildTarget;
  /** Callback fired on data received from PTY (multiplexed stdout and stderr). */
  readonly onData?: (chunk: string, rawBytes: Uint8Array) => void;
  /** Callback fired when the PTY stream closes (ptyCode: 0 for EOF, 1 for error). */
  readonly onPtyClose?: (ptyCode: number, signal: string | null) => void;
  /** Authorization hook before process starts. Return false or throw to abort. */
  readonly authorize?: (cmd: readonly string[]) => boolean | Promise<boolean>;
  /** Audit log callback for session events. */
  readonly audit?: (event: TerminalAuditEvent) => void;
}

/**
 * TerminalSession provides an agent-friendly, interactive pseudo-terminal abstraction
 * with explicit lifecycle management: start, write, resize, stop, and async dispose.
 *
 * Distinctions preserved:
 * 1. Process vs PTY: `proc.exited` determines process completion; PTY `exit` callback
 *    only describes stream lifecycle (EOF vs error).
 * 2. Raw vs Text: stdout/stderr are combined in the raw PTY stream. Raw ANSI codes are
 *    preserved in `.raw` for terminal replay; `.text` strips escapes for assertions.
 * 3. Resource safety: implements `[Symbol.asyncDispose]` for seamless `await using`.
 */
export class TerminalSession implements AsyncDisposable {
  private _proc: ReturnType<typeof Bun.spawn> | null = null;
  private _term: Bun.Terminal | null = null;
  private _raw: string = "";
  private readonly _decoder = new TextDecoder();
  private _exitCode: number | null = null;
  private _ptyExitCode: number | null = null;
  private _startedAt: number = 0;
  private _exitedAt: number = 0;
  private _cmd: readonly string[] = [];
  private readonly _auditEvents: TerminalAuditEvent[] = [];
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _listeners: Array<(chunk: string) => void> = [];

  constructor(private readonly _options: TerminalSessionOptions = {}) {}

  /** Static factory to create and start a terminal session in one step. */
  static async start(
    cmd: readonly string[],
    options: TerminalSessionOptions = {},
  ): Promise<TerminalSession> {
    const session = new TerminalSession(options);
    await session.start(cmd);
    return session;
  }

  /**
   * Static factory to spawn a Bun script in a PTY with type-safe compile-time feature flags.
   */
  static async startBun(
    scriptPath: string,
    scriptArgs: readonly string[] = [],
    options: TerminalSessionOptions = {},
  ): Promise<TerminalSession> {
    let resolvedFeatures: readonly Feature[] = [];
    if (options.target && Object.hasOwn(BUILD_FEATURES, options.target)) {
      resolvedFeatures = BUILD_FEATURES[options.target];
    } else if (options.features) {
      resolvedFeatures = options.features;
    }
    const featureArgs = resolvedFeatures.map((f) => `--feature=${f}`);
    const fullCmd = [
      process.execPath,
      ...featureArgs,
      scriptPath,
      ...scriptArgs,
    ];
    return await TerminalSession.start(fullCmd, options);
  }

  /** Starts the subprocess attached to the PTY. */
  async start(cmd: readonly string[]): Promise<void> {
    if (this._proc !== null) {
      throw new Error("TerminalSession is already started");
    }

    if (this._options.authorize) {
      const allowed = await this._options.authorize(cmd);
      if (!allowed) {
        throw new TerminalUnauthorizedError(
          `Command execution rejected by authorization policy: ${cmd.join(" ")}`,
        );
      }
    }

    this._cmd = [...cmd];
    this._startedAt = Date.now();

    const term = new Bun.Terminal({
      cols: this._options.cols ?? 80,
      rows: this._options.rows ?? 24,
      data: (_terminal, chunk) => {
        const text = this._decoder.decode(chunk, { stream: true });
        this._raw += text;
        this._options.onData?.(text, chunk);
        for (const listener of this._listeners) {
          listener(text);
        }
      },
      exit: (_terminal, ptyCode, signal) => {
        this._ptyExitCode = ptyCode;
        this._options.onPtyClose?.(ptyCode, signal);
        this._emitAudit({
          type: "pty_close",
          ptyCode,
          signal,
          timestamp: Date.now(),
        });
      },
    });

    const env = {
      ...process.env,
      TERM: "xterm-256color",
      ...this._options.env,
    };

    const proc = Bun.spawn([...cmd], {
      cwd: this._options.cwd ?? process.cwd(),
      env,
      terminal: term,
    });

    this._proc = proc;
    this._term = term;

    this._emitAudit({
      type: "start",
      cmd: this._cmd,
      pid: proc.pid,
      timestamp: this._startedAt,
    });

    proc.exited.then((code) => {
      this._cleanupTimeout();
      this._exitCode = code;
      this._exitedAt = Date.now();
      const final = this._decoder.decode();
      if (final) {
        this._raw += final;
      }
      this._emitAudit({
        type: "exit",
        exitCode: code,
        durationMs: this._exitedAt - this._startedAt,
        timestamp: this._exitedAt,
      });
    });

    if (this._options.timeoutMs && this._options.timeoutMs > 0) {
      this._timeoutTimer = setTimeout(() => {
        if (this.active) {
          this._emitAudit({
            type: "timeout",
            timeoutMs: this._options.timeoutMs!,
            timestamp: Date.now(),
          });
          this.stop("SIGTERM");
        }
      }, this._options.timeoutMs);
    }
  }

  /** Write input string or buffer to the terminal. */
  write(data: TerminalInputData): number {
    if (!this._term || this._term.closed) {
      throw new Error("Cannot write to closed terminal session");
    }
    const bytes = this._term.write(data);
    this._emitAudit({
      type: "write",
      bytes,
      timestamp: Date.now(),
    });
    return bytes;
  }

  /** Write a line of input ending with a newline. */
  writeLine(line: string = ""): number {
    return this.write(`${line}\n`);
  }

  /** Resize the pseudo-terminal window dimensions. */
  resize(cols: number, rows: number): void {
    if (!this._term || this._term.closed) {
      throw new Error("Cannot resize closed terminal session");
    }
    this._term.resize(cols, rows);
    this._emitAudit({
      type: "resize",
      cols,
      rows,
      timestamp: Date.now(),
    });
  }

  /**
   * Wait for process exit, optionally enforcing a maximum duration.
   * Returns child process exit code (from proc.exited).
   */
  async wait(timeoutMs?: number): Promise<number> {
    if (!this._proc) {
      throw new Error("TerminalSession has not been started");
    }
    const effectiveTimeout = timeoutMs ?? this._options.timeoutMs;
    if (!effectiveTimeout || effectiveTimeout <= 0) {
      return await this._proc.exited;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.stop("SIGTERM");
        reject(
          new TerminalTimeoutError(
            `Terminal session timed out after ${effectiveTimeout}ms waiting for process exit`,
          ),
        );
      }, effectiveTimeout);
    });

    try {
      return await Promise.race([this._proc.exited, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait until accumulated terminal output matches a regex or substring.
   * Useful for step-by-step TUI and interactive CLI orchestration.
   */
  async waitForOutput(
    pattern: RegExp | string,
    timeoutMs: number = 5000,
  ): Promise<string> {
    const matcher =
      typeof pattern === "string"
        ? (str: string) => str.includes(pattern)
        : (str: string) => pattern.test(str);

    if (matcher(this.text) || matcher(this.raw)) {
      return this.text;
    }

    if (!this.active) {
      throw new Error(
        `Process already exited (code ${this._exitCode}) without matching expected output`,
      );
    }

    return await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onDataListener: ((chunk: string) => void) | null = null;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (onDataListener) {
          const idx = this._listeners.indexOf(onDataListener);
          if (idx !== -1) this._listeners.splice(idx, 1);
          onDataListener = null;
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            new TerminalTimeoutError(
              `Timed out after ${timeoutMs}ms waiting for terminal output matching: ${pattern}`,
            ),
          );
        }, timeoutMs);
      }

      onDataListener = (_chunk: string) => {
        if (matcher(this.text) || matcher(this.raw)) {
          cleanup();
          resolve(this.text);
        } else if (!this.active) {
          cleanup();
          reject(
            new Error(
              `Process exited (code ${this._exitCode}) without matching expected output`,
            ),
          );
        }
      };

      this._listeners.push(onDataListener);

      if (this._proc) {
        this._proc.exited.then(() => {
          if (!matcher(this.text) && !matcher(this.raw)) {
            cleanup();
            reject(
              new Error(
                `Process exited (code ${this._exitCode}) without matching expected output`,
              ),
            );
          }
        });
      }
    });
  }

  /** Send a termination signal to the subprocess. */
  stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    if (this._proc && this.active) {
      this._emitAudit({
        type: "stop",
        signal,
        timestamp: Date.now(),
      });
      this._proc.kill(signal);
    }
  }

  /** Closes the PTY descriptor. */
  close(): void {
    this._cleanupTimeout();
    if (this._term && !this._term.closed) {
      this._term.close();
    }
  }

  /** Synchronous dispose helper. */
  dispose(): void {
    if (this.active) {
      this.stop("SIGTERM");
    }
    this.close();
  }

  /** Async dispose for `await using session = await TerminalSession.start(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.active && this._proc) {
      this.stop("SIGTERM");
      try {
        await Promise.race([
          this._proc.exited,
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
        if (this.active && this._proc) {
          this.stop("SIGKILL");
          await Promise.race([
            this._proc.exited,
            new Promise((resolve) => setTimeout(resolve, 200)),
          ]);
        }
      } catch {
        // ignore errors during cleanup
      }
    }
    this.close();
  }

  /** Combined raw ANSI output (stdout + stderr multiplexed) preserved for accurate terminal replay. */
  get raw(): string {
    return this._raw;
  }

  /** Plain text output with ANSI escapes and CRs stripped for assertions and log ingestion. */
  get text(): string {
    return stripPtyCapture(this._raw);
  }

  /** Total raw characters captured from the terminal stream. */
  get rawBytes(): number {
    return this._raw.length;
  }

  /** Subprocess exit code from `proc.exited`, or null if still running. */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /** PTY lifecycle exit code (0 for clean EOF, 1 for read error), NOT the subprocess exit code. */
  get ptyExitCode(): number | null {
    return this._ptyExitCode;
  }

  /** Whether the subprocess is currently running. */
  get active(): boolean {
    return this._proc !== null && this._exitCode === null;
  }

  /** Process ID of the spawned child process. */
  get pid(): number | undefined {
    return this._proc?.pid;
  }

  /** Duration of execution in milliseconds. */
  get durationMs(): number {
    if (this._startedAt === 0) return 0;
    if (this._exitedAt > 0) return this._exitedAt - this._startedAt;
    return Date.now() - this._startedAt;
  }

  /** Underlying Bun.Terminal handle. */
  get terminal(): Bun.Terminal | null {
    return this._term;
  }

  /** Underlying Bun Subprocess handle. */
  get subprocess(): ReturnType<typeof Bun.spawn> | null {
    return this._proc;
  }

  /** Readonly log of all recorded audit events for this session. */
  get auditEvents(): readonly TerminalAuditEvent[] {
    return this._auditEvents;
  }

  private _cleanupTimeout(): void {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  private _emitAudit(event: TerminalAuditEvent): void {
    this._auditEvents.push(event);
    this._options.audit?.(event);
  }
}
