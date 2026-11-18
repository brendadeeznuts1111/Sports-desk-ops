/**
 * @file lib/customer_channel_inspection.ts
 * @description Read-only channel coverage diagnostic for the customer profile book.
 *
 * A profile's `tickets.byChannel` is only as good as the `channel` carried by its sample wagers.
 * Live wagers carry a `TicketWriter`; harvested sample wagers do not, so a book dominated by
 * harvested rows can show a large `unknown` bucket. This module reports that gap rather than
 * assigning a guessed channel to a ticket the capture never labelled.
 */
import type { BunInspectOptions } from "./cli_inspect.ts";

interface ChannelBucket {
  readonly n: number;
  readonly riskUsd: number;
}

export interface ChannelProfileInput {
  readonly tickets: {
    readonly byChannel: Readonly<Record<string, ChannelBucket>>;
  };
  /** Measured writer distribution from live wagers; absent when the customer had none. */
  readonly channelEvidence?: Readonly<Record<string, ChannelBucket>>;
}

export interface ChannelInspectionBucket extends ChannelBucket {
  /** Share of all sampled tickets in this channel, 0–1. */
  readonly share: number;
}

/**
 * Aggregated channel coverage. `[Bun.inspect.custom]` gives a one-line summary at depth 0 and
 * the full per-channel table at depth 1+, following the repo's other inspection formatters.
 */
export class CustomerChannelInspection {
  constructor(
    readonly profiles: number,
    readonly tickets: number,
    readonly byChannel: Readonly<Record<string, ChannelInspectionBucket>>,
    readonly unknownTickets: number,
    readonly unknownRiskUsd: number,
    /** Rows and buckets measured from the live wager writer, independent of sample coverage. */
    readonly writerRows: number = 0,
    readonly writerByChannel: Readonly<
      Record<string, ChannelInspectionBucket>
    > = {},
  ) {}

  /** Sampled tickets with a labelled channel, as a percentage of all sampled tickets. */
  get coveragePct(): number {
    return this.tickets === 0
      ? 0
      : ((this.tickets - this.unknownTickets) / this.tickets) * 100;
  }

  [Bun.inspect.custom](depth: number = 0, options?: BunInspectOptions): string {
    const colors = options?.colors === true;
    const bold = (s: string) => (colors ? `\x1b[1m${s}\x1b[22m` : s);
    const dim = (s: string) => (colors ? `\x1b[2m${s}\x1b[22m` : s);

    const summary =
      `${bold("CustomerChannel")} profiles=${this.profiles} ` +
      `tickets=${this.tickets} ` +
      `coverage=${this.coveragePct.toFixed(1)}% ` +
      dim(
        `unknown=${this.unknownTickets}/$${Math.round(this.unknownRiskUsd)}`,
      ) +
      (this.writerRows === 0
        ? ""
        : ` ${bold("writer:")} ${this.writerRows} rows in ${Object.keys(this.writerByChannel).length} channel(s)`);

    if (depth <= 0) return summary;

    const table = (
      source: Readonly<Record<string, ChannelInspectionBucket>>,
    ): string[] =>
      Object.entries(source)
        .sort((a, b) => b[1].n - a[1].n)
        .map(
          ([name, bucket]) =>
            `  ${name.padEnd(12)} n=${String(bucket.n).padStart(4)} ` +
            `risk=$${Math.round(bucket.riskUsd)} ` +
            `${(bucket.share * 100).toFixed(1)}%`,
        );
    const rows = table(this.byChannel);
    if (this.writerRows > 0) {
      rows.push("  live wager writers:", ...table(this.writerByChannel));
    }
    return [summary, ...rows].join("\n");
  }

  toString(): string {
    return this[Bun.inspect.custom](0);
  }
}

/** Aggregate `tickets.byChannel` over profiles; an absent bucket counts as unknown-free. */
export function inspectCustomerChannels(
  profiles: readonly ChannelProfileInput[],
): CustomerChannelInspection {
  const buckets = new Map<string, { n: number; riskUsd: number }>();
  const writerBuckets = new Map<string, { n: number; riskUsd: number }>();
  let writerRows = 0;
  let tickets = 0;
  for (const profile of profiles) {
    for (const [name, value] of Object.entries(profile.channelEvidence ?? {})) {
      const current = writerBuckets.get(name) ?? { n: 0, riskUsd: 0 };
      current.n += value.n;
      current.riskUsd += value.riskUsd;
      writerBuckets.set(name, current);
      writerRows += value.n;
    }
    for (const [name, value] of Object.entries(
      profile.tickets?.byChannel ?? {},
    )) {
      const channel = name.trim() === "" ? "unknown" : name;
      const current = buckets.get(channel) ?? { n: 0, riskUsd: 0 };
      current.n += value.n;
      current.riskUsd += value.riskUsd;
      buckets.set(channel, current);
      tickets += value.n;
    }
  }

  const byChannel: Record<string, ChannelInspectionBucket> = {};
  for (const [name, bucket] of buckets) {
    byChannel[name] = {
      n: bucket.n,
      riskUsd: bucket.riskUsd,
      share: tickets === 0 ? 0 : bucket.n / tickets,
    };
  }
  const unknown = byChannel["unknown"] ?? { n: 0, riskUsd: 0, share: 0 };
  const writerByChannel: Record<string, ChannelInspectionBucket> = {};
  for (const [name, bucket] of writerBuckets) {
    writerByChannel[name] = {
      n: bucket.n,
      riskUsd: bucket.riskUsd,
      share: writerRows === 0 ? 0 : bucket.n / writerRows,
    };
  }
  return new CustomerChannelInspection(
    profiles.length,
    tickets,
    byChannel,
    unknown.n,
    unknown.riskUsd,
    writerRows,
    writerByChannel,
  );
}
