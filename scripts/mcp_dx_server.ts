#!/usr/bin/env bun
/**
 * @file scripts/mcp_dx_server.ts
 * @description stdio MCP server exposing the `shot` and read-only Cloudflare binding tools.
 * The screenshot tool follows the CLI capture path (scripts/capture/shot.ts).
 *
 * Usage (MCP client config):
 *   { "command": "bun", "args": ["run", "<repo>/scripts/mcp_dx_server.ts"] }
 *
 * The shot tool only accepts http(s) URLs and writes under scratch/shots/: it takes no login, profile,
 * cookie or output-path input, so an MCP client cannot reach a signed-in portal session or write
 * outside the shots directory. Stdout carries the protocol; nothing else may write to it.
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  captureShotFile,
  DEFAULT_SHOT_DIR,
  defaultShotPath,
  describeShotError,
  openShotView,
  withView,
  type ShotFileRequest,
  type ShotFileResult,
} from "./capture/shot.ts";
import { WebViewError } from "./capture/webview.ts";
import {
  auditModuleBindings,
  fetchCloudflareBindingInventory,
  type BindingInventory,
} from "./cloudflare/binding_inventory.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** A Worker name is the only Cloudflare-specific client input. No credential or URL fields. */
const CLOUDFLARE_BINDINGS_INPUT = {
  worker: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
};
const CLOUDFLARE_BINDINGS_OUTPUT = {
  discoveredWorkers: z.array(z.string()),
  workers: z.array(z.object({
    name: z.string(),
    bindings: z.array(z.object({
      name: z.string(), type: z.string(), target: z.string().optional(),
    })),
  })),
  failures: z.array(z.object({ worker: z.string(), reason: z.string() })),
  checks: z.array(z.object({
    module: z.string(),
    worker: z.string(),
    binding: z.string(),
    type: z.string(),
    required: z.boolean(),
    basis: z.enum(["source", "deployment_snapshot"]),
    api: z.string().optional(),
    status: z.enum(["bound", "missing", "wrong_type", "inactive", "not_deployed", "unverified"]),
  })),
};
type CloudflareBindingsInput = z.infer<z.ZodObject<typeof CLOUDFLARE_BINDINGS_INPUT>>;

export const SHOT_INPUT = {
  url: z.url({ protocol: /^https?$/ }).describe("The http(s) page to capture"),
  backend: z
    .enum(["webkit", "chrome"])
    .optional()
    .describe("webkit (macOS default) or chrome"),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  width: z.number().int().min(320).max(16384).optional(),
  height: z.number().int().min(240).max(16384).optional(),
  waitSelector: z
    .string()
    .min(1)
    .optional()
    .describe("Wait for this CSS selector before the screenshot"),
  thumb: z
    .number()
    .int()
    .min(16)
    .max(2048)
    .optional()
    .describe("Also write a WebP thumbnail that fits in thumb x thumb px"),
  placeholder: z
    .boolean()
    .optional()
    .describe("Include the ThumbHash data: URL"),
  console: z
    .boolean()
    .optional()
    .describe("Include the redacted page console (at most 200 lines)"),
  retries: z.number().int().min(0).max(5).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .describe("Navigation and selector timeout (default 20000)"),
};

type ShotInput = z.infer<z.ZodObject<typeof SHOT_INPUT>>;

export function shotRequest(input: ShotInput): ShotFileRequest {
  const format = input.format ?? "png";
  return {
    url: input.url,
    out: defaultShotPath(format, join(REPO_ROOT, DEFAULT_SHOT_DIR)),
    width: input.width ?? 1440,
    height: input.height ?? 900,
    backend:
      input.backend ?? (process.platform === "darwin" ? "webkit" : "chrome"),
    format,
    encoding: "blob",
    quality: 82,
    resize: null,
    waitSelector: input.waitSelector ?? null,
    waitMs: 250,
    timeoutMs: input.timeoutMs ?? 20_000,
    retries: input.retries ?? 0,
    f402Login: false,
    f402Page: "/",
    profile: null,
    thumb: input.thumb ?? null,
    placeholder: input.placeholder === true,
    console: input.console === true,
    cookies: false,
  };
}

/** The file result minus what {@link shotRequest} never asks for. */
export type McpShotResult = Omit<
  ShotFileResult,
  "profile" | "signedOutMarkers" | "cookies" | "blob"
>;

/** Keys and types are checked against {@link McpShotResult}: a field added there fails here. */
const SHOT_OUTPUT = {
  screenshot: z.string(),
  screenshotUrl: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  mimeType: z.string(),
  backend: z.enum(["webkit", "chrome"]),
  format: z.enum(["png", "jpeg", "webp"]),
  encoding: z.enum(["blob", "buffer", "base64", "shmem"]),
  title: z.string(),
  url: z.string(),
  thumb: z.string().optional(),
  placeholder: z.string().optional(),
  console: z
    .array(
      z.object({ level: z.enum(["log", "error", "warn"]), text: z.string() }),
    )
    .optional(),
} satisfies {
  readonly [K in keyof Required<McpShotResult>]: z.ZodType<McpShotResult[K]>;
};

export function captureForMcp(
  request: ShotFileRequest,
): Promise<McpShotResult> {
  return withView(
    () => openShotView(request),
    (view) => captureShotFile(view, request),
  );
}

export async function runShotTool(
  input: ShotInput,
  capture: (request: ShotFileRequest) => Promise<McpShotResult> = captureForMcp,
): Promise<CallToolResult> {
  try {
    const result = await capture(shotRequest(input));
    return {
      structuredContent: { ...result },
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    if (!(error instanceof WebViewError)) throw error;
    return {
      isError: true,
      content: [{ type: "text", text: describeShotError(error) }],
    };
  }
}

async function readCloudflareBindingInventory(worker?: string): Promise<BindingInventory> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AUDIT_TOKEN;
  if (!accountId || !token) {
    throw new Error("Cloudflare read-only account ID or audit token is not configured");
  }
  return fetchCloudflareBindingInventory(accountId, token, worker);
}

/** The dependency can be injected for tests; it is never read on MCP startup. */
export async function runCloudflareBindingsTool(
  input: CloudflareBindingsInput,
  read: (worker?: string) => Promise<BindingInventory> = readCloudflareBindingInventory,
): Promise<CallToolResult> {
  try {
    const inventory = await read(input.worker);
    const result = { ...inventory, checks: auditModuleBindings(inventory, input.worker) };
    return {
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    // A fetch/client failure may contain URLs, headers, or tokens. Never return it verbatim.
    const safe = error instanceof Error &&
      /^(Cloudflare read-only account ID or audit token is not configured|Invalid Worker name|Worker is not in the account or module registry|HTTP [0-9]{3})$/.test(error.message)
      ? error.message
      : "Cloudflare metadata unavailable; verify read-only token scope and network";
    return { isError: true, content: [{ type: "text", text: safe }] };
  }
}

export function createDxMcpServer(): McpServer {
  const server = new McpServer({
    name: "dx",
    version: "1.0.0",
    title: "Sports desk operations",
  });
  server.registerTool(
    "shot",
    {
      title: "Capture a page",
      description:
        "Open a public http(s) URL in Bun.WebView and write a new screenshot under scratch/shots/. Returns the dx shot --json result: screenshot path, screenshotUrl, sha256, title, final url, and optional thumb, placeholder and console. Each call writes a new file.",
      inputSchema: SHOT_INPUT,
      outputSchema: SHOT_OUTPUT,
      annotations: {
        title: "Capture page screenshot",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) => runShotTool(input),
  );
  server.registerTool(
    "cloudflare_bindings",
    {
      title: "Audit Cloudflare Worker module bindings",
      description:
        "Read-only Worker binding metadata for registered modules and API contract drift. Requires CLOUDFLARE_ACCOUNT_ID and separately scoped CLOUDFLARE_AUDIT_TOKEN in the MCP process. Never fetches secret values, calls business APIs, changes configuration or deploys.",
      inputSchema: CLOUDFLARE_BINDINGS_INPUT,
      outputSchema: CLOUDFLARE_BINDINGS_OUTPUT,
      annotations: {
        title: "Audit Worker binding metadata",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input) => runCloudflareBindingsTool(input),
  );
  return server;
}

if (import.meta.main) {
  await createDxMcpServer().connect(new StdioServerTransport());
}
