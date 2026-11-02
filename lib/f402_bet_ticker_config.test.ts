import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TICKER_AGENT_ID_WIDTH,
  buildTickerConfigWrite,
  enabledBucketLabels,
  parseTickerConfig,
} from "./f402_bet_ticker_config.ts";

/**
 * Built from the observed pair in `tests/fixtures/f402-bet-ticker-config-2026-11-01.json`: the
 * `INFO` object the read returned, and the form fields the write sent.
 */
const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../tests/fixtures/f402-bet-ticker-config-2026-11-01.json",
    ),
    "utf8",
  ),
) as {
  agentPlaceholder: string;
  write: { fields: Record<string, string> };
  read: {
    agentIdPaddedLength: number;
    buckets: Array<{ responsePlay: string; playValue: string; color: string }>;
    showFlags: Record<string, string>;
  };
};

/** Rebuilds the observed `INFO` object from the fixture, padding included. */
const info = (() => {
  const built: Record<string, string> = {
    AgentID: fixture.agentPlaceholder.padEnd(
      fixture.read.agentIdPaddedLength,
      " ",
    ),
  };
  for (const bucket of fixture.read.buckets) {
    built[bucket.responsePlay] = bucket.playValue;
    built[bucket.responsePlay.replace("play", "color")] = bucket.color;
  }
  for (const [key, value] of Object.entries(fixture.read.showFlags)) {
    built[key] = value;
  }
  return built;
})();

const config = parseTickerConfig({ INFO: info });

describe("parseTickerConfig", () => {
  test("parses the observed INFO object", () => {
    expect(config).not.toBeNull();
    expect(config?.buckets).toHaveLength(6);
  });

  test("trims the padded flags, so enabled buckets are actually enabled", () => {
    // "on " !== "on": without the trim this would be an all-disabled ticker.
    expect(config?.buckets.map((bucket) => bucket.enabled)).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
    ]);
    expect(enabledBucketLabels(config!)).toEqual([
      "1-499",
      "500-999",
      "5000-9999",
      "10000-100000",
    ]);
  });

  test("trims the padded AgentID and reports that it was padded", () => {
    expect(config?.agentId).toBe(fixture.agentPlaceholder);
    expect(config?.agentIdPadded).toBe(true);
    expect(config?.agentId).not.toContain(" ");
  });

  test("keeps colours as lowercase hex, and nulls anything that is not one", () => {
    expect(
      config?.buckets.every((bucket) =>
        /^#[0-9a-f]{6}$/.test(bucket.color ?? ""),
      ),
    ).toBe(true);
    const broken = parseTickerConfig({
      INFO: { AgentID: "X", "play1-499": "on", "color1-499": "red" },
    });
    expect(broken?.buckets[0]?.color).toBeNull();
    // A broken colour does not take the enabled flag down with it.
    expect(broken?.buckets[0]?.enabled).toBe(true);
  });

  test("reports keys it does not model instead of dropping them", () => {
    const extended = parseTickerConfig({
      INFO: { ...info, color99999: "#ffffff" },
    });
    expect(extended?.unknownKeys).toEqual(["color99999"]);
  });

  test("returns null for INFO:false, which is not 'no buckets configured'", () => {
    // The misconfigured variant has never been captured; reading it as an empty config would be
    // a guess dressed as a parse.
    expect(parseTickerConfig({ INFO: false })).toBeNull();
    expect(parseTickerConfig(null)).toBeNull();
    expect(parseTickerConfig("nope")).toBeNull();
  });

  test('returns null for the write acknowledgement { "INFO": "" }', () => {
    // Observed on 2026-11-01 as a write ack. It looked like this config only because both use an
    // INFO key: parsed as INFO it produced six disabled buckets and an empty agent, silently.
    expect(parseTickerConfig({ INFO: "" })).toBeNull();
    expect(parseTickerConfig({ INFO: null })).toBeNull();
  });

  test("returns null for an empty object, rather than 'everything off'", () => {
    // A bare object must carry at least one field this parser models before it is trusted.
    expect(parseTickerConfig({})).toBeNull();
    expect(parseTickerConfig({ unrelated: true })).toBeNull();
  });

  test("accepts a bare INFO object as well as the envelope", () => {
    const bare = parseTickerConfig(info);
    expect(bare?.agentId).toBe(fixture.agentPlaceholder);
    expect(bare?.buckets).toHaveLength(6);
  });

  test("a flag with an unknown value is not treated as on", () => {
    const odd = parseTickerConfig({
      INFO: { AgentID: "X", "play1-499": "yes" },
    });
    expect(odd?.buckets[0]?.enabled).toBe(false);
  });
});

describe("buildTickerConfigWrite", () => {
  const built = buildTickerConfigWrite(config!, {
    agentOwner: fixture.agentPlaceholder,
  });

  test("reproduces the observed write body field for field", () => {
    const expected = fixture.write.fields;
    const actual = Object.fromEntries(built.fields);
    expect(actual).toEqual(expected);
  });

  test("uses upper-bound field names, not the read-side ranges", () => {
    const keys = built.fields.map(([key]) => key);
    expect(keys).toContain("play499");
    expect(keys).toContain("color100000");
    expect(keys.some((key) => key.includes("-"))).toBe(false);
  });

  test("writes plain on/off, since the padding is read-side only", () => {
    for (const [key, value] of built.fields) {
      if (key.startsWith("play") || key.startsWith("show")) {
        expect(["on", "off"]).toContain(value);
      }
    }
  });

  test("keeps the write's field order, plays descending then flags then colours", () => {
    const plays = built.fields
      .filter(([key]) => key.startsWith("play"))
      .map(([key]) => Number(key.replace("play", "")));
    expect(plays).toEqual([100000, 9999, 4999, 1999, 999, 499]);
    expect(built.fields.at(-2)?.[0]).toBe("operation");
    expect(built.fields.at(-1)?.[0]).toBe("agentOwner");
  });

  test("the body is form-urlencoded and round-trips", () => {
    const reparsed = Object.fromEntries(new URLSearchParams(built.body));
    expect(reparsed).toEqual(fixture.write.fields);
  });

  test("it is a builder, not a client: nothing here performs a request", () => {
    // The module that owns the write contract never calls it. If this ever grows a fetch, the test
    // should be the thing that fails first.
    const source = readFileSync(
      resolve(import.meta.dir, "f402_bet_ticker_config.ts"),
      "utf8",
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("Bun.connect");
  });
});

describe("TICKER_AGENT_ID_WIDTH", () => {
  test("matches the measured padding", () => {
    expect(TICKER_AGENT_ID_WIDTH).toBe(fixture.read.agentIdPaddedLength);
    expect(TICKER_AGENT_ID_WIDTH).toBe(50);
  });
});
