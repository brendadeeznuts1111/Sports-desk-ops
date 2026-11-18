import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NamedColorTokenStore,
  deriveColorToken,
  detectColorDepth,
  formatProfileDotEnv,
  parseColorInput,
} from "../lib/bun_profiled_terminal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("detectColorDepth", () => {
  test("FORCE_COLOR=1 overrides NO_COLOR=1 per Bun runtime specification", () => {
    expect(detectColorDepth({ NO_COLOR: "1", FORCE_COLOR: "1" }, false)).toBe(
      "ansi16",
    );
    expect(detectColorDepth({ NO_COLOR: "1", FORCE_COLOR: "3" }, false)).toBe(
      "truecolor",
    );
    expect(detectColorDepth({ NO_COLOR: "1", FORCE_COLOR: "0" }, true)).toBe(
      "none",
    );
    expect(detectColorDepth({ NO_COLOR: "1" }, true)).toBe("none");
  });

  test("maps every FORCE_COLOR level and falls back to the TTY state", () => {
    expect(detectColorDepth({ FORCE_COLOR: "0" }, true)).toBe("none");
    expect(detectColorDepth({ FORCE_COLOR: "2" }, false)).toBe("ansi256");
    expect(detectColorDepth({ FORCE_COLOR: "3" }, false)).toBe("truecolor");
    expect(detectColorDepth({}, true)).toBe("ansi16");
    expect(detectColorDepth({}, false)).toBe("none");
  });
});

describe("formatProfileDotEnv", () => {
  test("emits valid Bun .env expansion for shared named colors", () => {
    const store = new NamedColorTokenStore(":memory:");
    store.setProfile(
      "crimson-dry",
      { accent: "red", error: "red", warn: "gold" },
      4,
    );

    const dotenvText = formatProfileDotEnv(store, "crimson-dry", {
      expandSharedColors: true,
      disableTelemetryAndClear: true,
    });

    expect(dotenvText).toContain('PTY_ACCENT="red"');
    expect(dotenvText).toContain("PTY_ERROR=$PTY_ACCENT");
    expect(dotenvText).toContain('PTY_WARN="gold"');
    expect(dotenvText).toContain('BUN_OPTIONS="--console-depth=4"');
    expect(dotenvText).toContain("DO_NOT_TRACK=1");
    store.close();
  });

  test("repeats the literal colour when expansion is off, and omits telemetry when unasked", () => {
    const store = new NamedColorTokenStore(":memory:");
    store.setProfile("plain", { accent: "red", error: "red", warn: "red" }, 2);
    const dotenvText = formatProfileDotEnv(store, "plain");
    expect(dotenvText).toContain('PTY_ERROR="red"');
    expect(dotenvText).not.toContain("DO_NOT_TRACK");
    store.close();
  });

  test("refuses an unknown profile instead of emitting an empty file", () => {
    const store = new NamedColorTokenStore(":memory:");
    expect(() => formatProfileDotEnv(store, "missing")).toThrow(
      "ERR_PTY_PROFILE_UNKNOWN",
    );
    store.close();
  });

  test("rejects colour values that would break the emitted .env", () => {
    const store = new NamedColorTokenStore(":memory:");
    expect(() =>
      store.setProfile(
        "bad",
        { accent: 'red" x=1', error: "red", warn: "red" },
        1,
      ),
    ).toThrow("ERR_PTY_COLOR_UNSAFE");
    store.close();
  });

  test("persists profiles across a file-backed store", () => {
    const dir = mkdtempSync(join(tmpdir(), "pty-profiles-"));
    dirs.push(dir);
    const file = join(dir, "profiles.sqlite");
    const first = new NamedColorTokenStore(file);
    first.setProfile(
      "crimson-dry",
      { accent: "red", error: "red", warn: "gold" },
      4,
    );
    first.close();

    const second = new NamedColorTokenStore(file);
    expect(second.getProfile("crimson-dry")).toEqual({
      colors: { accent: "red", error: "red", warn: "gold" },
      consoleDepth: 4,
    });
    second.close();
  });
});

/**
 * `Bun.ColorInput` covers strings, packed numbers, RGB objects, tuples and typed arrays
 * (https://bun.com/reference/bun/ColorInput); `deriveColorToken` used to accept only a string.
 */
test("deriveColorToken normalises every Bun.ColorInput form", () => {
  const fromName = deriveColorToken("accent", "rebeccapurple");
  expect(fromName.name).toBe("rebeccapurple");
  expect(fromName.hex).toBe("#663399");

  const fromNumber = deriveColorToken("warn", 0xff0000);
  expect(fromNumber.number).toBe(0xff0000);
  expect(fromNumber.hex).toBe("#ff0000");
  // Bun's canonical CSS spelling varies by value ("red" vs a compressed "#00f"), so only its
  // presence is contractual.
  expect(fromNumber.name.length).toBeGreaterThan(0);

  const fromTuple = deriveColorToken("error", [255, 128, 0]);
  expect(fromTuple.number).toBe(0xff8000);

  const fromObject = deriveColorToken("info", { r: 10, g: 20, b: 30, a: 255 });
  expect(fromObject.number).toBe(0x0a141e);

  expect(parseColorInput("not-a-colour")).toBeNull();
  const blue = parseColorInput(0x0000ff);
  expect(blue?.number).toBe(0x0000ff);
  expect(blue?.name).toMatch(/^(blue|#00f|#0000ff)$/);
});
