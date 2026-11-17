import { describe, expect, test } from "bun:test";
import {
  managerBundleDrift,
  parseManagerBundleVersion,
} from "./manager_bundle.ts";

describe("manager bundle version", () => {
  test("parses the footer data-field version", () => {
    const html = `<span class="Version"></span> $0
<span data-field="version">1.0.287</span>`;
    expect(parseManagerBundleVersion(html)).toBe("1.0.287");
  });

  test("returns null when the field is absent", () => {
    expect(parseManagerBundleVersion("<footer>no version</footer>")).toBeNull();
  });

  test("reports drift against the pin without changing it", () => {
    const html = `<span data-field="version">1.0.287</span>`;
    expect(managerBundleDrift(html, "1.0.280")).toEqual({
      observed: "1.0.287",
      pinned: "1.0.280",
      drift: true,
    });
    expect(managerBundleDrift(html, "1.0.287")?.drift).toBe(false);
  });
});
