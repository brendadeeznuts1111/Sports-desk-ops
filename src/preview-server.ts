/**
 * @file src/preview-server.ts
 * @description Serve generated avatar files and the profile theme LUT.
 */
import type { ProfileThemeEntry } from "./pty-session.ts";

export interface ThemePreviewServerOptions {
  readonly port?: number;
  readonly avatarsDir?: string;
  readonly lut?: Readonly<Record<string, ProfileThemeEntry>>;
}

/** Start a local static avatar + theme JSON preview server. */
export function startThemePreviewServer(
  opts: ThemePreviewServerOptions = {},
): Bun.Server<undefined> {
  const avatarsDir = opts.avatarsDir ?? "./avatars";
  return Bun.serve({
    port: opts.port ?? 4173,
    routes: {
      "/avatars/*": { dir: avatarsDir },
      "/theme.json": () => Response.json(opts.lut ?? {}),
    },
  });
}
