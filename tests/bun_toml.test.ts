import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseToml } from "../lib/toml_parse.ts";

const root = resolve(import.meta.dir, "..");

describe("Bun.TOML Parser", () => {
  it("parses TOML configuration text into typed JavaScript object", () => {
    const text = readFileSync(
      resolve(root, "config/wagers-capture.toml"),
      "utf8",
    );
    expect(parseToml(text)).toEqual(Bun.TOML.parse(text));
    const parsed = Bun.TOML.parse(text) as {
      capture?: { retries?: number };
      publish?: { channel?: string };
    };
    expect(parsed.capture?.retries).toBe(2);
    expect(parsed.publish?.channel).toBe("gslive-wagers");
  });

  it("parses bunfig.toml configuration directly", () => {
    const parsed = Bun.TOML.parse(
      readFileSync(resolve(root, "bunfig.toml"), "utf8"),
    ) as { fmt?: { printWidth?: number } };
    expect(parsed.fmt?.printWidth).toBe(80);
  });

  it("loads TOML file via dynamic import attribute with { with: { type: 'toml' } }", async () => {
    const { default: parsed } = (await import("../bunfig.toml", {
      with: { type: "toml" },
    })) as { default: { fmt?: { printWidth?: number } } };
    expect(parsed.fmt?.printWidth).toBe(80);
  });

  it("parses TOML v1.1 dates as Temporal.Instant objects and round-trips via stringify()", () => {
    const parsed = Bun.TOML.parse(
      `released = 2026-08-10T12:00:00Z\n[package]\n"name" = "app"\n`,
    ) as { released?: unknown; package?: { name?: string } };

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

  it("surfaces exceptions thrown by value getters or Symbol.toPrimitive during stringify()", () => {
    const faulty = {
      get faultyProp() {
        throw new Error("serialization boom");
      },
    };
    expect(() => Bun.TOML.stringify(faulty)).toThrow("serialization boom");
  });

  it("enforces strict syntax: rejects unquoted strings and out-of-range integers", () => {
    expect(() => Bun.TOML.parse("unquoted = value")).toThrow(
      "Strings must be quoted",
    );
    expect(() =>
      Bun.TOML.parse("overflow = 99999999999999999999999999999999999999"),
    ).toThrow("Integer is outside the 64-bit signed range");
  });
});
