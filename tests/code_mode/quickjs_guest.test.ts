import { describe, expect, test } from "bun:test";

import { runGuestCell } from "../../lib/quickjs_code_mode.ts";
import {
  assertMatchesOracle,
  firstRegularProfile,
  oracleSummary,
} from "./oracle.ts";
import { BANNED_GUEST_GLOBALS, probeGuestGlobals } from "./guest_probe.ts";

const SAMPLE = firstRegularProfile();

describe("QuickJS guest boundary", () => {
  test("guest globalThis does not expose host capabilities", async () => {
    const names = await probeGuestGlobals();
    expect(Array.isArray(names)).toBe(true);
    for (const banned of BANNED_GUEST_GLOBALS) {
      expect(names).not.toContain(banned);
    }
    // A real realm still has the language intrinsics and the tools bridge.
    expect(names).toContain("Object");
    expect(names).toContain("tools");
  });

  test("typeof host identifiers is undefined inside the guest", async () => {
    const kinds = await runGuestCell(
      "return [typeof Bun, typeof process, typeof require, typeof module]",
    );
    expect(kinds).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  test("a guest cell can query profiles through the bridge", async () => {
    const args = { field: "sharp", limit: 500 };
    const guest = await runGuestCell(
      `return tools.query_profiles(${JSON.stringify(args)})`,
    );
    assertMatchesOracle(guest, args);
  });

  test("a guest cell sees the same frozen profile as the host", async () => {
    const guest = await runGuestCell(
      "return tools.get_profile({ id: " + JSON.stringify(SAMPLE.id) + " })",
    );
    expect(guest).toMatchObject({ id: SAMPLE.id, vol: SAMPLE.vol });
    expect((guest as { flags?: unknown }).flags).toBeArray();
  });

  test("host tool errors surface as guest exceptions", async () => {
    await expect(
      runGuestCell('return tools.query_profiles({ field: "toString" })'),
    ).rejects.toThrow(/field required/);
  });
});

describe("sandbox resource and isolation guarantees", () => {
  test("an infinite loop is interrupted by the timeout", async () => {
    await expect(
      runGuestCell("while (true) {}", { timeoutMs: 75 }),
    ).rejects.toThrow(/guest cell failed/);
  });

  test("the tool-call budget stops a runaway cell", async () => {
    await expect(
      runGuestCell(
        "for (let i = 0; i < 10; i += 1) tools.get_profile({ id: " +
          JSON.stringify(SAMPLE.id) +
          ' }); return "ok";',
        { maxToolCalls: 3 },
      ),
    ).rejects.toThrow(/ERR_CODE_MODE_MAX_CALLS/);
  });

  test("each cell gets a fresh realm", async () => {
    await runGuestCell("globalThis.__leak = 42; return 1");
    const leaked = await runGuestCell("return typeof globalThis.__leak");
    expect(leaked).toBe("undefined");
  });

  test("guest mutation of a tool result cannot reach the host snapshot", async () => {
    const before = await runGuestCell(
      "const p = tools.get_profile({ id: " +
        JSON.stringify(SAMPLE.id) +
        ' }); p.flags.push("hacked"); p.vol = -1; return p.flags.length;',
    );
    expect(before).toBe(SAMPLE.flags.length + 1);
    const after = await runGuestCell(
      "return tools.get_profile({ id: " + JSON.stringify(SAMPLE.id) + " })",
    );
    expect(after).toMatchObject({ id: SAMPLE.id, vol: SAMPLE.vol });
    expect((after as { flags: string[] }).flags).not.toContain("hacked");
  });

  test("the Function constructor stays inside the guest realm", async () => {
    const kind = await runGuestCell(
      "const p = tools.get_profile({ id: " +
        JSON.stringify(SAMPLE.id) +
        ' }); return p.constructor.constructor("return typeof process")();',
    );
    expect(kind).toBe("undefined");
  });

  test("a value that cannot cross the boundary is rejected", async () => {
    await expect(runGuestCell("return Symbol('x')")).rejects.toThrow(
      /cannot cross the boundary/,
    );
  });
});

describe("async cells and resource ceilings", () => {
  test("awaits promises and tool calls", async () => {
    expect(await runGuestCell("return await Promise.resolve(41) + 1")).toBe(42);
    const id = await runGuestCell(
      'const r = await tools.query_profiles({ field: "sharp", limit: 1 }); return r.rows[0].id;',
    );
    expect(typeof id).toBe("string");
  });

  test("an awaited rejection surfaces as a guest failure", async () => {
    await expect(
      runGuestCell('await Promise.reject(new Error("nope"))'),
    ).rejects.toThrow(/nope/);
  });

  test("a never-settling promise waits for the host deadline, not longer", async () => {
    const started = performance.now();
    await expect(
      runGuestCell("await new Promise(() => {});", { timeoutMs: 50 }),
    ).rejects.toThrow(/exceeded 50ms/);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("infinite recursion is a guest stack overflow, not a host crash", async () => {
    await expect(
      runGuestCell("const f = () => f(); return f();"),
    ).rejects.toThrow(/guest cell failed/);
  });

  test("the heap cap stops runaway allocation", async () => {
    await expect(
      runGuestCell('let s = "x"; while (true) s += s;', {
        memoryLimitBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/guest cell failed|out of memory/);
  });

  test("the tool-call budget is per cell, not process-wide", async () => {
    const cell =
      "for (let i = 0; i < 3; i += 1) tools.get_profile({ id: " +
      JSON.stringify(SAMPLE.id) +
      ' }); return "ok";';
    expect(await runGuestCell(cell, { maxToolCalls: 3 })).toBe("ok");
    expect(await runGuestCell(cell, { maxToolCalls: 3 })).toBe("ok");
  });

  test("a guest can catch a host tool error and read its message", async () => {
    const message = await runGuestCell(
      'try { tools.query_profiles({ field: "nope" }); } catch (e) { return e.message; }',
    );
    expect(message).toContain("field required");
  });
});

describe("option normalization and error shapes", () => {
  test("invalid option values fall back to the defaults", async () => {
    expect(await runGuestCell("return 1", { timeoutMs: 0 })).toBe(1);
    expect(await runGuestCell("return 1", { maxToolCalls: 0 })).toBe(1);
    expect(await runGuestCell("return 1", { memoryLimitBytes: 1 })).toBe(1);
  });

  test("the tool budget is exact and floors fractional values", async () => {
    const twoCalls =
      "for (let i = 0; i < 2; i += 1) tools.get_profile({ id: " +
      JSON.stringify(SAMPLE.id) +
      ' }); return "ok";';
    const threeCalls =
      "for (let i = 0; i < 3; i += 1) tools.get_profile({ id: " +
      JSON.stringify(SAMPLE.id) +
      ' }); return "ok";';
    expect(await runGuestCell(twoCalls, { maxToolCalls: 2 })).toBe("ok");
    await expect(runGuestCell(threeCalls, { maxToolCalls: 2 })).rejects.toThrow(
      /MAX_CALLS/,
    );
    expect(await runGuestCell(twoCalls, { maxToolCalls: 2.9 })).toBe("ok");
    await expect(
      runGuestCell(threeCalls, { maxToolCalls: 2.9 }),
    ).rejects.toThrow(/MAX_CALLS/);
  });

  test("a zero-argument tool call marshals undefined", async () => {
    expect(await runGuestCell("return tools.get_profile_summary()")).toEqual(
      oracleSummary(),
    );
  });

  test("a syntax error is a guest failure", async () => {
    await expect(runGuestCell("return )")).rejects.toThrow(/guest cell failed/);
  });

  test("a non-Error throw is still described", async () => {
    await expect(runGuestCell("throw 42")).rejects.toThrow(/42/);
  });
});

describe("argument marshalling budgets", () => {
  test("a huge guest array is rejected before it reaches the host", async () => {
    await expect(
      runGuestCell(
        'const a = new Array(2000000).fill(0); return tools.query_profiles({ field: "clv", limit: 1, junk: a })',
        { timeoutMs: 3000 },
      ),
    ).rejects.toThrow(/ARGUMENT_TOO_LARGE/);
  });

  test("a cyclic argument fails cleanly instead of hanging", async () => {
    await expect(
      runGuestCell("const a = {}; a.self = a; return tools.query_profiles(a)", {
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(/circular|guest cell failed/);
  });

  test("a deeply nested argument no longer aborts the QuickJS runtime", async () => {
    const result = await runGuestCell(
      'let o = {}; let c = o; for (let i = 0; i < 20000; i += 1) { c.n = {}; c = c.n; } return tools.query_profiles({ field: "clv", limit: 1, junk: o })',
      { timeoutMs: 3000 },
    );
    expect(result).toMatchObject({ field: "clv" });
    expect((result as { rows: unknown[] }).rows).toHaveLength(1);
  });

  test("non-JSON values are dropped by the packing boundary", async () => {
    const result = await runGuestCell(
      'return tools.query_profiles({ field: "clv", limit: 1, junk: () => 1 })',
    );
    expect((result as { rows: unknown[] }).rows).toHaveLength(1);
    await expect(
      runGuestCell("return tools.query_profiles(() => 1)"),
    ).rejects.toThrow(/ARGUMENT_UNSUPPORTED|guest cell failed/);
  });
});
