import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ansiWidth,
  avatarCache,
  evictAvatarCache,
  exportThemeArchive,
  fitAnsiCols,
  loadTokenWatchConfig,
  sliceAnsi,
  streamAuditEvents,
} from "../lib/token_watch_native.ts";
import {
  assertProfileId,
  normalizeColorInput,
  type RegistryColorRow,
} from "../lib/token_automation.ts";

const dirs: string[] = [];
const cleanup = () => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
};
afterEach(cleanup);

const rows: RegistryColorRow[] = (() => {
  const parsed = normalizeColorInput("dodgerblue", "accent");
  return [
    {
      profile_id: assertProfileId("desk-01"),
      color_int: parsed.color_int,
      color_css: parsed.color_css,
      color_hex: `#${parsed.color_int.toString(16).padStart(6, "0")}`,
      color_label: parsed.color_label,
    },
  ];
})();

describe("Bun.TOML.stringify + Bun.Archive", () => {
  test("the snapshot tarball is deterministic and embeds the TOML contract", async () => {
    const files = {
      envExample: "PROFILE_DESK_01_COLOR_INT=1\n",
      themeGenTs: "export const LUT = {};",
    };
    const a = await exportThemeArchive(rows, "abc123", files);
    const b = await exportThemeArchive(rows, "abc123", files);
    expect(a.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const text = new TextDecoder().decode(a);
    expect(text).toContain("tokens.toml");
    expect(text).toContain('sha256 = "abc123"');
    expect(text).toContain("color_int = 2003199");
    expect(text).toContain(".env.example");
    expect(text).toContain("index.theme.gen.ts");
  });
});

describe("Bun.JSONL.parseChunk", () => {
  test("streams records across chunk boundaries and flushes the final line", async () => {
    const source = new Blob([
      '{"type":"sync","n":1}\n',
      '{"type":"sync","n":2}\n',
      '{"type":"sync","n":3}',
    ]);
    const events: Record<string, unknown>[] = [];
    for await (const event of streamAuditEvents(source)) events.push(event);
    expect(events).toEqual([
      { type: "sync", n: 1 },
      { type: "sync", n: 2 },
      { type: "sync", n: 3 },
    ]);
  });

  test("an empty log yields no events", async () => {
    const events: Record<string, unknown>[] = [];
    for await (const event of streamAuditEvents(new Blob([])))
      events.push(event);
    expect(events).toEqual([]);
  });
});

describe("native JSON5 / JSONC config loading", () => {
  test("imports commented config files and rejects other extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "token-watch-cfg-"));
    dirs.push(dir);
    const jsonc = join(dir, "token-watch.jsonc");
    const json5 = join(dir, "colors.json5");
    writeFileSync(
      jsonc,
      '// watch settings\n{ "intervalMs": 1500, "live": true }',
    );
    writeFileSync(json5, "{ interval: 10, /* comment */ colours: ['red'] }");
    expect(await loadTokenWatchConfig(jsonc)).toMatchObject({
      intervalMs: 1500,
      live: true,
    });
    expect(await loadTokenWatchConfig(json5)).toMatchObject({ interval: 10 });
    await expect(loadTokenWatchConfig(join(dir, "other.txt"))).rejects.toThrow(
      "ERR_TOKEN_WATCH_CONFIG_FORMAT",
    );
    cleanup();
  });
});

describe("ANSI helpers and memory pressure", () => {
  test("fitAnsiCols wraps without losing colour, and width/slice are ANSI-aware", () => {
    const text = "\x1b[31mhello world\x1b[0m";
    expect(ansiWidth(text)).toBe(11);
    expect(sliceAnsi(text, 0, 5)).toBe("\x1b[31mhello\x1b[39m");
    const wrapped = fitAnsiCols(text, 5);
    expect(wrapped).toContain("\n");
    expect(ansiWidth(wrapped.split("\n")[0]!)).toBe(5);
    expect(() => fitAnsiCols(text, 0)).toThrow("ERR_TOKEN_WATCH_COLUMNS");
  });

  test("a memoryPressure event clears the avatar cache", () => {
    avatarCache.set("a", new Uint8Array([1]));
    expect(avatarCache.size).toBe(1);
    process.emit("memoryPressure");
    expect(avatarCache.size).toBe(0);
    avatarCache.set("b", new Uint8Array([2]));
    evictAvatarCache();
    expect(avatarCache.size).toBe(0);
  });
});
