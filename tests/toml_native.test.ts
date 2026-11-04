import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseToml } from "../lib/toml_parse.ts";

const root = resolve(import.meta.dir, "..");

describe("native Bun.TOML", () => {
  test("parseToml delegates to the native parser", () => {
    const text = readFileSync(
      resolve(root, "config/wagers-capture.toml"),
      "utf8",
    );
    expect(parseToml(text)).toEqual(Bun.TOML.parse(text));
    const parsed = parseToml(text) as {
      capture?: { retries?: number };
      publish?: { channel?: string };
    };
    expect(parsed.capture?.retries).toBe(2);
    expect(parsed.publish?.channel).toBe("gslive-wagers");
  });

  test("parses the project bunfig without a custom parser", () => {
    const parsed = parseToml(
      readFileSync(resolve(root, "bunfig.toml"), "utf8"),
    ) as { fmt?: { printWidth?: number } };
    expect(parsed.fmt?.printWidth).toBe(80);
  });

  test("TOML v1.1 syntax parses natively (dates, quoted keys, stringify)", () => {
    const parsed = Bun.TOML.parse(
      `released = 2026-08-10T12:00:00Z\n[package]\n"name" = "app"\n`,
    ) as { released?: string; package?: { name?: string } };
    // Bun 1.4.4 returns a Temporal.Instant for TOML offset date-times (the upstream
    // snippet shows a string; measured behavior is pinned here).
    const released = parsed.released as {
      epochMilliseconds?: number;
      constructor?: { name?: string };
    };
    expect(released.epochMilliseconds).toBe(1786363200000);
    expect(released.constructor?.name).toBe("Instant");
    expect(new Date(released.epochMilliseconds as number).toISOString()).toBe(
      "2026-08-10T12:00:00.000Z",
    );
    expect(parsed.package?.name).toBe("app");
    const round = Bun.TOML.parse(
      Bun.TOML.stringify({ name: "app", deps: { bun: "1.4.4" } }),
    ) as { name?: string; deps?: { bun?: string } };
    expect(round).toEqual({ name: "app", deps: { bun: "1.4.4" } });
  });
});
