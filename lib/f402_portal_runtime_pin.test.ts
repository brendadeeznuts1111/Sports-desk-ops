import { describe, expect, test } from "bun:test";

import {
  compareRuntimePin,
  readCurrentPortalRuntimePin,
} from "./f402_portal_runtime_pin.ts";

describe("portal runtime pin", () => {
  test("readCurrentPortalRuntimePin includes webkit jsc revision", () => {
    const pin = readCurrentPortalRuntimePin();
    expect(pin.bunVersion).toBe(Bun.version);
    expect<string | undefined>(pin.jscRevision).toBe(process.versions.webkit);
    expect(pin.bunRevision).toBe(Bun.revision);
  });

  test("compareRuntimePin detects version mismatch", () => {
    const live = readCurrentPortalRuntimePin();
    const drift = compareRuntimePin({ ...live, bunVersion: "0.0.0" }, live);
    expect(drift.length).toBeGreaterThan(0);
  });
});
