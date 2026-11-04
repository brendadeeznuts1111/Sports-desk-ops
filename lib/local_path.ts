/**
 * Operator-supplied paths (`--out`, `--profile`, config files): a filesystem path or a `file://` URL.
 * Any other scheme is refused, so `https://…` is never read as a relative path or fetched.
 */

import { UsageError } from "./usage_error.ts";

/** Two or more letters, so a Windows drive (`C:\…`) is still a path. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export function toLocalPath(raw: string): string {
  if (raw.startsWith("file:")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UsageError(`${raw}: not a valid file:// URL`);
    }
    if (url.search !== "" || url.hash !== "") {
      throw new UsageError(
        `${raw}: a file:// URL here cannot carry a query or fragment`,
      );
    }
    return Bun.fileURLToPath(url);
  }
  const scheme = URL_SCHEME.exec(raw)?.[0];
  if (scheme !== undefined) {
    throw new UsageError(
      `${raw}: only local paths and file:// URLs are accepted, not ${scheme}`,
    );
  }
  return raw;
}
