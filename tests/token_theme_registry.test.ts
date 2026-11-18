import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoSlugCollisions,
  assertProfileId,
  assertRgb24,
  atomicWrite,
  AutomatedDualTokenStore,
  computeSnapshotFingerprint,
  normalizeColorInput,
  renderEnvFile,
  renderThemeGenTs,
  sanitizeEnvValue,
  toEnvSlug,
  type RegistryColorRow,
} from "../lib/token_automation.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { syncIfChanged, type SyncState } from "../lib/token_watch_daemon.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const row = (
  profileId: string,
  colorInt: number,
  css: string,
  label: string,
): RegistryColorRow => ({
  profile_id: assertProfileId(profileId),
  color_int: assertRgb24(colorInt),
  color_css: css,
  color_hex: `#${colorInt.toString(16).padStart(6, "0")}`,
  color_label: label,
});

describe("profile id and value validation", () => {
  test("assertProfileId accepts the schema grammar and rejects everything else", () => {
    expect(String(assertProfileId("desk-enam.01"))).toBe("desk-enam.01");
    expect(() => assertProfileId("_leading")).toThrow("ERR_TOKEN_PROFILE_ID");
    expect(() => assertProfileId("a".repeat(65))).toThrow(
      "ERR_TOKEN_PROFILE_ID",
    );
    expect(() => assertProfileId("a b")).toThrow("ERR_TOKEN_PROFILE_ID");
  });

  test("assertRgb24 rejects non-integers and out-of-range values", () => {
    expect(assertRgb24(0)).toBe(0);
    expect(assertRgb24(0xffffff)).toBe(0xffffff);
    expect(() => assertRgb24(0x1000000)).toThrow("ERR_TOKEN_RGB24");
    expect(() => assertRgb24(1.5)).toThrow("ERR_TOKEN_RGB24");
  });

  test("normalizeColorInput canonicalises the name and the label", () => {
    expect(normalizeColorInput("DodgerBlue", "sky 400!")).toEqual({
      color_int: 0x1e90ff,
      color_css: "#1e90ff",
      color_label: "sky-400",
    });
    expect(() => normalizeColorInput("not-a-colour")).toThrow(
      "ERR_TOKEN_COLOR_INVALID",
    );
  });

  test("slug collision guard catches hyphen/underscore aliases", () => {
    const rows = [
      row("desk-enam-01", 0xff0000, "red", "red"),
      row("desk_enam_01", 0x00ff00, "lime", "lime"),
    ];
    expect(toEnvSlug(rows[0]!.profile_id)).toBe("DESK_ENAM_01");
    expect(toEnvSlug(rows[1]!.profile_id)).toBe("DESK_ENAM_01");
    expect(() => assertNoSlugCollisions(rows)).toThrow(
      "ERR_TOKEN_SLUG_COLLISION",
    );
    expect(() =>
      assertNoSlugCollisions([
        row("a-b", 1, "x", "x"),
        row("a-b", 2, "y", "y"),
      ]),
    ).not.toThrow();
  });
});

describe("SQLite profile_themes registry", () => {
  test("color_hex is generated and stays in sync with color_int", () => {
    const store = new AutomatedDualTokenStore(":memory:");
    try {
      const input = normalizeColorInput("dodgerblue", "accent");
      store.upsertProfileTheme({
        profile_id: assertProfileId("desk-01"),
        color_hex: `#${input.color_int.toString(16).padStart(6, "0")}`,
        ...input,
      });
      expect(store.listProfileThemes()).toEqual([
        {
          profile_id: assertProfileId("desk-01"),
          color_int: 0x1e90ff,
          color_css: "#1e90ff",
          color_hex: "#1e90ff",
          color_label: "accent",
        },
      ]);
      // Re-upsert with a new colour: the generated column must follow.
      const next = normalizeColorInput("crimson", "alert");
      store.upsertProfileTheme({
        profile_id: assertProfileId("desk-01"),
        color_hex: `#${next.color_int.toString(16).padStart(6, "0")}`,
        ...next,
      });
      expect(store.listProfileThemes()[0]?.color_hex).toBe("#dc143c");
      // STRICT + CHECK reject a label that the branded emitter would never produce.
      expect(() =>
        store.upsertProfileTheme({
          profile_id: assertProfileId("bad-label"),
          color_int: 1,
          color_css: "red",
          color_hex: "#000001",
          color_label: "bad label",
        }),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});

describe("deterministic emission", () => {
  const rows = [
    row("desk-01", 0xff0000, "red", "critical"),
    row("ops-02", 0x1e90ff, "dodgerblue", "accent"),
  ];

  test("fingerprint is order-independent and value-sensitive", () => {
    const a = computeSnapshotFingerprint(
      [...rows].sort((x, y) => x.profile_id.localeCompare(y.profile_id)),
    );
    const b = computeSnapshotFingerprint([...rows].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeSnapshotFingerprint([
        rows[0]!,
        row("ops-02", 0x00ff00, "lime", "accent"),
      ]),
    ).not.toBe(a);
  });

  test("env example keeps keys but redacts live values", () => {
    const fingerprint = computeSnapshotFingerprint(rows);
    const live = renderEnvFile(rows, fingerprint, "live");
    const example = renderEnvFile(rows, fingerprint, "example");
    expect(live).toContain(`PROFILE_OPS_02_COLOR_HEX="#1e90ff"`);
    expect(live).toContain("PROFILE_DESK_01_COLOR_INT=16711680");
    expect(live).toContain(`PROFILE_OPS_02_COLOR_INT=${0x1e90ff}`);
    expect(example).toContain("Mode: example");
    expect(example).toContain(`PROFILE_OPS_02_COLOR_LABEL="<label>"`);
    expect(example).toContain(`PROFILE_OPS_02_COLOR_CSS="<css>"`);
    expect(example).toContain("PROFILE_OPS_02_COLOR_INT=0");
    expect(example).toContain(`PROFILE_OPS_02_COLOR_HEX="#000000"`);
    expect(example).not.toContain("#1e90ff");
    expect(example).not.toContain("16711680");
    expect(renderEnvFile(rows, fingerprint)).toBe(live);
    expect(sanitizeEnvValue('a"b\\c`d\ne')).toBe('a\\"b\\\\c\\`de');
  });

  test("generated LUT imports, is frozen, and bakes the ANSI escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "theme-lut-"));
    dirs.push(dir);
    const target = join(dir, "index.theme.gen.ts");
    await atomicWrite(target, renderThemeGenTs(rows, "abc123"));
    expect(await Bun.file(target).text()).not.toContain("Bun.color");
    const mod = await import(target);
    const lut = mod.PROFILE_THEME_LUT;
    expect(Object.isFrozen(lut)).toBe(true);
    expect(mod.THEME_SNAPSHOT_SHA256).toBe("abc123");
    expect(lut["desk-01"].ansi16m).toBe(Bun.color(0xff0000, "ansi-16m"));
    expect(lut["ops-02"].rgb).toEqual([30, 144, 255]);
    expect(Object.isFrozen(lut["ops-02"].rgb)).toBe(true);
  });

  test("atomicWrite leaves no partial target when the rename fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    dirs.push(dir);
    await expect(atomicWrite(dir, "x")).rejects.toThrow();
    const leftovers: string[] = [];
    for await (const name of new Bun.Glob("*.tmp").scan({ cwd: dir })) {
      leftovers.push(name);
    }
    expect(leftovers).toEqual([]);
  });
});

describe("syncIfChanged", () => {
  test("skips unrelated SQLite writes and rewrites only on theme drift", async () => {
    const dir = mkdtempSync(join(tmpdir(), "theme-sync-"));
    dirs.push(dir);
    const dbPath = join(dir, "themes.sqlite");
    const reader = openSportsdeskSqlite(dbPath);
    const writer = openSportsdeskSqlite(dbPath);
    const store = new AutomatedDualTokenStore(dbPath, false);
    const envPath = join(dir, ".env");
    const envExamplePath = join(dir, ".env.example");
    const themeGenPath = join(dir, "index.theme.gen.ts");
    const targets = { envPath, envExamplePath, themeGenPath };
    const state: SyncState = { lastDataVersion: -1, lastFingerprint: "" };
    try {
      const input = normalizeColorInput("dodgerblue", "accent");
      const id = assertProfileId("desk-01");
      store.upsertProfileTheme({
        profile_id: id,
        color_hex: `#${input.color_int.toString(16).padStart(6, "0")}`,
        ...input,
      });
      expect(await syncIfChanged(reader, state, targets)).toBe(true);
      expect(await Bun.file(envPath).text()).toContain(
        `PROFILE_DESK_01_COLOR_INT=${0x1e90ff}`,
      );
      const firstMtime = statSync(envPath).mtimeMs;

      writer.run("CREATE TABLE unrelated (x INTEGER)");
      writer.run("INSERT INTO unrelated VALUES (1)");
      expect(await syncIfChanged(reader, state, targets)).toBe(false);
      expect(statSync(envPath).mtimeMs).toBe(firstMtime);

      const next = normalizeColorInput("crimson", "alert");
      store.upsertProfileTheme({
        profile_id: id,
        color_hex: `#${next.color_int.toString(16).padStart(6, "0")}`,
        ...next,
      });
      expect(await syncIfChanged(reader, state, targets)).toBe(true);
      expect(await Bun.file(envPath).text()).toContain(
        'PROFILE_DESK_01_COLOR_HEX="#dc143c"',
      );
    } finally {
      store.close();
      reader.close();
      writer.close();
    }
  });

  test("sees same-connection writes when PRAGMA data_version does not change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "theme-sync-same-conn-"));
    dirs.push(dir);
    const dbPath = join(dir, "themes.sqlite");
    const reader = openSportsdeskSqlite(dbPath);
    const store = new AutomatedDualTokenStore(dbPath, false);
    const envPath = join(dir, ".env");
    const targets = {
      envPath,
      envExamplePath: join(dir, ".env.example"),
      themeGenPath: join(dir, "index.theme.gen.ts"),
    };
    const state: SyncState = { lastDataVersion: -1, lastFingerprint: "" };
    try {
      const input = normalizeColorInput("dodgerblue", "accent");
      store.upsertProfileTheme({
        profile_id: assertProfileId("desk-01"),
        color_hex: `#${input.color_int.toString(16).padStart(6, "0")}`,
        ...input,
      });
      expect(await syncIfChanged(reader, state, targets)).toBe(true);

      const before = Number(
        (reader.query("PRAGMA data_version").get() as { data_version: number })
          .data_version,
      );
      reader
        .query("UPDATE profile_themes SET color_int = ?1 WHERE profile_id = ?2")
        .run(0xff0000, "desk-01");
      const after = Number(
        (reader.query("PRAGMA data_version").get() as { data_version: number })
          .data_version,
      );
      expect(after).toBe(before);
      expect(await syncIfChanged(reader, state, targets)).toBe(true);
      expect(await Bun.file(envPath).text()).toContain(
        "PROFILE_DESK_01_COLOR_INT=16711680",
      );
    } finally {
      store.close();
      reader.close();
    }
  });

  test("retries after a failed target write instead of advancing state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "theme-sync-failure-"));
    dirs.push(dir);
    const dbPath = join(dir, "themes.sqlite");
    const reader = openSportsdeskSqlite(dbPath);
    const store = new AutomatedDualTokenStore(dbPath, false);
    const envPath = join(dir, ".env");
    const targets = {
      envPath,
      envExamplePath: join(dir, ".env.example"),
      themeGenPath: join(dir, "index.theme.gen.ts"),
    };
    const state: SyncState = { lastDataVersion: -1, lastFingerprint: "" };
    try {
      const input = normalizeColorInput("dodgerblue", "accent");
      store.upsertProfileTheme({
        profile_id: assertProfileId("desk-01"),
        color_hex: `#${input.color_int.toString(16).padStart(6, "0")}`,
        ...input,
      });
      expect(await syncIfChanged(reader, state, targets)).toBe(true);

      const next = normalizeColorInput("crimson", "alert");
      store.upsertProfileTheme({
        profile_id: assertProfileId("desk-01"),
        color_hex: `#${next.color_int.toString(16).padStart(6, "0")}`,
        ...next,
      });

      const blocker = join(dir, "blocker");
      await Bun.write(blocker, "not a directory");
      await expect(
        syncIfChanged(reader, state, {
          ...targets,
          envPath: join(blocker, ".env"),
        }),
      ).rejects.toThrow();
      expect(await syncIfChanged(reader, state, targets)).toBe(true);
      expect(await Bun.file(envPath).text()).toContain(
        'PROFILE_DESK_01_COLOR_HEX="#dc143c"',
      );
    } finally {
      store.close();
      reader.close();
    }
  });
});
