/**
 * The `reactVersion` that `Bun.markdown.react()` needs for the installed React.
 *
 * `Bun.markdown.react()` builds elements with `Symbol.for("react.transitional.element")` (React 19)
 * unless told otherwise, and `react-dom@18` refuses those with "Objects are not valid as a React
 * child" (and the reverse). The correct value is not a property of this repository: it is a
 * property of the installed renderer. React 18 is `18`; React 19 is `19`.
 *
 * Two call sites hard-coded `18` (`lib/markdown_react_ssr.ts`, `lib/tracker_dashboard.ts`). On
 * 2026-11-18 a `bun add react` moved the root pin to 19.3.1 against `react-dom@18.3.1`; those
 * constants were the only remaining pair that still agreed with each other. Reading the installed
 * package removes the third opinion: upgrading React moves the renderer, the pin and this switch
 * together, or the upgrade is incomplete and fails here.
 *
 * Bun 1.4.4 types the option as `18 | 19`, so any other major throws rather than passing a value
 * the runtime does not accept.
 */
import { readFileSync } from "node:fs";

let cached: 18 | 19 | undefined;

/**
 * Map a `react` package version to the element symbol selector, or throw.
 *
 * Split from {@link installedReactVersion} so the mapping (18 → 18, 19 → 19, anything else → error)
 * is testable without installing a different React. `source` only labels the error.
 *
 * @param version - the `version` field of `react/package.json`.
 * @param source - where the version came from, for the error message.
 * @throws `E_REACT_VERSION_UNREADABLE` when the version is missing.
 * @throws `E_UNSUPPORTED_REACT_MAJOR` when the major is neither 18 nor 19.
 */
export function reactVersionFromManifest(
  version: string | undefined,
  source = "react/package.json",
): 18 | 19 {
  if (version === undefined) {
    throw new Error(`E_REACT_VERSION_UNREADABLE: ${source} has no "version"`);
  }
  const major = Number.parseInt(version, 10);
  if (major !== 18 && major !== 19) {
    throw new Error(
      `E_UNSUPPORTED_REACT_MAJOR: ${source} is ${version}, but Bun.markdown.react() only selects ` +
        `React 18 and 19 element symbols (Bun 1.4.4). Upgrade the Bun pin before upgrading React ` +
        `past 19.`,
    );
  }
  return major;
}

/**
 * The installed React's major, as `Bun.markdown.react()` expects it.
 *
 * Read the first time it is needed and cached: a request path calls this per render, and the
 * installed package cannot change without a restart.
 */
export function installedReactVersion(): 18 | 19 {
  if (cached !== undefined) return cached;
  const manifestPath = Bun.resolveSync("react/package.json", import.meta.dir);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
  };
  cached = reactVersionFromManifest(manifest.version, manifestPath);
  return cached;
}
