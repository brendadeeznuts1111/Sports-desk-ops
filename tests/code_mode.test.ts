import { describe, expect, test } from "bun:test";
import {
  CodeModeRunner,
  createSportsdeskCodeModeRunner,
} from "../lib/code_mode.ts";
import { executeProfileCodeMode } from "../lib/code_mode_profile.ts";

describe("CodeModeRunner", () => {
  test("executes multiple tools with in-memory filtering and token reduction telemetry", async () => {
    const runner = new CodeModeRunner();

    runner.registerTool({
      name: "fetchUsers",
      description: "Fetches user records",
      handler: () => [
        { id: 1, name: "Alice", active: true, balance: 5000 },
        { id: 2, name: "Bob", active: false, balance: 100 },
        { id: 3, name: "Charlie", active: true, balance: 9500 },
      ],
    });

    runner.registerTool({
      name: "getExchangeRate",
      description: "Fetches current USD conversion rate",
      handler: () => ({ rate: 1.25 }),
    });

    const script = `
      interface User { id: number; name: string; active: boolean; balance: number; }
      const users: User[] = await tools.fetchUsers();
      const { rate } = await tools.getExchangeRate();

      const highValueActive = users
        .filter((u: User) => u.active && u.balance > 1000)
        .map((u: User) => ({ name: u.name, eur: u.balance * rate }));

      return highValueActive;
    `;

    const result = await runner.execute(script);

    expect(result.success).toBe(true);
    expect(result.result).toEqual([
      { name: "Alice", eur: 6250 },
      { name: "Charlie", eur: 11875 },
    ]);
    expect(result.telemetry.totalToolCalls).toBe(2);
    expect(result.telemetry.rawToolBytes).toBeGreaterThan(0);
    expect(result.telemetry.outputBytes).toBeGreaterThan(0);
    expect(result.telemetry.tokenSavingsRatio).toBeGreaterThan(1);
  });

  test("captures console logs without polluting stdout", async () => {
    const runner = new CodeModeRunner();
    runner.registerTool({
      name: "ping",
      description: "Ping tool",
      handler: () => "pong",
    });

    const script = `
      console.log("Starting execution...");
      const res = await tools.ping();
      console.log("Ping response:", res);
      return res;
    `;

    const result = await runner.execute(script);
    expect(result.success).toBe(true);
    expect(result.result).toBe("pong");
    expect(result.logs.length).toBe(2);
    expect(result.logs[0]).toBe("Starting execution...");
    expect(result.logs[1]).toBe("Ping response: pong");
  });

  test("enforces execution timeout guard", async () => {
    const runner = new CodeModeRunner();
    runner.registerTool({
      name: "hang",
      description: "Simulates hung tool",
      handler: () => new Promise((resolve) => setTimeout(resolve, 500)),
    });

    const script = `
      await tools.hang();
      return "done";
    `;

    const result = await runner.execute(script, { timeoutMs: 50 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("ERR_CODE_MODE_TIMEOUT");
  });

  test("guards against runaway tool call loops via maxToolCalls", async () => {
    const runner = new CodeModeRunner();
    let count = 0;
    runner.registerTool({
      name: "tick",
      description: "Increment counter",
      handler: () => ++count,
    });

    const script = `
      while (true) {
        await tools.tick();
      }
    `;

    const result = await runner.execute(script, { maxToolCalls: 5 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("ERR_CODE_MODE_MAX_CALLS_EXCEEDED");
    expect(result.telemetry.totalToolCalls).toBe(5);
  });

  test("generates ambient TypeScript definitions (.d.ts) for prompt injection", () => {
    const runner = new CodeModeRunner();
    runner.registerTool({
      name: "queryPositions",
      description: "Queries open trading desk positions",
      handler: () => [],
    });

    const dts = runner.generateTypeDeclarations();
    expect(dts).toContain("declare namespace tools {");
    expect(dts).toContain(
      "queryPositions(args?: Record<string, unknown>): Promise<any>;",
    );
  });

  test("query_profiles + get_profile in one guest cell (sentinels opt-in)", async () => {
    const script = `
      const def = await tools.query_profiles({ field: "clv", limit: 20 });
      const all = await tools.query_profiles({
        field: "clv",
        limit: 20,
        includeSentinels: true,
      });
      const sentinelIds = all.rows.filter((r) => r.sentinel).map((r) => r.id);
      const firstId = def.rows[0].id;
      const profile = await tools.get_profile({ id: firstId });
      return {
        defaultCount: def.rows.length,
        withSentinels: all.rows.length,
        sentinelCount: sentinelIds.length,
        profileFound: typeof profile.vol === "number",
        sentinelSuperset: all.rows.length >= def.rows.length,
      };
    `;
    const result = await executeProfileCodeMode(script, "guest");
    expect(result).toMatchObject({
      profileFound: true,
      sentinelSuperset: true,
    });
    expect((result as { sentinelCount: number }).sentinelCount).toBeGreaterThan(
      0,
    );
  });

  test("desk host runner does not register profile tools", () => {
    const runner = createSportsdeskCodeModeRunner();
    const names = new Set(runner.listTools().map((t) => t.name));
    expect(names.has("query_profiles")).toBe(false);
    expect(names.has("get_profile")).toBe(false);
    expect(names.has("get_profile_summary")).toBe(false);
  });

  test("executes pre-wired sportsdesk toolset", async () => {
    const runner = createSportsdeskCodeModeRunner();
    const script = `
      const prov = await tools.get_channel_provenance({ channel: 'GSLIVE' });
      const channels = prov.structuredContent.channels;
      return channels.find(c => c.channelCode === 'GSLIVE')?.operationalRole;
    `;

    const result = await runner.execute(script);
    expect(result.success).toBe(true);
    expect(result.result).toBe("Whale Sizing Anomaly & In-Play Live Move");
  });
});
