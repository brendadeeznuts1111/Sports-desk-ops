import { describe, expect, test } from "bun:test";
import {
  publishDashboardTopicEvent,
  type WsLike,
} from "../packages/api/src/ws.ts";

function fakeWs(
  sendResult: unknown,
  topics: readonly string[] = ["dashboard"],
): WsLike & {
  sent: string[];
  closed: { code: number | undefined; reason: string | undefined }[];
} {
  const sent: string[] = [];
  const closed: { code: number | undefined; reason: string | undefined }[] = [];
  return {
    subscriptions: topics,
    subscribe() {},
    unsubscribe() {},
    send(data: string) {
      sent.push(data);
      return sendResult;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    sent,
    closed,
  };
}

describe("publishDashboardTopicEvent backpressure", () => {
  test("a dropped frame (-1) closes the socket and is not counted as delivered", () => {
    const slow = fakeWs(-1);
    const healthy = fakeWs(42);
    const delivered = publishDashboardTopicEvent(
      [slow, healthy],
      "dashboard",
      '{"x":1}',
    );
    expect(delivered).toBe(1);
    expect(slow.closed).toEqual([{ code: 1011, reason: "backpressure" }]);
    expect(healthy.closed).toEqual([]);
  });

  test("a zero return also closes; only the empty payload is a zero-byte delivery", () => {
    const zero = fakeWs(0);
    expect(publishDashboardTopicEvent([zero], "dashboard", '{"x":1}')).toBe(0);
    expect(zero.closed).toEqual([{ code: 1011, reason: "backpressure" }]);

    const empty = fakeWs(0);
    expect(publishDashboardTopicEvent([empty], "dashboard", "")).toBe(1);
    expect(empty.closed).toEqual([]);
  });

  test("an in-memory fake returning undefined is treated as delivered", () => {
    const fake = fakeWs(undefined);
    expect(publishDashboardTopicEvent([fake], "dashboard", '{"x":1}')).toBe(1);
    expect(fake.closed).toEqual([]);
  });

  test("unsubscribed clients are not sent the event at all", () => {
    const other = fakeWs(42, ["live-bets"]);
    expect(publishDashboardTopicEvent([other], "dashboard", '{"x":1}')).toBe(0);
    expect(other.sent).toEqual([]);
  });
});
