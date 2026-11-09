/**
 * Resolve sportsdesk-ops checkout path for bundle config (dependency-free).
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PARENT = join(BUNDLE_DIR, "..");

const REPO_PATH_HELP =
  "Set repoPath in the bundle row config to the absolute path of a sportsdesk-ops checkout. " +
  "Market git install only provides the bundle subdirectory; tools shell the monorepo with cwd=repoPath.";

/** Root package names that identify this monorepo (npm workspace name may differ from catalog label). */
const REPO_ROOT_NAMES = new Set(["sportsdesk-ops"]);

/**
 * @param {unknown} rawRepoPath
 * @returns {string}
 */
export function resolveConfiguredRepoPath(rawRepoPath) {
  const trimmed =
    typeof rawRepoPath === "string" && rawRepoPath.trim() !== ""
      ? rawRepoPath.trim()
      : "";
  if (trimmed !== "") {
    assertSportsdeskCheckout(trimmed);
    return trimmed;
  }
  const pkgPath = join(BUNDLE_PARENT, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const name = JSON.parse(readFileSync(pkgPath, "utf8")).name;
      if (REPO_ROOT_NAMES.has(name)) {
        return BUNDLE_PARENT;
      }
    } catch {
      // fall through
    }
  }
  throw new Error(`repoPath is required. ${REPO_PATH_HELP}`);
}

/**
 * @param {string} repoPath
 */
function assertSportsdeskCheckout(repoPath) {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(
      `repoPath "${repoPath}" is not a sportsdesk-ops checkout (missing package.json). ${REPO_PATH_HELP}`,
    );
  }
  let name;
  try {
    name = JSON.parse(readFileSync(pkgPath, "utf8")).name;
  } catch {
    throw new Error(
      `repoPath "${repoPath}" package.json is unreadable. ${REPO_PATH_HELP}`,
    );
  }
  if (!REPO_ROOT_NAMES.has(name)) {
    throw new Error(
      `repoPath "${repoPath}" is not a sportsdesk-ops checkout (package.json name is "${String(name)}"). ${REPO_PATH_HELP}`,
    );
  }
}
