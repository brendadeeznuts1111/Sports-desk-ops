import { describe, expect, test } from "bun:test";
import {
  auditModuleBindings,
  fetchCloudflareBindingInventory,
  summarizeBindings,
  type BindingInventory,
} from "../scripts/cloudflare/binding_inventory.ts";

const ACCOUNT = "a".repeat(32);
const TOKEN = "TEST_ONLY_TOKEN_DO_NOT_LOG";
const current: BindingInventory = {
  discoveredWorkers: ["sports-ops-desk", "bookdeskops"],
  workers: [
    { name: "sports-ops-desk", bindings: [
      { name: "MCP_LIMITER", type: "durable_object_namespace", target: "McpLimiter" },
      { name: "SIGNAL_STORE", type: "durable_object_namespace" },
      { name: "DESK_ARCHIVE", type: "r2_bucket" },
    ] },
    { name: "bookdeskops", bindings: [{ name: "PUBLIC_ORIGIN", type: "plain_text" }] },
  ],
  failures: [],
};

describe("Cloudflare binding contract (pure)", () => {
  test("distinguishes bound modules from an intentionally inactive optional API bridge", () => {
    const checks = auditModuleBindings(current);
    expect(checks.find((x) => x.module === "sportsdesk.mcp-limit")?.status).toBe("bound");
    expect(checks.find((x) => x.module === "bookdeskops.ops-proxy")?.status).toBe("inactive");
    expect(checks.find((x) => x.module === "bookdeskops.api")?.status).toBe("bound");
    expect(checks.find((x) => x.module === "bookdeskops.api")?.basis).toBe("source");
    expect(checks.find((x) => x.module === "sportsdesk.mcp-limit")?.basis).toBe("deployment_snapshot");
  });
  test("missing required bindings, incompatible types and unreadable settings are different states", () => {
    const base = { ...current, workers: [{ name: "sports-ops-desk", bindings: [{ name: "MCP_LIMITER", type: "kv_namespace" }] }] };
    const mismatches = auditModuleBindings(base, "sports-ops-desk");
    expect(mismatches.find((x) => x.binding === "MCP_LIMITER")?.status).toBe("wrong_type");
    expect(mismatches.find((x) => x.binding === "SIGNAL_STORE")?.status).toBe("missing");
    expect(auditModuleBindings({ ...base, failures: [{ worker: "sports-ops-desk", reason: "HTTP 403" }] }, "sports-ops-desk").every((x) => x.status === "unverified")).toBe(true);
  });
  test("plain text and secret values, IDs and arbitrary metadata cannot appear in output", () => {
    const bindings = summarizeBindings([
      { name: "API_TOKEN", type: "secret_text", text: "DO_NOT_LEAK", value: "DO_NOT_LEAK" },
      { name: "PUBLIC_ORIGIN", type: "plain_text", text: "DO_NOT_LEAK", value: "DO_NOT_LEAK" },
      { name: "DESK_ARCHIVE", type: "r2_bucket", bucket_name: "desk-archive", id: "PRIVATE_ID" },
      { name: "MCP_LIMITER", type: "durable_object_namespace", class_name: "McpLimiter", namespace_id: "PRIVATE_ID" },
    ]);
    expect(bindings).toEqual([
      { name: "API_TOKEN", type: "secret_text" },
      { name: "DESK_ARCHIVE", type: "r2_bucket", target: "desk-archive" },
      { name: "MCP_LIMITER", type: "durable_object_namespace", target: "McpLimiter" },
      { name: "PUBLIC_ORIGIN", type: "plain_text" },
    ]);
    expect(JSON.stringify(bindings)).not.toContain("DO_NOT_LEAK");
    expect(JSON.stringify(bindings)).not.toContain("PRIVATE_ID");
  });
});

describe("Cloudflare binding inventory HTTP", () => {
  test("performs GET-only calls, honors worker filter, never emits secret values", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      calls.push({ url: String(url), method: init?.method ?? "" });
      const result = pathname.endsWith("/workers/scripts")
        ? [{ id: "sports-ops-desk" }, { id: "bookdeskops" }]
        : { bindings: [
          { name: "MCP_LIMITER", type: "durable_object_namespace", class_name: "McpLimiter", namespace_id: "PRIVATE_ID" },
          { name: "DESK_ADMIN_TOKEN", type: "secret_text", text: "DO_NOT_LEAK" },
        ] };
      return Response.json({ success: true, result });
    };
    const result = await fetchCloudflareBindingInventory(ACCOUNT, TOKEN, "sports-ops-desk", fetcher);
    expect(calls.map((x) => x.method)).toEqual(["GET", "GET"]);
    expect(calls).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(result.discoveredWorkers).toEqual(["bookdeskops", "sports-ops-desk"]);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]?.bindings.map((x) => x.name)).toEqual(["DESK_ADMIN_TOKEN", "MCP_LIMITER"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_LEAK");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ID");
  });
  test("settings 403 is unverified, not asserted missing", async () => {
    const fetcher: typeof fetch = async (url) => String(url).includes("/settings")
      ? new Response("forbidden", { status: 403 })
      : Response.json({ success: true, result: [{ id: "sports-ops-desk" }] });
    const result = await fetchCloudflareBindingInventory(ACCOUNT, TOKEN, undefined, fetcher);
    expect(result.failures).toEqual([{ worker: "sports-ops-desk", reason: "HTTP 403" }]);
    expect(auditModuleBindings(result, "sports-ops-desk").every((x) => x.status === "unverified")).toBe(true);
  });
  test("failed discovery fails closed and does not pretend account is empty", async () => {
    const denied: typeof fetch = async () => new Response("denied", { status: 403 });
    await expect(fetchCloudflareBindingInventory(ACCOUNT, TOKEN, undefined, denied)).rejects.toThrow("HTTP 403");
  });
  test("registered Worker absent from inventory is not_deployed, not a missing binding", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ success: true, result: [] });
    const result = await fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, "bookdeskops", fetcher,
    );
    expect(result.discoveredWorkers).toEqual([]);
    expect(result.workers).toEqual([]);
    const checks = auditModuleBindings(result, "bookdeskops");
    expect(checks.every((entry) => entry.status === "not_deployed")).toBe(true);
  });

  test("a listed Worker without readable settings never reports a missing binding", () => {
    const result: BindingInventory = {
      discoveredWorkers: ["bookdeskops"],
      workers: [],
      failures: [],
    };
    const checks = auditModuleBindings(result, "bookdeskops");
    expect(checks.every((entry) => entry.status === "unverified")).toBe(true);
  });

  test("uses pagination total_pages even when the first page is short", async () => {
    const requested: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      const address = String(url);
      requested.push(address);
      if (address.includes("/workers/scripts?")) {
        const page = new URL(address).searchParams.get("page");
        return Response.json({
          success: true,
          result: page === "1"
            ? [{ id: "sports-ops-desk" }]
            : [{ id: "bookdeskops" }, { id: "deepseek-chat" }],
          result_info: { total_pages: 2 },
        });
      }
      return Response.json({ success: true, result: { bindings: [] } });
    };
    const result = await fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, undefined, fetcher,
    );
    expect(result.discoveredWorkers).toEqual([
      "bookdeskops", "sports-ops-desk",
    ]);
    expect(result.workers).toHaveLength(2);
    expect(requested.filter((url) => url.includes("/workers/scripts?"))).toHaveLength(2);
    expect(requested.some((url) => url.includes("/deepseek-chat/settings"))).toBe(false);
  });

  test("a malformed binding record fails the settings read closed", async () => {
    const fetcher: typeof fetch = async (url) =>
      String(url).includes("/settings")
        ? Response.json({
            success: true,
            result: { bindings: [{ name: "MCP_LIMITER", text: "DO_NOT_LEAK" }] },
          })
        : Response.json({ success: true, result: [{ id: "sports-ops-desk" }] });
    const result = await fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, "sports-ops-desk", fetcher,
    );
    expect(result.failures).toEqual([
      { worker: "sports-ops-desk", reason: "metadata unavailable" },
    ]);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_LEAK");
    expect(auditModuleBindings(result, "sports-ops-desk").every((entry) =>
      entry.status === "unverified")).toBe(true);
  });

  test("an oversized page count fails discovery instead of reporting false absence", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ success: true, result: [], result_info: { total_pages: 21 } });
    await expect(fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, undefined, fetcher,
    )).rejects.toThrow("Invalid Worker pagination metadata");
  });

  test("null or duplicate binding entries fail closed", () => {
    expect(() => summarizeBindings([null])).toThrow(
      "Malformed Worker binding metadata",
    );
    expect(() => summarizeBindings([
      { name: "PUBLIC_ORIGIN", type: "plain_text" },
      { name: "PUBLIC_ORIGIN", type: "plain_text" },
    ])).toThrow("Duplicate Worker binding metadata");
  });

  test("a zero-page declaration with Worker entries is not a valid complete list", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      success: true,
      result: [{ id: "bookdeskops" }],
      result_info: { total_pages: 0 },
    });
    await expect(fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, undefined, fetcher,
    )).rejects.toThrow("Invalid Worker pagination metadata");
  });

  test("the tool cannot select unrelated account Workers", async () => {
    const rejectIfCalled: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    await expect(fetchCloudflareBindingInventory(
      ACCOUNT, TOKEN, "deepseek-chat", rejectIfCalled,
    )).rejects.toThrow("Worker is not in the module registry");
  });

  test("worker name cannot escape an API path", async () => {
    const rejectIfCalled: typeof fetch = async () => { throw new Error("should not fetch"); };
    await expect(fetchCloudflareBindingInventory(ACCOUNT, TOKEN, "../../secrets", rejectIfCalled)).rejects.toThrow("Invalid Worker name");
  });
});
