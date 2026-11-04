/**
 * Bun.Terminal PTY helpers — spawn-scoped and reusable terminals.
 *
 * @see {@link BUN_TERMINAL_V14_BLOG_URL}
 * @see {@link BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL} (write · resize · colored output · #25415 #29522)
 * @see {@link BUN_TERMINAL_DOCS}
 * @see tests/cli_terminal_automation.test.ts
 */

import { bunUrl, textFragment } from "./bun_urls.ts";

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
