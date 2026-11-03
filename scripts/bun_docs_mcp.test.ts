import { describe, expect, test } from "bun:test";

import {
  auditPinnedBunFacts,
  BunDocsMcp,
  MCP_TOOL_NAMES,
  probeBunDocsMcp,
} from "./bun_docs_mcp.ts";

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

function fakeClient(
  handler: (request: RpcRequest) => unknown,
  contentType = "application/json",
): BunDocsMcp {
  return new BunDocsMcp("http://mcp.test", async (_url, init) => {
    const request = JSON.parse(String(init.body)) as RpcRequest;
    const result = handler(request);
    const envelope = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
    return new Response(
      contentType === "text/event-stream" ? `data: ${envelope}\n\n` : envelope,
      { headers: { "content-type": contentType } },
    );
  });
}

const tools = MCP_TOOL_NAMES.map((name) => ({ name }));

describe("Bun docs MCP client", () => {
  test("probe validates the four documented tools and bun://skill", async () => {
    const requests: string[] = [];
    const client = fakeClient((request) => {
      requests.push(request.method);
      if (request.method === "initialize") {
        return {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "Bun", version: "1.0.0" },
          tools: { listChanged: false },
          resources: { listChanged: false },
        };
      }
      if (request.method === "tools/list") return { tools };
      if (request.method === "resources/list") {
        return {
          resources: [{ uri: "bun://skill", mimeType: "text/markdown" }],
        };
      }
      throw new Error(`unexpected ${request.method}`);
    });
    const probe = await probeBunDocsMcp(client);
    expect(probe).toEqual({
      server: "Bun",
      version: "1.0.0",
      tools: [...MCP_TOOL_NAMES],
      resources: ["bun://skill"],
      requiredToolsPresent: true,
      skillPresent: true,
    });
    expect(requests).toEqual(["initialize", "tools/list", "resources/list"]);
  });

  test("tool calls forward arguments and parse text content", async () => {
    let captured: unknown;
    const client = fakeClient((request) => {
      if (request.method !== "tools/call") throw new Error(request.method);
      captured = request.params;
      return { content: [{ type: "text", text: "hit" }] };
    });
    expect(
      await client.callTool("search_bun", { query: "Bun.WebView", limit: 3 }),
    ).toBe("hit");
    expect(captured).toEqual({
      name: "search_bun",
      arguments: { query: "Bun.WebView", limit: 3 },
    });
  });

  test("accepts an SSE-framed JSON-RPC response", async () => {
    const client = fakeClient(
      (request) => (request.method === "tools/list" ? { tools } : {}),
      "text/event-stream",
    );
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      ...MCP_TOOL_NAMES,
    ]);
  });

  test("a missing tool fails the contract probe", async () => {
    const client = fakeClient((request) => {
      if (request.method === "initialize") {
        return {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "Bun", version: "1.0.0" },
        };
      }
      if (request.method === "tools/list") return { tools: tools.slice(0, 2) };
      return { resources: [{ uri: "bun://skill" }] };
    });
    expect((await probeBunDocsMcp(client)).requiredToolsPresent).toBe(false);
  });
});

describe("MCP tool-error and audit semantics", () => {
  test("a tool result with isError:true throws instead of returning the error text", async () => {
    const client = fakeClient(() => ({
      content: [
        { type: "text", text: "MCP error -32602: Tool nope not found" },
      ],
      isError: true,
    }));
    await expect(client.callTool("nope", {})).rejects.toThrow(
      /MCP tool nope failed: MCP error -32602/,
    );
  });

  test("audit flags the stale skill type-checking line while docs checks pass", async () => {
    const client = fakeClient((request) => {
      if (request.method === "tools/call") {
        const params = request.params as {
          name: string;
          arguments?: { query?: string; path?: string };
        };
        if (params.name === "read_bun_page") {
          return {
            content: [
              {
                type: "text",
                text: "headless | `boolean` | `true` | Only `true` is implemented; `false` throws.",
              },
            ],
          };
        }
        const query = params.arguments?.query ?? "";
        if (query.includes("bun check")) {
          return { content: [{ type: "text", text: "bun check type checks" }] };
        }
        if (query.includes("--inspect-wait")) {
          return { content: [{ type: "text", text: "--inspect-wait waits" }] };
        }
        return {
          content: [{ type: "text", text: "Bun flags immediately after bun" }],
        };
      }
      if (request.method === "resources/read") {
        return {
          contents: [
            {
              uri: "bun://skill",
              text: "## Don't use Bun for\n- Type-checking or emitting `.d.ts` — Bun strips types; run `tsc` for that.",
            },
          ],
        };
      }
      throw new Error(`unexpected ${request.method}`);
    });
    const audit = await auditPinnedBunFacts(client);
    expect(audit.drift).toEqual(["skill-typechecking-line"]);
    expect(audit.checks.map((check) => check.id)).toEqual([
      "bun-check-documented",
      "inspect-wait-documented",
      "webview-headless-true-only",
      "flags-before-run-documented",
      "skill-typechecking-line",
    ]);
  });
});
