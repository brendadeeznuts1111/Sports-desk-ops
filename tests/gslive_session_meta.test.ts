import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
  gsliveSessionMetaPath,
  readGsliveSessionMeta,
  writeGsliveSessionMeta,
} from "../lib/gslive_session_meta.ts";

describe("gslive session meta", () => {
  test("round-trips identity fields", async () => {
    const prev = Bun.env.GSLIVE_SESSION_META_FILE;
    const path = `${import.meta.dir}/../scratch/gslive-meta-roundtrip.json`;
    Bun.env.GSLIVE_SESSION_META_FILE = path;
    try {
      await writeGsliveSessionMeta({
        adminUserName: "NOLAROSE",
        partner: 118,
        updatedAt: "2026-11-09T00:00:00.000Z",
      });
      expect(gsliveSessionMetaPath()).toBe(path);
      const meta = readGsliveSessionMeta();
      expect(meta?.adminUserName).toBe("NOLAROSE");
      expect(meta?.partner).toBe(118);
    } finally {
      if (existsSync(path)) unlinkSync(path);
      if (prev === undefined) delete Bun.env.GSLIVE_SESSION_META_FILE;
      else Bun.env.GSLIVE_SESSION_META_FILE = prev;
    }
  });
});
