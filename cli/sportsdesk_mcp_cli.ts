#!/usr/bin/env bun
/**
 * @file cli/sportsdesk_mcp_cli.ts
 * @description Standalone Bun StreamableHTTP MCP server CLI exposing `/mcp` and `/health`.
 *
 * Usage:
 *   SPORTSDESK_ADMIN_TOKEN=... bun run cli/sportsdesk_mcp_cli.ts [--port 4021] [--stateless]
 *   bun run cli/sportsdesk_mcp_cli.ts --no-auth --port 4021          # loopback-only dev mode
 */

import { parseArgs } from "node:util";
import type { Server } from "bun";
import {
  SPORTSDESK_MCP_SERVER_NAME,
  SPORTSDESK_MCP_SERVER_VERSION,
  SportsdeskMcpWireError,
  createSportsdeskMcpHttpHandler,
  resolveMcpAllowedOrigins,
  type SportsdeskMcpHttpHandler,
} from "../lib/sportsdesk_mcp_server.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const DEFAULT_STANDALONE_PORT = 4021;
const MAX_MCP_BODY_BYTES = 1 << 20;

export interface StandaloneMcpCliConfig {
  readonly help: boolean;
  readonly port: number;
  readonly hostname: string;
  readonly stateless: boolean;
  readonly enableJsonResponse: boolean;
  readonly requireAuth: boolean;
  readonly maxSessions: number;
  readonly jsonOutput: boolean;
}

function isLoopbackBindHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost"
  );
}

export function formatStandaloneMcpHelp(): string {
  return [
    "Usage: bun run mcp:serve -- [options]",
    "",
    "Start the native Bun StreamableHTTP MCP server (/mcp) for sportsdesk-ops.",
    "",
    "Options:",
    "  -p, --port <port>          TCP port to bind (0 for ephemeral; default: PORT or 4021)",
    "  -H, --hostname <host>      Bind address (default: HOST or 127.0.0.1)",
    "      --stateless            Disable Mcp-Session-Id state; isolate each HTTP request",
    "      --json-response        Return application/json instead of SSE on POST /mcp",
    "      --max-sessions <n>     Max concurrent stateful sessions (default: 256)",
    "      --no-auth              Disable SPORTSDESK_ADMIN_TOKEN Bearer check (loopback only)",
    "      --json                 Emit a single JSON readiness line on stdout",
    "  -h, --help                 Show this help message and exit",
    "",
    "Read-only MCP Tools (readOnlyHint=true, destructiveHint=false):",
    "  - get_channel_provenance",
    "  - get_bridge_channel_catalog",
    "  - check_sor_slippage",
    "  - decode_nsh_frame",
    "  - get_trading_desk_kpis_and_sport_tree",
    "  - get_live_line_trading_board",
    "  - get_active_bet_blotter",
    "  - get_liability_and_polymarket_liquidity",
    "",
    "Environment:",
    "  SPORTSDESK_ADMIN_TOKEN     Required Bearer token when --no-auth is not set",
    "  SPORTSDESK_ALLOWED_ORIGINS Comma-separated CORS origin allowlist",
    "",
    "Examples:",
    "  ./bin/dx exec --with SPORTSDESK_ADMIN_TOKEN -- bun run mcp:serve --port 4021",
    "  ./bin/dx exec --with SPORTSDESK_ADMIN_TOKEN -- bun run mcp:serve --stateless --port 4021",
    "  bun run mcp:serve --no-auth --port 4021",
  ].join("\n");
}

export function parseSportsdeskMcpCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): StandaloneMcpCliConfig {
  const parsed = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h", default: false },
      port: { type: "string", short: "p" },
      hostname: { type: "string", short: "H" },
      stateless: { type: "boolean", default: false },
      "json-response": { type: "boolean", default: false },
      "max-sessions": { type: "string" },
      "no-auth": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    return {
      help: true,
      port: DEFAULT_STANDALONE_PORT,
      hostname: "127.0.0.1",
      stateless: false,
      enableJsonResponse: false,
      requireAuth: true,
      maxSessions: 256,
      jsonOutput: false,
    };
  }

  const rawPort = parsed.values.port ?? env.PORT;
  let port = DEFAULT_STANDALONE_PORT;
  if (rawPort !== undefined && rawPort.trim() !== "") {
    const num = Number(rawPort);
    if (!Number.isInteger(num) || num < 0 || num > 65535) {
      throw new SportsdeskMcpWireError(
        "invalid_cli_arg",
        `Invalid --port value '${rawPort}': expected an integer in [0, 65535]`,
      );
    }
    port = num;
  }

  const hostname =
    (parsed.values.hostname ?? env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const requireAuth = !parsed.values["no-auth"];

  if (!requireAuth && !isLoopbackBindHost(hostname)) {
    throw new SportsdeskMcpWireError(
      "invalid_cli_arg",
      `Refusing --no-auth on non-loopback bind host '${hostname}'; bind to 127.0.0.1/localhost or configure SPORTSDESK_ADMIN_TOKEN.`,
    );
  }

  let maxSessions = 256;
  if (parsed.values["max-sessions"] !== undefined) {
    const parsedMax = Number(parsed.values["max-sessions"]);
    if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 10_000) {
      throw new SportsdeskMcpWireError(
        "invalid_cli_arg",
        `Invalid --max-sessions value '${parsed.values["max-sessions"]}': expected an integer in [1, 10000]`,
      );
    }
    maxSessions = parsedMax;
  }

  return {
    help: false,
    port,
    hostname,
    stateless:
      parsed.values.stateless === true ||
      /^(1|true)$/i.test(env.SPORTSDESK_MCP_STATELESS ?? ""),
    enableJsonResponse: parsed.values["json-response"] === true,
    requireAuth,
    maxSessions,
    jsonOutput: parsed.values.json === true,
  };
}

export interface StandaloneMcpServerHandle {
  readonly server: Server<undefined>;
  readonly mcpHandler: SportsdeskMcpHttpHandler;
  readonly url: URL;
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
}

export interface StandaloneMcpServerOptions {
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  readonly stateless?: boolean | undefined;
  readonly enableJsonResponse?: boolean | undefined;
  readonly requireAuth?: boolean | undefined;
  readonly maxSessions?: number | undefined;
  readonly sessionIdleTtlMs?: number | undefined;
  readonly resolveAuthToken?: (() => string | undefined) | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly policyEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

export function startStandaloneMcpServer(
  options: StandaloneMcpServerOptions = {},
): StandaloneMcpServerHandle {
  const hostname = options.hostname ?? "127.0.0.1";
  const requireAuth = options.requireAuth ?? true;
  if (!requireAuth && !isLoopbackBindHost(hostname)) {
    throw new SportsdeskMcpWireError(
      "invalid_cli_arg",
      `Refusing unauthenticated MCP server on non-loopback host '${hostname}'`,
    );
  }

  const isDevelopment = Bun.env.NODE_ENV !== "production";
  const allowedOrigins =
    options.allowedOrigins ?? resolveMcpAllowedOrigins(isDevelopment);

  const mcpHandler = createSportsdeskMcpHttpHandler({
    stateless: options.stateless === true,
    enableJsonResponse: options.enableJsonResponse === true,
    maxSessions: options.maxSessions ?? 256,
    ...(options.sessionIdleTtlMs !== undefined
      ? { sessionIdleTtlMs: options.sessionIdleTtlMs }
      : {}),
    requireAuth,
    ...(options.resolveAuthToken
      ? { resolveAuthToken: options.resolveAuthToken }
      : {}),
    allowedOrigins,
    ...(options.policyEnv ? { policyEnv: options.policyEnv } : {}),
  });

  const server = Bun.serve({
    port: options.port ?? DEFAULT_STANDALONE_PORT,
    hostname,
    idleTimeout: 120,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") {
        return mcpHandler.handleRequest(req);
      }
      if (
        url.pathname === "/health" &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        const body = {
          status: "ok",
          service: `${SPORTSDESK_MCP_SERVER_NAME}-mcp`,
          version: SPORTSDESK_MCP_SERVER_VERSION,
          mode: mcpHandler.stateless ? "stateless" : "stateful",
          authRequired: mcpHandler.requireAuth,
          activeSessions: mcpHandler.getActiveSessionCount(),
        };
        return Response.json(body, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      return Response.json(
        { error: "Not Found", pathname: url.pathname },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    },
  });

  const resolvedPort = server.port ?? options.port ?? DEFAULT_STANDALONE_PORT;
  const resolvedUrl =
    server.url ?? new URL(`http://${hostname}:${resolvedPort}/`);

  return {
    server,
    mcpHandler,
    url: resolvedUrl,
    port: resolvedPort,
    async stop(closeActiveConnections = true): Promise<void> {
      await mcpHandler.closeAll();
      server.stop(closeActiveConnections);
    },
  };
}

if (import.meta.main) {
  let config: StandaloneMcpCliConfig;
  try {
    config = parseSportsdeskMcpCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sportsdesk-mcp] ${message}`);
    process.exit(EXIT_USAGE);
  }

  if (config.help) {
    console.log(formatStandaloneMcpHelp());
    process.exit(EXIT_OK);
  }

  if (!config.requireAuth) {
    console.error(
      "[sportsdesk-mcp] WARNING: running with --no-auth on loopback; bearer authentication is disabled.",
    );
  }

  const handle = startStandaloneMcpServer({
    port: config.port,
    hostname: config.hostname,
    stateless: config.stateless,
    enableJsonResponse: config.enableJsonResponse,
    requireAuth: config.requireAuth,
    maxSessions: config.maxSessions,
  });

  const mcpEndpoint = new URL("/mcp", handle.url).toString();
  if (config.jsonOutput) {
    console.log(
      JSON.stringify({
        status: "listening",
        url: handle.url.toString(),
        mcpEndpoint,
        port: handle.port,
        hostname: config.hostname,
        mode: config.stateless ? "stateless" : "stateful",
        authRequired: config.requireAuth,
      }),
    );
  } else {
    console.log(
      `[SportsDesk MCP Server] Listening on ${mcpEndpoint} (${config.stateless ? "stateless" : "stateful"}, auth=${config.requireAuth ? "bearer" : "none"})`,
    );
  }

  const shutdown = (): void => {
    handle
      .stop(true)
      .catch((err: unknown) => {
        console.error("[sportsdesk-mcp] shutdown error:", err);
      })
      .finally(() => {
        process.exit(EXIT_OK);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
