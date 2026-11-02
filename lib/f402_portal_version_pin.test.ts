import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  loadPinnedManifest,
  sha256HexFile,
} from "./f402_portal_version_pin.ts";

describe("portal version pin manifest", () => {
  test("pinned version.js on disk matches manifest sha256", async () => {
    const manifest = await loadPinnedManifest();
    const pinned = manifest.artifacts["app/setting/version.js"]?.sha256;
    if (pinned === undefined) {
      throw new Error("manifest missing app/setting/version.js sha256");
    }
    const path = join(
      import.meta.dir,
      "../verification/manager-boot-oracle/pinned/version.js",
    );
    const live = await sha256HexFile(path);
    expect(live).toBe(pinned);
  });
});
