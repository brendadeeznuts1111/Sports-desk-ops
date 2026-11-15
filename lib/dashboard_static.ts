/**
 * Static serving for the React dashboard build (`dist/dashboard`).
 *
 * The build is immutable for the life of a process: Vite emits hashed asset names and a single
 * `index.html`. So the file set is scanned once (lazily, memoized per root) instead of being
 * stat'ed per request, and the cache policy is derived from the path shape:
 *
 *   - hashed `chunk-<hash>.js|css` → one year, immutable
 *   - `index.html`                  → `no-cache` (the name is stable, the contents are not)
 *   - everything else               → one hour
 *
 * Existence comes from that scan, never from the request string, so a traversal path can only miss
 * the index and fall through to the SPA/404 branch — it cannot name a file outside the build.
 * Extension-less misses return `index.html` (client routing); a miss with a `.` returns null so the
 * caller answers 404 rather than serving HTML under a `text/javascript` request.
 */
import { Glob } from "bun";
import { resolve } from "node:path";

const indexCache = new Map<string, Promise<Map<string, string>>>();

const IMMUTABLE: Record<string, string> = {
  "Cache-Control": "public, max-age=31536000, immutable",
};
const NO_CACHE: Record<string, string> = { "Cache-Control": "no-cache" };
const ONE_HOUR: Record<string, string> = {
  "Cache-Control": "public, max-age=3600",
};

function cacheFor(path: string): Record<string, string> {
  if (/-[a-z0-9]{6,}\.(?:js|css)$/i.test(path)) return IMMUTABLE;
  if (path === "/index.html") return NO_CACHE;
  return ONE_HOUR;
}

/** The index maps request paths (`/chunk-abc.js`) to absolute files. */
async function indexFor(root: string): Promise<Map<string, string>> {
  let pending = indexCache.get(root);
  if (!pending) {
    pending = (async () => {
      const index = new Map<string, string>();
      for await (const file of new Glob("**/*").scan(root)) {
        index.set(`/${file}`, resolve(root, file));
      }
      return index;
    })();
    indexCache.set(root, pending);
  }
  return pending;
}

export type DashboardStaticOptions = {
  /** The `dist/dashboard` directory. */
  root: string;
  /** Extra headers merged onto every response (for example the daemon's CORS set). */
  headers?: Record<string, string>;
};

/**
 * Serve one dashboard request, or return null when the caller should answer 404.
 *
 * `pathname` is the URL path relative to the dashboard mount (`/` is the app root).
 */
export async function serveDashboardAsset(
  pathname: string,
  options: DashboardStaticOptions,
): Promise<Response | null> {
  const path = pathname === "/" ? "/index.html" : pathname;
  if (path.includes("\0") || path.split("/").includes("..")) return null;

  const index = await indexFor(options.root);
  const file = index.get(path);
  if (file) {
    return new Response(Bun.file(file), {
      headers: { ...cacheFor(path), ...options.headers },
    });
  }

  if (!path.includes(".")) {
    const indexFile = index.get("/index.html");
    if (indexFile) {
      return new Response(Bun.file(indexFile), {
        headers: { ...NO_CACHE, ...options.headers },
      });
    }
  }

  return null;
}

/** Test hook: forget the memoized indexes. */
export function resetDashboardStaticCache(): void {
  indexCache.clear();
}
