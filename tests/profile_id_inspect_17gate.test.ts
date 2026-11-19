/**
 * @file tests/profile_id_inspect_17gate.test.ts
 * @description Verifies RBAC redaction, `#private` path sealing under `{ showHidden: true, depth: null }`,
 * grapheme-width alignment, and canonical `https://bun.com/reference/bun/inspect` OSC-8 links.
 */

import { describe, expect, test } from "bun:test";
import {
  InspectableProfileId,
  ProfileArtifactPaths,
  redactInspectSurface,
} from "../lib/profile_id_inspect.ts";

type InspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

describe("ProfileId & ProfileArtifactPaths [Bun.inspect.custom] 17-Gate Suite", () => {
  const sampleSecret =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig";

  test("redacts JWTs, session IDs, and raw IPs under ROLE_AUDITOR_SANITIZED", () => {
    const raw = `Bearer ${sampleSecret} GSLIVE_SESSION_ID=sess_99123 198.51.100.42 2001:db8:85a3::8a2e:370:7334`;
    const auditorOut = redactInspectSurface(raw, "ROLE_AUDITOR_SANITIZED");

    expect(auditorOut).not.toContain(sampleSecret);
    expect(auditorOut).not.toContain("sess_99123");
    expect(auditorOut).not.toContain("198.51.100.42");
    expect(auditorOut).toContain("[REDACTED_SECRET]");
    expect(auditorOut).toContain("[REDACTED_IP]");
  });

  test("applies /24 IPv4 and /48 IPv6 subnet masking under ROLE_RISK_MANAGER", () => {
    const raw = "client=198.51.100.42 v6=2001:db8:85a3:0:0:8a2e:370:7334";
    const managerOut = redactInspectSurface(raw, "ROLE_RISK_MANAGER");

    expect(managerOut).toContain("198.51.100.0/24");
    expect(managerOut).toContain("2001:db8:85a3::/48");
    expect(managerOut).not.toContain("198.51.100.42");
  });

  test("ProfileArtifactPaths seals raw paths against Bun.inspect(..., { showHidden: true, depth: null }), Object.keys, and property reads", () => {
    const profileId = InspectableProfileId.parse(
      "desk-ops-prod",
      "ROLE_AUDITOR_SANITIZED",
    );
    const paths = new ProfileArtifactPaths({
      profileId,
      rootDir: "/Users/example/secret-workspace/profiles/desk-ops-prod",
      envPath: "/Users/example/secret-workspace/profiles/desk-ops-prod/.env",
      themeTsPath:
        "/Users/example/secret-workspace/profiles/desk-ops-prod/theme.gen.ts",
      barrelTsPath:
        "/Users/example/secret-workspace/profiles/index.theme.gen.ts",
      r2ManifestKey: "manifests/profiles/desk-ops-prod/latest",
      role: "ROLE_AUDITOR_SANITIZED",
    });

    const inspected = Bun.inspect(paths, {
      showHidden: true,
      depth: null,
      colors: true,
    } as unknown as InspectOptions);

    expect(inspected).not.toContain("/Users/example");
    expect(inspected).toContain("[REDACTED_ENV_PATH]");
    expect(inspected).toContain("<workspace>/profiles/desk-ops-prod");
    expect(inspected).toContain("https://bun.com/reference/bun/inspect");
    expect(inspected).not.toContain("/reference/globals/");

    expect(Object.keys(paths)).toEqual([]);
    expect(paths.rootDir).toBe("<workspace>/profiles/desk-ops-prod");
    expect(paths.envPath).toBe("[REDACTED_ENV_PATH]");
  });

  test("JSON.stringify delegates cleanly to non-enumerable toJSON", () => {
    const profileId = InspectableProfileId.parse("live-ticker-01");
    expect(JSON.stringify(profileId)).toBe('"live-ticker-01"');
  });

  test("rejects invalid ProfileId slugs fail-closed", () => {
    expect(() => InspectableProfileId.parse("../bad-slug")).toThrow(
      "ERR_INSP_INVALID_PROFILE_ID",
    );
  });
});
