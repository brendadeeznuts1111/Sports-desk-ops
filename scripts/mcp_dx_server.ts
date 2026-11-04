#!/usr/bin/env bun
/**
 * @file scripts/mcp_dx_server.ts
 * @description stdio MCP server exposing `dx shot` as the `shot` tool over the same capture path as
 * the CLI (scripts/capture/shot.ts).
 *
 * Usage (MCP client config):
 *   { "command": "bun", "args": ["run", "<repo>/scripts/mcp_dx_server.ts"] }
 *
 * The tool only captures public http(s) pages into scratch/shots/: it takes no login, profile,
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

const REPO_ROOT = join(import.meta.dir, "..");

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
  return server;
}

if (import.meta.main) {
  await createDxMcpServer().connect(new StdioServerTransport());
}
