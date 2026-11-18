import { describe, expect, test } from "bun:test";
import {
  CustomerChannelInspection,
  inspectCustomerChannels,
  type ChannelProfileInput,
} from "../lib/customer_channel_inspection.ts";

const profile = (
  byChannel: Record<string, { n: number; riskUsd: number }>,
): ChannelProfileInput => ({ tickets: { byChannel } });

describe("customer channel inspection", () => {
  test("an empty book reports zero coverage instead of dividing by zero", () => {
    const result = inspectCustomerChannels([]);
    expect(result.profiles).toBe(0);
    expect(result.tickets).toBe(0);
    expect(result.coveragePct).toBe(0);
    expect(Bun.inspect(result, { colors: false, depth: 0 })).toBe(
      "CustomerChannel profiles=0 tickets=0 coverage=0.0% unknown=0/$0",
    );
  });

  test("aggregates channels and reports the unknown bucket as a measured gap", () => {
    const result = inspectCustomerChannels([
      profile({
        Internet: { n: 4, riskUsd: 9_000 },
        unknown: { n: 6, riskUsd: 1_000 },
      }),
      profile({
        "": { n: 4, riskUsd: 500 },
        GSLIVE: { n: 1, riskUsd: 100 },
      }),
    ]);
    expect(result.tickets).toBe(15);
    expect(result.unknownTickets).toBe(10);
    expect(result.unknownRiskUsd).toBe(1_500);
    expect(result.coveragePct).toBeCloseTo(33.333, 2);
    expect(result.byChannel["Internet"]).toMatchObject({
      n: 4,
      riskUsd: 9_000,
    });
    expect(result.byChannel["unknown"]?.share).toBeCloseTo(10 / 15, 3);
  });

  test("depth 0 is one line; depth 1 is a table sorted by ticket count", () => {
    const result = new CustomerChannelInspection(
      2,
      10,
      {
        unknown: { n: 8, riskUsd: 100, share: 0.8 },
        Internet: { n: 2, riskUsd: 50, share: 0.2 },
      },
      8,
      100,
    );
    const short = Bun.inspect(result, { colors: false, depth: 0 });
    const long = Bun.inspect(result, { colors: false, depth: 1 });
    expect(short).not.toContain("\n");
    expect(long).toContain("\n");
    expect(long.indexOf("unknown")).toBeLessThan(long.indexOf("Internet"));
    expect(result.toString()).toBe(short);
    expect(Bun.inspect(result, { colors: true, depth: 0 })).toContain(
      "\x1b[1mCustomerChannel\x1b[22m",
    );
  });

  test("measured writer evidence survives an all-unknown sample", () => {
    const result = inspectCustomerChannels([
      {
        tickets: { byChannel: { unknown: { n: 5, riskUsd: 100 } } },
        channelEvidence: {
          Internet: { n: 5, riskUsd: 100 },
          GSLIVE: { n: 2, riskUsd: 50 },
        },
      },
    ]);
    expect(result.writerRows).toBe(7);
    expect(result.writerByChannel["Internet"]?.share).toBeCloseTo(5 / 7, 3);
    expect(Bun.inspect(result, { colors: false, depth: 0 })).toContain(
      "writer: 7 rows in 2 channel(s)",
    );
    expect(Bun.inspect(result, { colors: false, depth: 1 })).toContain(
      "live wager writers:",
    );
  });
});
