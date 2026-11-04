/**
 * Path containment for the `/assets/*` handler.
 *
 * Extracted because it is a pure decision — name plus directory in, path or null out — and because
 * it has to be tested against cases the route cannot easily produce (symlinks that escape).
 *
 * Why it matters on this Bun: the docs for directory routes say a symlink never leads out of
 * `dir` (openat2 RESOLVE_IN_ROOT semantics). Measured on 1.4.4 / macOS, it does. A symlink at
 * `assets/link.txt` pointing outside the directory is served with the outside file's content, for
 * both absolute and relative targets:
 *
 *   /assets/abs-link.txt  200  "SECRET-OUTSIDE"
 *   /assets/rel-link.txt  200  "SECRET-OUTSIDE"
 *
 * `docs/assets` has no symlinks today, so nothing leaks; this function keeps it that way rather
 * than relying on the platform.
 */

import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Decode the URL path segment used as an asset name.
 *
 * A browser percent-encodes spaces and non-ASCII file names, so the raw `URL.pathname` slice is not
 * a file name: `/assets/arch%20guide.png` must be looked up as `arch guide.png`. Returns null for a
 * malformed escape (`%E0%A4%A`), which is a client error, not a 500.
 */
export function decodeAssetName(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Reject names that cannot be a file under the directory, before touching the filesystem. */
export function isSafeAssetName(name: string): boolean {
  if (name === "" || name.includes("..")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === "\\") return false;
  }
  return !name.startsWith("/");
}

/**
 * The real path to serve, or null when the name is unsafe, missing, or resolves outside `dir`.
 *
 * `name` is a URL path segment, so it is decoded first (`arch%20guide.png` → `arch guide.png`);
 * a malformed escape is simply not a name this handler can serve. `realpath` is what catches a
 * symlink: the lexical check above cannot see one, and neither can `Bun.file(...).exists()`.
 */
export function containedAssetPath(dir: string, name: string): string | null {
  const decoded = decodeAssetName(name);
  if (decoded === null || !isSafeAssetName(decoded)) return null;
  let resolvedDir: string;
  let resolvedFile: string;
  try {
    resolvedDir = realpathSync(dir);
    resolvedFile = realpathSync(join(dir, decoded));
  } catch {
    return null; // missing, dangling link, or an unreadable parent
  }
  const fromDir = relative(resolvedDir, resolvedFile);
  if (fromDir === "" || fromDir.startsWith("..") || fromDir.startsWith(sep))
    return null;
  return resolvedFile;
}
