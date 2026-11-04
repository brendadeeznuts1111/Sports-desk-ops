import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { WebViewError } from "../scripts/capture/webview.ts";
import {
  createDxMcpServer,
  runShotTool,
  shotRequest,
  type McpShotResult,
} from "../scripts/mcp_dx_server.ts";

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createDxMcpServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const RESULT: McpShotResult = {
  screenshot: "/tmp/s.png",
  screenshotUrl: "file:///tmp/s.png",
  bytes: 10,
  sha256: "ab".repeat(32),
  mimeType: "image/png",
  backend: "webkit",
  format: "png",
  encoding: "blob",
  title: "Example Domain",
  url: "https://example.com/",
};

describe("dx MCP server", () => {
  test("lists exactly the shot tool, with no login, profile, cookie or path input", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["shot"]);
    const keys = Object.keys(tools[0]!.inputSchema.properties ?? {});
    expect(keys).toContain("url");
    for (const forbidden of [
      "f402Login",
      "profile",
      "cookies",
      "out",
      "encoding",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    await client.close();
  });

  test("declares it writes files, never deletes, and is not idempotent", async () => {
    const client = await connectedClient();
    const [tool] = (await client.listTools()).tools;
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    await client.close();
  });

  test("publishes an output schema for the file result", async () => {
    const client = await connectedClient();
    const [tool] = (await client.listTools()).tools;
    expect(tool!.outputSchema?.type).toBe("object");
    expect(tool!.outputSchema?.required).toEqual(
      expect.arrayContaining(["screenshot", "screenshotUrl", "sha256", "url"]),
    );
    expect(Object.keys(tool!.outputSchema?.properties ?? {})).not.toContain(
      "cookies",
    );
    await client.close();
  });

  test("a non-http(s) URL is rejected by the schema before any WebView launches", async () => {
    const client = await connectedClient();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "nope"]) {
      const result = await client.callTool({
        name: "shot",
        arguments: { url },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "Input validation error",
      );
    }
    await client.close();
  });
});

describe("shotRequest", () => {
  test("never signs in, reads a profile or collects cookies", () => {
    const request = shotRequest({ url: "https://example.com" });
    expect(request.f402Login).toBe(false);
    expect(request.profile).toBeNull();
    expect(request.cookies).toBe(false);
    expect(request.encoding).toBe("blob");
  });

  test("writes under the repo's scratch/shots with the format's extension", () => {
    const request = shotRequest({ url: "https://example.com", format: "jpeg" });
    expect(request.out).toMatch(
      /\/scratch\/shots\/webview-[0-9a-f-]{36}\.jpg$/,
    );
  });

  test("timeoutMs passes through, defaulting to the CLI's 20000", () => {
    expect(shotRequest({ url: "https://example.com" }).timeoutMs).toBe(20_000);
    expect(
      shotRequest({ url: "https://example.com", timeoutMs: 45_000 }).timeoutMs,
    ).toBe(45_000);
  });
});

describe("runShotTool", () => {
  test("returns structuredContent plus the same JSON as text", async () => {
    const result = await runShotTool(
      { url: "https://example.com" },
      async () => RESULT,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ...RESULT });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(RESULT) },
    ]);
  });

  test("a WebView failure is an isError result naming the code, reason and next step", async () => {
    const result = await runShotTool({ url: "https://example.com" }, () =>
      Promise.reject(
        new WebViewError("load-timeout", "load did not finish in 20000ms"),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: "load-timeout: load did not finish in 20000ms. Next: retry with a higher timeout or retries 1-5, or check the host",
      },
    ]);
  });

  test("any other error propagates to the SDK", async () => {
    await expect(
      runShotTool({ url: "https://example.com" }, () =>
        Promise.reject(new TypeError("bug")),
      ),
    ).rejects.toThrow("bug");
  });
});
