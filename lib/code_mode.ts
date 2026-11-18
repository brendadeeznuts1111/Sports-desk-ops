import { z } from "zod";

/**
 * @file lib/code_mode.ts
 * @description Native Bun Code Mode engine for programmatic tool orchestration.
 *
 * Implements Claude Code's Code Mode paradigm (https://code.claude.com/docs/en/code-mode):
 * Instead of iterative single-tool calling across conversational turns, the agent writes
 * TypeScript/JavaScript that orchestrates multiple tools, filters large data payloads in-memory,
 * and returns concise structured projections, saving up to 90%+ context window tokens.
 */

/**
 * Host factories: `lib/code_mode_host.ts`. Profile cells: `lib/code_mode_profile.ts` + `quickjs_code_mode.ts`.
 */
export {
  createSportsdeskCodeModeHostRunner,
  createSportsdeskCodeModeRunner,
} from "./code_mode_host.ts";

export interface CodeModeTool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters?: z.ZodType<TArgs> | Record<string, unknown>;
  readonly handler: (args: TArgs) => Promise<TResult> | TResult;
}

export interface ToolCallTelemetry {
  readonly tool: string;
  readonly args: unknown;
  readonly durationMs: number;
  readonly success: boolean;
  readonly rawBytes: number;
}

export interface CodeModeTelemetry {
  readonly durationMs: number;
  readonly toolCalls: readonly ToolCallTelemetry[];
  readonly totalToolCalls: number;
  readonly rawToolBytes: number;
  readonly outputBytes: number;
  readonly tokenSavingsRatio: number;
}

export interface CodeModeExecutionResult<T = unknown> {
  readonly success: boolean;
  readonly result?: T;
  readonly error?: {
    readonly message: string;
    readonly stack?: string | undefined;
    readonly code?: string | undefined;
  };
  readonly logs: readonly string[];
  readonly telemetry: CodeModeTelemetry;
}

export interface CodeModeOptions {
  /** Maximum execution duration before timing out (default 30,000ms). */
  readonly timeoutMs?: number;
  /** Maximum tool invocations allowed within one script (default 100). */
  readonly maxToolCalls?: number;
  /** Cancellation signal. */
  readonly signal?: AbortSignal;
}

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export class CodeModeRunner {
  private readonly tools = new Map<string, CodeModeTool>();
  private readonly mcpServers = new Map<string, Map<string, CodeModeTool>>();
  private readonly transpiler = new Bun.Transpiler({ loader: "ts" });

  /** Registers a tool under the global `tools.<name>` namespace. */
  public registerTool<TArgs = Record<string, unknown>, TResult = unknown>(
    tool: CodeModeTool<TArgs, TResult>,
  ): this {
    this.tools.set(tool.name, tool as CodeModeTool);
    return this;
  }

  /** Registers a namespaced set of tools under `mcp.<serverName>.<toolName>`. */
  public registerMcpServer(
    serverName: string,
    tools: readonly CodeModeTool[],
  ): this {
    const serverMap = new Map<string, CodeModeTool>();
    for (const tool of tools) {
      serverMap.set(tool.name, tool);
    }
    this.mcpServers.set(serverName, serverMap);
    return this;
  }

  public getTool(name: string): CodeModeTool | undefined {
    return this.tools.get(name);
  }

  public listTools(): readonly CodeModeTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Generates TypeScript ambient declarations (.d.ts) describing all registered tools.
   * Can be injected directly into LLM system prompts so the model writes valid typed code.
   */
  public generateTypeDeclarations(): string {
    const lines: string[] = [
      "// TypeScript Definitions for Code Mode Ingestion & Tool Orchestration",
      "// SPDX-License-Identifier: MIT",
      "",
      "declare namespace tools {",
    ];

    for (const tool of this.tools.values()) {
      lines.push(`  /** ${tool.description.replace(/\n/g, " ")} */`);
      lines.push(
        `  function ${tool.name}(args?: Record<string, unknown>): Promise<any>;`,
      );
      lines.push("");
    }
    lines.push("}");
    lines.push("");

    if (this.mcpServers.size > 0) {
      lines.push("declare namespace mcp {");
      for (const [serverName, serverTools] of this.mcpServers.entries()) {
        lines.push(`  namespace ${serverName} {`);
        for (const tool of serverTools.values()) {
          lines.push(`    /** ${tool.description.replace(/\n/g, " ")} */`);
          lines.push(
            `    function ${tool.name}(args?: Record<string, unknown>): Promise<any>;`,
          );
        }
        lines.push("  }");
      }
      lines.push("}");
    }

    return lines.join("\n");
  }

  /**
   * Executes a TypeScript/JavaScript script with injected `tools` and `mcp` proxies.
   */
  public async execute<T = unknown>(
    code: string,
    options: CodeModeOptions = {},
  ): Promise<CodeModeExecutionResult<T>> {
    const startTime = performance.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxToolCalls = options.maxToolCalls ?? 100;
    const logs: string[] = [];
    const toolCalls: ToolCallTelemetry[] = [];

    let totalRawToolBytes = 0;
    let callCount = 0;

    // Build tools proxy
    const toolsProxy = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (typeof prop !== "string") return undefined;
          const tool = this.tools.get(prop);
          if (!tool) {
            return () => {
              throw new Error(
                `ERR_CODE_MODE_TOOL_NOT_FOUND: Tool 'tools.${prop}' is not registered.`,
              );
            };
          }

          return async (args: Record<string, unknown> = {}) => {
            if (options.signal?.aborted) {
              throw (
                options.signal.reason ??
                new Error("ERR_CODE_MODE_ABORTED: Script execution aborted.")
              );
            }
            if (++callCount > maxToolCalls) {
              throw new Error(
                `ERR_CODE_MODE_MAX_CALLS_EXCEEDED: Script exceeded maximum permitted tool calls (${maxToolCalls}).`,
              );
            }

            const toolStart = performance.now();
            let success = false;
            let rawBytes = 0;
            try {
              if (tool.parameters instanceof z.ZodType) {
                tool.parameters.parse(args);
              }
              const output = await tool.handler(args);
              success = true;
              try {
                rawBytes = JSON.stringify(output)?.length ?? 0;
              } catch {
                rawBytes = 0;
              }
              totalRawToolBytes += rawBytes;
              return output;
            } finally {
              const toolDuration = performance.now() - toolStart;
              toolCalls.push({
                tool: `tools.${tool.name}`,
                args,
                durationMs: toolDuration,
                success,
                rawBytes,
              });
            }
          };
        },
      },
    );

    // Build mcp proxy
    const mcpProxy = new Proxy(
      {},
      {
        get: (_target, serverName: string | symbol) => {
          if (typeof serverName !== "string") return undefined;
          const server = this.mcpServers.get(serverName);
          if (!server) {
            return undefined;
          }

          return new Proxy(
            {},
            {
              get: (_subTarget, toolName: string | symbol) => {
                if (typeof toolName !== "string") return undefined;
                const tool = server.get(toolName);
                if (!tool) {
                  return () => {
                    throw new Error(
                      `ERR_CODE_MODE_TOOL_NOT_FOUND: Tool 'mcp.${serverName}.${toolName}' is not registered.`,
                    );
                  };
                }

                return async (args: Record<string, unknown> = {}) => {
                  if (options.signal?.aborted) {
                    throw (
                      options.signal.reason ??
                      new Error(
                        "ERR_CODE_MODE_ABORTED: Script execution aborted.",
                      )
                    );
                  }
                  if (++callCount > maxToolCalls) {
                    throw new Error(
                      `ERR_CODE_MODE_MAX_CALLS_EXCEEDED: Script exceeded maximum permitted tool calls (${maxToolCalls}).`,
                    );
                  }

                  const toolStart = performance.now();
                  let success = false;
                  let rawBytes = 0;
                  try {
                    const output = await tool.handler(args);
                    success = true;
                    try {
                      rawBytes = JSON.stringify(output)?.length ?? 0;
                    } catch {
                      rawBytes = 0;
                    }
                    totalRawToolBytes += rawBytes;
                    return output;
                  } finally {
                    const toolDuration = performance.now() - toolStart;
                    toolCalls.push({
                      tool: `mcp.${serverName}.${tool.name}`,
                      args,
                      durationMs: toolDuration,
                      success,
                      rawBytes,
                    });
                  }
                };
              },
            },
          );
        },
      },
    );

    // Console logger capture
    const consoleCapture = {
      log: (...args: unknown[]) =>
        logs.push(
          args
            .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
            .join(" "),
        ),
      warn: (...args: unknown[]) =>
        logs.push(`[WARN] ${args.map((a) => String(a)).join(" ")}`),
      error: (...args: unknown[]) =>
        logs.push(`[ERROR] ${args.map((a) => String(a)).join(" ")}`),
      info: (...args: unknown[]) =>
        logs.push(args.map((a) => String(a)).join(" ")),
    };

    let transformedBody: string;
    try {
      const wrapped = `export const __code_mode_entry = async (tools, mcp, console) => {\n${code}\n};`;
      const transformedModule = this.transpiler.transformSync(wrapped);
      const start = transformedModule.indexOf("{");
      const end = transformedModule.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw new Error(
          "Cannot extract function body from transformed module.",
        );
      }
      transformedBody = transformedModule.slice(start + 1, end);
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return {
        success: false,
        error: {
          message: `ERR_CODE_MODE_TRANSPILE: ${err instanceof Error ? err.message : String(err)}`,
          stack: err instanceof Error ? err.stack : undefined,
        },
        logs,
        telemetry: {
          durationMs,
          toolCalls,
          totalToolCalls: 0,
          rawToolBytes: 0,
          outputBytes: 0,
          tokenSavingsRatio: 1,
        },
      };
    }

    // Execute with timeout and cancellation
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(
          new Error(
            `ERR_CODE_MODE_TIMEOUT: Execution exceeded timeout limit of ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
    });

    const executionPromise = (async () => {
      const runnerFn = new AsyncFunction(
        "tools",
        "mcp",
        "console",
        transformedBody,
      );
      return (await runnerFn(toolsProxy, mcpProxy, consoleCapture)) as T;
    })();

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      const durationMs = performance.now() - startTime;

      let outputBytes = 0;
      try {
        outputBytes = JSON.stringify(result)?.length ?? 0;
      } catch {
        outputBytes = 0;
      }

      const tokenSavingsRatio =
        totalRawToolBytes > 0 && outputBytes > 0
          ? Number((totalRawToolBytes / outputBytes).toFixed(2))
          : 1;

      return {
        success: true,
        result,
        logs,
        telemetry: {
          durationMs,
          toolCalls,
          totalToolCalls: toolCalls.length,
          rawToolBytes: totalRawToolBytes,
          outputBytes,
          tokenSavingsRatio,
        },
      };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return {
        success: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        logs,
        telemetry: {
          durationMs,
          toolCalls,
          totalToolCalls: toolCalls.length,
          rawToolBytes: totalRawToolBytes,
          outputBytes: 0,
          tokenSavingsRatio: 1,
        },
      };
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }
  }
}
