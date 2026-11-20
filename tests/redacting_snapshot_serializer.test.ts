import { describe, expect, test } from "bun:test";
import {
  createRedactingSnapshotSerializers,
  prepareSnapshot,
  tryAddSnapshotSerializers,
} from "./serializers/redacting_snapshot_serializer.ts";

// File-local serializers apply until this file ends. The canary is not added
// to the preload set, which covers every later file.
const fileSerializers = createRedactingSnapshotSerializers({
  extraSecrets: ["AKIA_CUSTOM_CANARY_9988"],
});
const fileHooked = tryAddSnapshotSerializers(fileSerializers);

describe("redacting & normalizing snapshot serializer", () => {
  test("redacts secret keys, Bearer tokens, URL userinfo, and normalizes Bun.version and timestamps", () => {
    const payload = {
      bunVersion: Bun.version,
      generatedAt: "2026-11-20T22:35:00.123Z",
      expiresAt: new Date("2026-11-21T00:00:00.000Z"),
      auth: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        secretAccessKey: "SUPER_SECRET_R2_KEY_VALUE",
        note: "Upstream header was Bearer live_tok_12345 with AKIA_CUSTOM_CANARY_9988",
      },
      endpoint:
        "https://svc:plain_pass_123@example.r2.cloudflarestorage.com/bucket",
      ok: true,
    };

    const viewed = fileHooked
      ? payload
      : prepareSnapshot(payload, fileSerializers);

    expect(viewed).toMatchInlineSnapshot(`
      {
        "auth": {
          "authorization": "[REDACTED_SECRET]",
          "note": "Upstream header was Bearer [REDACTED_SECRET] with [REDACTED_SECRET]",
          "secretAccessKey": "[REDACTED_SECRET]",
        },
        "bunVersion": "[BUN_VERSION]",
        "endpoint": "https://[REDACTED_USER]:[REDACTED_SECRET]@example.r2.cloudflarestorage.com/bucket",
        "expiresAt": "[ISO_TIMESTAMP]",
        "generatedAt": "[ISO_TIMESTAMP]",
        "ok": true,
      }
    `);
    expect(JSON.stringify(viewed)).not.toContain("AKIA_CUSTOM_CANARY_9988");
    expect(JSON.stringify(viewed)).not.toContain("SUPER_SECRET_R2_KEY_VALUE");
    expect(JSON.stringify(viewed)).not.toContain("plain_pass_123");
    expect(JSON.stringify(viewed)).not.toContain(Bun.version);
  });

  test("does not re-enter the object serializer on the sanitized clone", () => {
    const serializer = createRedactingSnapshotSerializers()[0];
    expect(serializer).toBeDefined();
    const source = { secretAccessKey: "SUPER_SECRET_VALUE_123" };
    let sawClone = false;
    serializer!.serialize(source, {}, "", 0, [], (clone) => {
      sawClone = true;
      expect(serializer!.test(clone)).toBe(false);
      return "";
    });
    expect(sawClone).toBe(true);
  });

  test("leaves secrets shorter than 8 characters in place", () => {
    const serializers = createRedactingSnapshotSerializers({
      extraSecrets: ["short", "LONG_CANARY_SECRET"],
    });
    const strings = serializers[1];
    expect(strings).toBeDefined();
    expect(strings!.test("prefix short suffix")).toBe(false);
    expect(strings!.test("has LONG_CANARY_SECRET")).toBe(true);
    expect(
      strings!.serialize("has LONG_CANARY_SECRET", {}, "", 0, [], () => ""),
    ).toBe(JSON.stringify("has [REDACTED_SECRET]"));
  });
});
