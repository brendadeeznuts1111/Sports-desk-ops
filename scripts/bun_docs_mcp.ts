/**
 * Bun docs MCP client (bun.sh/docs/mcp). The endpoint is a stateless JSON-RPC server: POST
 * initialize/tools/call; no session, no auth, read-only. This is the repo-native way to query the
 * published Bun docs with citations when the Harness profile has no MCP plugin mounted.
 *
 *   bun run bun:docs-mcp probe
 *   bun run bun:docs-mcp search "Bun.WebView attach existing Chrome"
 *   bun run bun:docs-mcp read /docs/runtime/webview
 *   bun run bun:docs-mcp grep -- "--inspect-wait"
 *   bun run bun:docs-mcp list /docs/runtime
 *   bun run bun:docs-mcp skill
 *
 * Override the endpoint with BUN_DOCS_MCP_URL (declared in types/env.d.ts).
 */

import { env } from "bun";
import { z } from "zod";
import { BUN_SHAPES, type BunShape } from "../lib/bun_shapes.ts";

/** Keep in sync with ~/dotfiles/lib/cli/bun-docs-mcp-url.ts */
export const DEFAULT_BUN_DOCS_MCP_URL = "https://bun.sh/docs/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export const MCP_TOOL_NAMES = [
  "search_bun",
  "read_bun_page",
  "list_bun_pages",
  "grep_bun",
] as const;

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const toolsListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
});

const resourcesListSchema = z.object({
  resources: z.array(
    z.object({
      uri: z.string(),
      name: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
});

type McpTool = z.infer<typeof toolsListSchema>["tools"][number];
type McpResource = z.infer<typeof resourcesListSchema>["resources"][number];

const toolCallSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  /** Tool failures are HTTP 200 + isError, not JSON-RPC errors. */
  isError: z.boolean().optional(),
});

const resourceReadSchema = z.object({
  contents: z.array(
    z.object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string(),
    }),
  ),
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class BunDocsMcp {
  private nextId = 1;

  constructor(
    private readonly url = env.BUN_DOCS_MCP_URL ?? DEFAULT_BUN_DOCS_MCP_URL,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const payload = contentType.includes("text/event-stream")
      ? (text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as unknown)
          .at(-1) ?? {})
      : (JSON.parse(text) as unknown);
    const envelope = envelopeSchema.parse(payload);
    if (envelope.error !== undefined) {
      throw new Error(
        `MCP ${method} error ${envelope.error.code}: ${envelope.error.message}`,
      );
    }
    return envelope.result;
  }

  async initialize(): Promise<{
    serverInfo: { name: string; version: string };
    tools: { listChanged?: boolean | undefined };
    resources: { listChanged?: boolean | undefined };
  }> {
    const result = z
      .object({
        protocolVersion: z.string(),
        serverInfo: z.object({ name: z.string(), version: z.string() }),
        tools: z.object({ listChanged: z.boolean().optional() }).optional(),
        resources: z.object({ listChanged: z.boolean().optional() }).optional(),
      })
      .parse(
        await this.rpc("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "sportsdesk-ops", version: "0.1" },
        }),
      );
    return {
      serverInfo: result.serverInfo,
      tools: result.tools ?? {},
      resources: result.resources ?? {},
    };
  }

  async listTools(): Promise<readonly McpTool[]> {
    return toolsListSchema.parse(await this.rpc("tools/list", {})).tools;
  }

  async listResources(): Promise<readonly McpResource[]> {
    return resourcesListSchema.parse(await this.rpc("resources/list", {}))
      .resources;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = toolCallSchema.parse(
      await this.rpc("tools/call", { name, arguments: args }),
    );
    const text = result.content
      .map((part) => part.text ?? `[${part.type}]`)
      .join("\n");
    if (result.isError === true) {
      throw new Error(`MCP tool ${name} failed: ${text}`);
    }
    return text;
  }

  async readResource(uri: string): Promise<string> {
    const result = resourceReadSchema.parse(
      await this.rpc("resources/read", { uri }),
    );
    return result.contents.map((entry) => entry.text).join("\n");
  }
}

/** Contract check: the four documented tools and the `bun://skill` resource must exist. */
export async function probeBunDocsMcp(
  client: BunDocsMcp = new BunDocsMcp(),
): Promise<{
  server: string;
  version: string;
  tools: readonly string[];
  resources: readonly string[];
  requiredToolsPresent: boolean;
  skillPresent: boolean;
}> {
  const info = await client.initialize();
  const tools = await client.listTools();
  const resources = await client.listResources();
  const names = tools.map((tool) => tool.name);
  return {
    server: info.serverInfo.name,
    version: info.serverInfo.version,
    tools: names,
    resources: resources.map((entry) => entry.uri),
    requiredToolsPresent: MCP_TOOL_NAMES.every((name) => names.includes(name)),
    skillPresent: resources.some((entry) => entry.uri === "bun://skill"),
  };
}

export interface DocsAuditCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DocsAudit {
  readonly checks: readonly DocsAuditCheck[];
  readonly drift: readonly string[];
}

/**
 * Repo-pinned Bun facts vs the live docs: catches "the docs moved" and the known stale-skill line
 * ("Don't use Bun for type-checking") that contradicts `bun check`.
 */
export async function auditPinnedBunFacts(
  client: BunDocsMcp = new BunDocsMcp(),
): Promise<DocsAudit> {
  const checks: DocsAuditCheck[] = [];
  const search = async (query: string): Promise<string> =>
    client.callTool("search_bun", { query, limit: 5 });

  const checkPage = await search("bun check type checking");
  checks.push({
    id: "bun-check-documented",
    ok: checkPage.includes("bun check"),
    detail: checkPage.includes("bun check")
      ? "search finds the type-checking page"
      : "no bun check result",
  });

  const inspector = await search("--inspect-wait inspector");
  checks.push({
    id: "inspect-wait-documented",
    ok: inspector.includes("--inspect-wait"),
    detail: inspector.includes("--inspect-wait")
      ? "debugger docs mention --inspect-wait"
      : "no --inspect-wait mention",
  });

  const webview = await client.callTool("read_bun_page", {
    path: "/docs/runtime/webview",
  });
  checks.push({
    id: "webview-headless-true-only",
    ok: webview.includes("Only `true` is implemented"),
    detail: webview.includes("Only `true` is implemented")
      ? "headless:false still throws per docs"
      : "headless contract changed — re-read /docs/runtime/webview",
  });

  const flagsOrder = await search('bun flags "immediately after bun" run');
  checks.push({
    id: "flags-before-run-documented",
    ok: flagsOrder.includes("immediately after"),
    detail: flagsOrder.includes("immediately after")
      ? "flags-before-run ordering documented"
      : "ordering guidance not found — re-check /docs/runtime",
  });

  const skill = await client.readResource("bun://skill");
  const skillSaysNoTypecheck =
    skill.includes("Don't use Bun for") && skill.includes("Bun strips types");
  checks.push({
    id: "skill-typechecking-line",
    ok: !skillSaysNoTypecheck,
    detail: skillSaysNoTypecheck
      ? "skill still says Bun strips types / use tsc, despite bun check"
      : "skill no longer claims that",
  });

  return {
    checks,
    drift: checks.filter((check) => !check.ok).map((check) => check.id),
  };
}

/**
 * One entry per `Bun.*` surface in lib/bun_shapes.ts: whether the published docs mention it, and the
 * first link if they do. "Documented" here means the MCP corpus has a page for the exact API name —
 * it is a coverage signal, not a contract check.
 */
export interface BunShapeDocsEntry {
  readonly name: string;
  readonly documented: boolean;
  readonly link: string | null;
}

export interface BunShapeDocsAudit {
  readonly total: number;
  readonly documented: number;
  readonly undocumented: readonly string[];
  readonly entries: readonly BunShapeDocsEntry[];
}

/** Committed baseline: which surfaces the docs covered on the day it was taken. */
export interface BunShapeDocsBaseline {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly runtime: string;
  readonly shapes: Record<
    string,
    { readonly documented: boolean; readonly link: string | null }
  >;
}

export interface BunShapeDocsDrift {
  readonly missingFromBaseline: readonly string[];
  readonly newlyUndocumented: readonly string[];
  readonly newlyDocumented: readonly string[];
}

function firstDocLink(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^Link: (https:\/\/\S+)$/.exec(line.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Ask the docs MCP about every catalog surface, one search per shape. */
export async function auditBunSurfaceDocs(
  client: BunDocsMcp = new BunDocsMcp(),
  options: {
    readonly shapes?: readonly Pick<BunShape, "name">[];
    readonly limit?: number;
  } = {},
): Promise<BunShapeDocsAudit> {
  const shapes = options.shapes ?? BUN_SHAPES;
  const entries: BunShapeDocsEntry[] = [];
  for (const shape of shapes) {
    let text = "";
    try {
      text = await client.callTool("search_bun", {
        query: `Bun.${shape.name}`,
        limit: options.limit ?? 5,
      });
    } catch {
      text = "";
    }
    const link = firstDocLink(text);
    entries.push({ name: shape.name, documented: link !== null, link });
  }
  return {
    total: entries.length,
    documented: entries.filter((entry) => entry.documented).length,
    undocumented: entries
      .filter((entry) => !entry.documented)
      .map((entry) => entry.name),
    entries,
  };
}

/** Compare a fresh audit with the committed baseline. */
export function diffBunShapeDocs(
  baseline: BunShapeDocsBaseline,
  audit: BunShapeDocsAudit,
): BunShapeDocsDrift {
  const current = new Map(audit.entries.map((entry) => [entry.name, entry]));
  const missingFromBaseline = audit.entries
    .filter((entry) => baseline.shapes[entry.name] === undefined)
    .map((entry) => entry.name);
  const newlyUndocumented: string[] = [];
  const newlyDocumented: string[] = [];
  for (const [name, before] of Object.entries(baseline.shapes)) {
    const now = current.get(name);
    if (now === undefined) continue;
    if (before.documented && !now.documented) newlyUndocumented.push(name);
    if (!before.documented && now.documented) newlyDocumented.push(name);
  }
  return { missingFromBaseline, newlyUndocumented, newlyDocumented };
}

/**
 * Offline gate: the baseline must cover exactly the catalog. A new `Bun.*` surface fails CI until
 * someone runs the online audit (`surfaces --update`) and reviews the result.
 */
export function checkBunShapeDocsBaseline(
  baseline: BunShapeDocsBaseline,
  shapes: readonly Pick<BunShape, "name">[] = BUN_SHAPES,
): readonly string[] {
  const catalog = new Set(shapes.map((shape) => shape.name));
  const problems: string[] = [];
  for (const name of catalog) {
    if (baseline.shapes[name] === undefined) {
      problems.push(`missing-from-baseline: ${name}`);
    }
  }
  for (const name of Object.keys(baseline.shapes)) {
    if (!catalog.has(name)) problems.push(`stale-baseline-entry: ${name}`);
  }
  return problems;
}

/** Stable JSON for the committed baseline (entries sorted by name). */
export function serializeBunShapeDocsBaseline(
  audit: BunShapeDocsAudit,
  options: { readonly generatedAt: string; readonly runtime: string },
): string {
  const shapes: Record<string, { documented: boolean; link: string | null }> =
    {};
  for (const entry of [...audit.entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    shapes[entry.name] = { documented: entry.documented, link: entry.link };
  }
  const baseline: BunShapeDocsBaseline = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    runtime: options.runtime,
    shapes,
  };
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function print(text: string): void {
  console.log(text);
}

async function main(args: readonly string[]): Promise<void> {
  const [command = "probe", ...rest] = args;
  const client = new BunDocsMcp();
  switch (command) {
    case "probe": {
      const probe = await probeBunDocsMcp(client);
      print(JSON.stringify(probe, null, 2));
      if (!probe.requiredToolsPresent || !probe.skillPresent) {
        throw new Error(
          "Bun docs MCP contract drift: required tools/resource missing",
        );
      }
      return;
    }
    case "search": {
      const [query, ...flags] = rest;
      if (query === undefined) throw new Error("search needs a query");
      const limit = flagValue(flags, "--limit");
      const section = flagValue(flags, "--section");
      print(
        await client.callTool("search_bun", {
          query,
          ...(limit === undefined ? {} : { limit: Number(limit) }),
          ...(section === undefined ? {} : { section }),
        }),
      );
      return;
    }
    case "read": {
      const [path] = rest;
      if (path === undefined) throw new Error("read needs a page path");
      print(await client.callTool("read_bun_page", { path }));
      return;
    }
    case "list": {
      const [path = "/"] = rest;
      print(await client.callTool("list_bun_pages", { path }));
      return;
    }
    case "grep": {
      const [pattern, ...flags] = rest;
      if (pattern === undefined) throw new Error("grep needs a pattern");
      const ignoreCase = flagValue(flags, "--ignore-case") !== undefined;
      print(
        await client.callTool("grep_bun", {
          pattern,
          ...(ignoreCase ? { ignoreCase } : {}),
        }),
      );
      return;
    }
    case "skill":
      print(await client.readResource("bun://skill"));
      return;
    case "surfaces": {
      const baselinePath = flagValue(rest, "--check");
      if (baselinePath !== undefined) {
        // Offline: no network, only catalog coverage of the committed baseline.
        const baseline = JSON.parse(
          await Bun.file(baselinePath).text(),
        ) as BunShapeDocsBaseline;
        const problems = checkBunShapeDocsBaseline(baseline);
        print(JSON.stringify({ baselinePath, problems }, null, 2));
        if (problems.length > 0) {
          throw new Error(
            `Bun surface docs baseline is stale: ${problems.join(", ")}`,
          );
        }
        return;
      }
      const audit = await auditBunSurfaceDocs(client);
      const updatePath = flagValue(rest, "--update");
      const baselineFile =
        flagValue(rest, "--baseline") ?? "tests/bun_docs_surface_baseline.json";
      if (updatePath !== undefined) {
        const serialized = serializeBunShapeDocsBaseline(audit, {
          generatedAt: new Date().toISOString(),
          runtime: `Bun ${Bun.version}`,
        });
        await Bun.write(updatePath, serialized);
        print(
          JSON.stringify(
            {
              updated: updatePath,
              documented: audit.documented,
              total: audit.total,
              undocumented: audit.undocumented,
            },
            null,
            2,
          ),
        );
        return;
      }
      const baseline = (await Bun.file(baselineFile).exists())
        ? ((await Bun.file(baselineFile).json()) as BunShapeDocsBaseline)
        : null;
      const drift =
        baseline === null ? null : diffBunShapeDocs(baseline, audit);
      print(JSON.stringify({ audit, drift }, null, 2));
      if (
        rest.includes("--fail-on-drift") &&
        drift !== null &&
        (drift.newlyUndocumented.length > 0 ||
          drift.missingFromBaseline.length > 0)
      ) {
        throw new Error(
          `Bun surface docs drift: ${[...drift.missingFromBaseline, ...drift.newlyUndocumented].join(", ")}`,
        );
      }
      return;
    }
    case "audit": {
      const audit = await auditPinnedBunFacts(client);
      print(JSON.stringify(audit, null, 2));
      if (audit.drift.length > 0 && rest.includes("--fail-on-drift")) {
        throw new Error(`docs drift: ${audit.drift.join(", ")}`);
      }
      return;
    }
    default:
      throw new Error(
        `unknown command ${command}; expected probe|search|read|list|grep|skill|audit|surfaces`,
      );
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  await main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `bun:docs-mcp: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
