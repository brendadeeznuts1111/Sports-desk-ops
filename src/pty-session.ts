/**
 * @file src/pty-session.ts
 * @description Launch a profiled PTY session without node-pty. The avatar
 * banner is written to stdout; terminal.write() is reserved for child input.
 */
import { toEnvSlug, type ProfileId } from "../lib/token_automation.ts";
import {
  detectImageProtocol,
  renderTerminalAvatarFrameAsync,
  type AvatarSource,
} from "./lib/terminal_avatar.ts";

export interface ProfileThemeEntry {
  readonly colorLabel: string;
  readonly colorCss: string;
  readonly colorInt: number;
  readonly colorHex: string;
  readonly ansi16m: string;
}

export interface ProfiledPtyOptions {
  readonly profileId: ProfileId;
  readonly lut?: Readonly<Record<string, ProfileThemeEntry>>;
  readonly cmd?: readonly string[];
  readonly cwd?: string;
  readonly avatarSource?: AvatarSource;
  readonly avatarCols?: number;
  readonly avatarRows?: number;
}

async function loadDefaultLut(): Promise<
  Readonly<Record<string, ProfileThemeEntry>>
> {
  try {
    const modulePath = "./index.theme.gen.ts";
    const generated = (await import(modulePath)) as {
      PROFILE_THEME_LUT?: Readonly<Record<string, ProfileThemeEntry>>;
    };
    return generated.PROFILE_THEME_LUT ?? {};
  } catch {
    return {};
  }
}

/** Spawn a shell/viewer with PROFILE_<SLUG>_COLOR_* and a direct stdout avatar. */
export async function spawnProfiledPty(
  opts: ProfiledPtyOptions,
): Promise<Bun.Subprocess> {
  const lut = opts.lut ?? (await loadDefaultLut());
  const entry = lut[opts.profileId];
  const slug = toEnvSlug(opts.profileId);
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const protocol = detectImageProtocol();
  const frame = await renderTerminalAvatarFrameAsync(
    opts.avatarSource,
    protocol,
    { cols: opts.avatarCols ?? 2, rows: opts.avatarRows ?? 1 },
  );
  if (frame !== "") {
    await Bun.write(Bun.stdout, frame);
  }
  if (entry) {
    await Bun.write(
      Bun.stdout,
      " " +
        entry.ansi16m +
        opts.profileId +
        "\x1b[0m (" +
        entry.colorHex +
        ")\n",
    );
  }

  const proc = Bun.spawn(
    opts.cmd ? [...opts.cmd] : [process.env.SHELL ?? "bash"],
    {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ["PROFILE_" + slug + "_COLOR_LABEL"]: entry?.colorLabel ?? "",
        ["PROFILE_" + slug + "_COLOR_CSS"]: entry?.colorCss ?? "",
        ["PROFILE_" + slug + "_COLOR_INT"]: String(entry?.colorInt ?? 0),
        ["PROFILE_" + slug + "_COLOR_HEX"]: entry?.colorHex ?? "#000000",
      },
      terminal: {
        cols,
        rows,
        data(_term, data) {
          process.stdout.write(data);
        },
      },
    },
  );

  const onResize = (): void => {
    proc.terminal?.resize(
      process.stdout.columns ?? 80,
      process.stdout.rows ?? 24,
    );
  };
  process.stdout.on("resize", onResize);

  const onInput = (chunk: Uint8Array): void => {
    proc.terminal?.write(chunk);
  };
  const raw = Boolean(process.stdin.isTTY);
  if (raw) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onInput);
  }

  proc.exited.finally(() => {
    process.stdout.off("resize", onResize);
    if (raw) {
      process.stdin.off("data", onInput);
      process.stdin.setRawMode(false);
    }
  });

  return proc;
}
