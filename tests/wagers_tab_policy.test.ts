import { mkdtempSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearWagersTabPolicyCache,
  loadWagersTabPolicyStamp,
  wagersTabPolicyPath,
} from "../lib/wagers_tab_policy.ts";
import { WAGERS_META, WAGERS_TABLE } from "../packages/ui/src/config/wagers.ts";

const POLICY_TOML = (tag: string, schema = "sportsdesk-wagers-tab/v1") => `
[meta]
schema = "${schema}"
version = "1.0.0"
generated_at = "2026-11-14T00:00:00Z"
auto_execute = false

[thresholds]
clv_hot_cents = 10
clv_warm_cents = 3
slice_leader_limit = 4

[table]
max_rows = 300
policy_tag = "${tag}"
default_sort_field = "alertTier"
default_sort_dir = "desc"
`;

describe("wagers tab policy runtime stamp", () => {
  afterEach(() => {
    clearWagersTabPolicyCache();
    delete process.env.WAGERS_TAB_POLICY_PATH;
  });

  test("reads the committed wagers.toml and returns the probe fields", async () => {
    const stamp = await loadWagersTabPolicyStamp(
      resolve(process.cwd(), "packages/ui/src/config/wagers.toml"),
    );
    expect(stamp).toEqual({
      policy_version: WAGERS_TABLE.policy_tag,
      policy_schema: WAGERS_META.schema,
    });
    expect(stamp?.policy_version).toBe("wagers-policy/v1");
  });

  test("returns null for an absent policy file instead of breaking the feed", async () => {
    expect(
      await loadWagersTabPolicyStamp(
        resolve(tmpdir(), "sd-no-such-wagers-policy.toml"),
      ),
    ).toBeNull();
  });

  test("re-reads after an edit (stat cache, no restart) and caches otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-wagers-policy-"));
    const path = join(dir, "wagers.toml");
    try {
      await Bun.write(path, POLICY_TOML("wagers-policy/v1"));
      const first = await loadWagersTabPolicyStamp(path);
      expect(first?.policy_version).toBe("wagers-policy/v1");

      // Same mtime + content -> cache hit returns the same object identity.
      const cached = await loadWagersTabPolicyStamp(path);
      expect(cached).toBe(first);

      await Bun.write(path, POLICY_TOML("wagers-policy/v2"));
      const later = new Date(Date.now() + 5_000);
      await utimes(path, later, later);

      const refreshed = await loadWagersTabPolicyStamp(path);
      expect(refreshed?.policy_version).toBe("wagers-policy/v2");
      expect(refreshed).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when policy_tag is missing so the probe cannot silently lie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-wagers-policy-bad-"));
    const path = join(dir, "wagers.toml");
    try {
      await Bun.write(path, '[meta]\nschema = "sportsdesk-wagers-tab/v1"\n');
      await expect(loadWagersTabPolicyStamp(path)).rejects.toThrow(
        "policy_tag",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WAGERS_TAB_POLICY_PATH overrides the default checkout path", () => {
    const fallback = wagersTabPolicyPath();
    expect(fallback.endsWith("packages/ui/src/config/wagers.toml")).toBe(true);

    process.env.WAGERS_TAB_POLICY_PATH = "/tmp/custom-wagers.toml";
    expect(wagersTabPolicyPath()).toBe("/tmp/custom-wagers.toml");
  });
});
