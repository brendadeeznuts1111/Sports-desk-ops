import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  installedReactVersion,
  reactVersionFromManifest,
} from "../lib/react_element_version.ts";

/**
 * `Bun.markdown.react()` picks its element symbol from this value: React 19's transitional symbol
 * by default, React 18's `react.element` when told `18`. An installed major that disagrees with the
 * value renders nothing (React 18's renderer throws "Objects are not valid as a React child"), so
 * the value has to come from the installed package rather than a constant in the source.
 */

const ROOT = join(import.meta.dir, "..");

async function installedVersion(pkg: string): Promise<string> {
  const manifest = (await Bun.file(
    Bun.resolveSync(`${pkg}/package.json`, ROOT),
  ).json()) as { version?: string };
  if (manifest.version === undefined) throw new Error(`${pkg} has no version`);
  return manifest.version;
}

describe("reactVersionFromManifest", () => {
  test("maps React 18 and 19 to the selector Bun accepts", () => {
    expect(reactVersionFromManifest("18.3.1")).toBe(18);
    expect(reactVersionFromManifest("19.3.1")).toBe(19);
    // A prerelease keeps its major.
    expect(reactVersionFromManifest("19.0.0-rc.1")).toBe(19);
  });

  test("refuses a major Bun 1.4.4 has no selector for", () => {
    expect(() => reactVersionFromManifest("20.0.0")).toThrow(
      /E_UNSUPPORTED_REACT_MAJOR/,
    );
    // Also refuses a version that does not start with a number.
    expect(() => reactVersionFromManifest("next")).toThrow(
      /E_UNSUPPORTED_REACT_MAJOR/,
    );
  });

  test("names the source when the version is missing", () => {
    expect(() =>
      reactVersionFromManifest(undefined, "fixture/package.json"),
    ).toThrow(/E_REACT_VERSION_UNREADABLE: fixture\/package\.json/);
  });
});

describe("installedReactVersion", () => {
  test("returns the installed react major", async () => {
    const major = Number.parseInt(await installedVersion("react"), 10);
    // Bun 1.4.4 types the option as 18 | 19; anything else must not be guessed at.
    expect([18, 19]).toContain(major);
    // Compare as numbers: `toBe` binds its expected type to the received `18 | 19`.
    expect(Number(installedReactVersion())).toBe(major);
  });

  test("agrees with the installed react-dom that renders its elements", async () => {
    const rendererMajor = Number.parseInt(
      await installedVersion("react-dom"),
      10,
    );
    expect(Number(installedReactVersion())).toBe(rendererMajor);
  });

  test("is memoised", () => {
    expect(installedReactVersion()).toBe(installedReactVersion());
  });
});
