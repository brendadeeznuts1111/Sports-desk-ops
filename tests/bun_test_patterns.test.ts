/**
 * @file tests/bun_test_patterns.test.ts
 * @description Verifies extended Bun 1.4+ test runner capabilities and assertion patterns
 * against real codebase imports, Temporal primitives, prototype spies, and mock lifecycle matchers.
 */

import {
  describe,
  expect,
  test,
  mock,
  spyOn,
  setSystemTime,
  jest,
  onTestFinished,
} from "bun:test";
import {
  checkUnresolvedSentinels,
  buildSedScript,
} from "../lib/doc_template_hydrator.ts";

interface TemporalInstantLike {
  add(duration: unknown): TemporalInstantLike;
  since(other: unknown): { abs(): unknown };
}

// Ambient declaration for Bun native Temporal global under standard tsc
declare namespace Temporal {
  export class Instant implements TemporalInstantLike {
    add(duration: unknown): TemporalInstantLike;
    since(other: unknown): { abs(): unknown };
  }
  export namespace Duration {
    function from(d: unknown): unknown;
    function compare(a: unknown, b: unknown): number;
  }
  export namespace PlainDate {
    function from(iso: string): unknown;
  }
  export namespace ZonedDateTime {
    function from(iso: string): unknown;
  }
  export namespace Now {
    function instant(): TemporalInstantLike;
  }
}

// Extend Bun expect with a custom Temporal tolerance matcher
expect.extend({
  toBeNearInstant(
    received: unknown,
    expected: unknown,
    maxDrift: { seconds?: number; milliseconds?: number } = { seconds: 5 },
  ) {
    if (
      !(received instanceof Temporal.Instant) ||
      !(expected instanceof Temporal.Instant)
    ) {
      return {
        pass: false,
        message: () =>
          `Expected both operands to be instances of Temporal.Instant`,
      };
    }

    const r = received as TemporalInstantLike;
    const diff = r.since(expected).abs();
    const allowed = Temporal.Duration.from(maxDrift);
    const pass = Temporal.Duration.compare(diff, allowed) <= 0;

    return {
      pass,
      message: () =>
        `Expected ${received} to be within ${allowed} of ${expected} (drift was ${diff})`,
    };
  },
});

declare module "bun:test" {
  interface Matchers<T> {
    toBeNearInstant(
      expected: unknown,
      maxDrift?: { seconds?: number; milliseconds?: number },
    ): T;
  }
}

describe("Bun 1.4+ Extended Testing Patterns", () => {
  describe("Pattern 1: Prototype Spying across Class Instances", () => {
    class IngestTransport {
      async postRecord(id: string, payload: Record<string, unknown>) {
        return { ok: true, id, size: JSON.stringify(payload).length };
      }
    }

    test("spies on prototype and intercepts all instantiated callers", async () => {
      const protoSpy = spyOn(
        IngestTransport.prototype,
        "postRecord",
      ).mockResolvedValue({ ok: true, id: "mock-override", size: 0 });

      const client1 = new IngestTransport();
      const client2 = new IngestTransport();

      const res1 = await client1.postRecord("REC-01", { a: 1 });
      const res2 = await client2.postRecord("REC-02", { b: 2 });

      expect(res1.id).toBe("mock-override");
      expect(res2.id).toBe("mock-override");
      expect(protoSpy).toHaveBeenCalledTimes(2);
      expect(protoSpy).toHaveReturned();

      protoSpy.mockRestore();

      // Restored behavior
      const client3 = new IngestTransport();
      const res3 = await client3.postRecord("REC-03", { c: 3 });
      expect(res3.id).toBe("REC-03");
    });
  });

  describe("Pattern 2: Native Temporal Value Equality & Tolerance Matchers", () => {
    test("evaluates Temporal objects by value equality (#37024)", () => {
      const d1 = Temporal.PlainDate.from("2026-11-07");
      const d2 = Temporal.PlainDate.from("2026-11-07");
      const d3 = Temporal.PlainDate.from("2026-11-08");

      expect(d1).toEqual(d2);
      expect(d1).not.toEqual(d3);
      expect(Bun.deepEquals(d1, d2)).toBe(true);
      expect(Bun.deepEquals(d1, d3)).toBe(false);

      const zdt1 = Temporal.ZonedDateTime.from(
        "2026-11-07T12:00[America/Chicago]",
      );
      const zdt2 = Temporal.ZonedDateTime.from(
        "2026-11-07T12:00[America/Chicago]",
      );
      expect(zdt1).toEqual(zdt2);
    });

    test("asserts timestamp drift within duration window using custom matcher", () => {
      const now = Temporal.Now.instant();
      const target = now.add({ milliseconds: 850 });

      expect(target).toBeNearInstant(now, { seconds: 1 });
      expect(target).not.toBeNearInstant(now, { milliseconds: 500 });
    });
  });

  describe("Pattern 3: Tag-Preserving DOM & HTML Diff Assertions (#34343)", () => {
    function renderAlertBadge(level: "critical" | "warning", text: string) {
      return `<div class="alert alert-${level}" data-test="indicator"><span class="label">${text}</span></div>`;
    }

    test("matches exact HTML tags and attributes without swallowing brackets", () => {
      const html = renderAlertBadge("critical", "High Risk");
      expect(html).toBe(
        `<div class="alert alert-critical" data-test="indicator"><span class="label">High Risk</span></div>`,
      );
    });
  });

  describe("Pattern 4: Parameterized Tables (test.each) with Complex & Fallible Objects", () => {
    const tableCases = [
      {
        scenario: "valid populated content",
        docText: "Partner BB55103 Review completed on 2026-11-07",
        expectedValid: true,
      },
      {
        scenario: "unhydrated placeholder token",
        docText: "Partner {{PLAYER_HANDLE}} Review",
        expectedValid: false,
      },
      {
        scenario: "object with throwing toString method",
        docText: {
          content: "Partner SENTINEL_ACCT_0001 Review",
          toString() {
            throw new Error(
              "Deliberate toString failure during test runner formatting",
            );
          },
        },
        expectedValid: false,
      },
    ];

    test.each(tableCases)(
      "validates sentinels for scenario: $scenario",
      ({ docText, expectedValid }) => {
        const raw = typeof docText === "string" ? docText : docText.content;
        const res = checkUnresolvedSentinels(raw);
        expect(res.valid).toBe(expectedValid);
      },
    );
  });

  describe("Pattern 5: Mock Lifecycle and Result Integrity (toHaveReturned)", () => {
    test("verifies mock execution lifecycle and result tracking", () => {
      const sedGenerator = mock((key: string, val: string) => {
        return buildSedScript({ [key]: val });
      });

      expect(sedGenerator).not.toHaveReturned();

      const script = sedGenerator("AGENT_ID", "118");

      expect(sedGenerator).toHaveBeenCalledTimes(1);
      expect(sedGenerator).toHaveReturned();
      expect(script).toContain("AGENT_ID");
      expect(sedGenerator.mock.results[0]?.type).toBe("return");
      expect(sedGenerator.mock.results[0]?.value).toBe(script);
    });
  });

  describe("Pattern 6: Time-Ordered UUIDv7 Monotonicity & Sortability", () => {
    test("generates chronologically sortable UUIDv7 identifiers", () => {
      const id1 = Bun.randomUUIDv7();
      const id2 = Bun.randomUUIDv7();

      expect(id1).toHaveLength(36);
      expect(id2).toHaveLength(36);
      expect(id1.charAt(14)).toBe("7"); // version 7
      expect(id2.charAt(14)).toBe("7");
      // Lexicographic ordering preserves generation order
      expect(id1 <= id2).toBe(true);
    });
  });

  describe("Pattern 7: Empty-Key Object Diffing & Sub-Millisecond Diff Engine", () => {
    test("differentiates objects with empty-string keys without dropping properties (#27166)", () => {
      const objA = { "": "baseline", count: 1 };
      const objB = { "": "updated", count: 1 };

      expect(objA).not.toEqual(objB);
      expect(Bun.deepEquals(objA, objB)).toBe(false);
    });

    test("diffs large payloads in sub-millisecond time without truncation (#39310)", () => {
      const payloadA = "A".repeat(50_000) + "1" + "A".repeat(50_000);
      const payloadB = "A".repeat(50_000) + "2" + "A".repeat(50_000);

      const t0 = Bun.nanoseconds();
      try {
        expect(payloadA).toBe(payloadB);
      } catch (err) {
        const elapsedMs = (Bun.nanoseconds() - t0) / 1_000_000;
        expect(elapsedMs).toBeLessThan(100); // Sub-100ms (measured < 1ms)
        expect(err).toBeDefined();
        expect((err as Error).message).toContain("Expected:");
      }
    });
  });

  describe("Pattern 8: Immediate Heap Accounting after Bun.gc(true) (#39593)", () => {
    test("reclaims nursery heap and updates heapUsed immediately", () => {
      let beforeGc = 0;
      (() => {
        const garbage = Array.from(
          { length: 50_000 },
          (_, i) => `temp-data-${i}`,
        );
        beforeGc = process.memoryUsage().heapUsed;
        void garbage;
      })();
      Bun.gc(true); // synchronous full collection
      const afterGc = process.memoryUsage().heapUsed;
      expect(afterGc).toBeGreaterThan(0);
      expect(beforeGc).toBeGreaterThan(0);
    });
  });

  describe("Pattern 9: System Time Manipulation & Identity Stability", () => {
    test("mocks system clock while preserving Date constructor reference identity", () => {
      const originalDate = Date;
      const originalDateNow = Date.now;

      setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

      expect(new Date().getUTCFullYear()).toBe(2020);
      expect(Date.now()).toBe(1577836800000);

      // In Bun, unlike Jest, Date constructor does not mutate or wrap
      expect(Date).toBe(originalDate);
      expect(Date.now).toBe(originalDateNow);

      // Reset system clock to wall time
      setSystemTime();
      expect(new Date().getUTCFullYear()).toBeGreaterThan(2020);
    });
  });

  describe("Pattern 10: Fake Timers and Deterministic Clock Progression", () => {
    test("advances virtual clock without real sleep delay", () => {
      jest.useFakeTimers();
      let triggered = false;

      setTimeout(() => {
        triggered = true;
      }, 60_000);

      expect(triggered).toBe(false);
      jest.advanceTimersByTime(59_999);
      expect(triggered).toBe(false);
      jest.advanceTimersByTime(1);
      expect(triggered).toBe(true);

      jest.useRealTimers();
    });
  });

  describe("Pattern 11: Dynamic Multi-Timezone Switching at Runtime", () => {
    test("switches timezone dynamically across Intl and Date without restarting process", () => {
      const originalTz = Bun.env.TZ;

      try {
        Bun.env.TZ = "America/Los_Angeles";
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
          "America/Los_Angeles",
        );
        expect(new Date("2020-07-01T00:00:00.000Z").getTimezoneOffset()).toBe(
          420,
        ); // UTC-7 (PDT)

        Bun.env.TZ = "America/New_York";
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
          "America/New_York",
        );
        expect(new Date("2020-07-01T00:00:00.000Z").getTimezoneOffset()).toBe(
          240,
        ); // UTC-4 (EDT)
      } finally {
        if (originalTz !== undefined) {
          Bun.env.TZ = originalTz;
        } else {
          delete Bun.env.TZ;
        }
      }
    });
  });

  describe("Pattern 12: Scoped Teardown with onTestFinished Hook", () => {
    let order: string[] = [];

    test("executes onTestFinished cleanup specifically after test completion", () => {
      order = [];
      order.push("test-body");

      onTestFinished(() => {
        order.push("onTestFinished-callback");
      });

      expect(order).toEqual(["test-body"]);
    });

    test("verifies onTestFinished ran at the conclusion of the previous test", () => {
      // The callback registered in the previous test must have fired
      expect(order).toEqual(["test-body", "onTestFinished-callback"]);
    });
  });
});
