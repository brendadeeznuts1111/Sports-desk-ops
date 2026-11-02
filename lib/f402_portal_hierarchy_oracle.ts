/**
 * Runnable sandbox for portal `baseHeriarchy` / `setCompleteHeriarchy`
 * (extracted from pinned manager.js — see verification/manager-boot-oracle/).
 */

import { join } from "node:path";

import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";

export interface PortalGeneralRow {
  AgentID: string;
  Login: string;
  Level: number;
  AgentType: string;
  SeqNumber?: number;
  Master?: string;
  [key: string]: unknown;
}

/** Wire GENERAL rows → rows `baseHeriarchy` can walk (it calls `.toString()` on AgentID/Login). */
export function parsePortalGeneralRows(
  rows: readonly ListAgentsByAgentGeneralWireRow[],
): PortalGeneralRow[] {
  return rows.map((row, index) => {
    const { AgentID, Login, Level, AgentType } = row;
    if (
      typeof AgentID !== "string" ||
      typeof Login !== "string" ||
      typeof Level !== "number" ||
      typeof AgentType !== "string"
    ) {
      throw new Error(
        `GENERAL[${index}] needs string AgentID, Login, AgentType and numeric Level`,
      );
    }
    return { ...row, AgentID, Login, Level, AgentType };
  });
}

export interface PortalUtilStub {
  readonly isGotamSkin: () => boolean;
  readonly isOnlyMobile: () => boolean;
  readonly typeAgent: { readonly MASTER: string };
}

export interface PortalOracleContext {
  readonly MASTER_ID: string | number;
  readonly accountInfo: { readonly Login: string };
  readonly type: string;
  readonly isClassicSkin: () => boolean;
}

export interface BaseHeriarchyResult {
  readonly nested: unknown;
  readonly completeHeriarchy: unknown;
  readonly completeHeriarchyLength: number;
}

const EXTRACTED_DIR = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/extracted",
);

let bodiesCache: {
  baseHeriarchy: string;
  buildTree: string;
  findInTree: string;
  setCompleteHeriarchy: string;
} | null = null;

async function loadBodies(): Promise<NonNullable<typeof bodiesCache>> {
  if (bodiesCache !== null) return bodiesCache;
  const [baseHeriarchy, buildTree, findInTree, setCompleteHeriarchy] =
    await Promise.all([
      Bun.file(join(EXTRACTED_DIR, "baseHeriarchy.body.min.js")).text(),
      Bun.file(join(EXTRACTED_DIR, "buildTree.body.min.js")).text(),
      Bun.file(join(EXTRACTED_DIR, "findInTree.body.min.js")).text(),
      Bun.file(join(EXTRACTED_DIR, "setCompleteHeriarchy.body.min.js")).text(),
    ]);
  bodiesCache = { baseHeriarchy, buildTree, findInTree, setCompleteHeriarchy };
  return bodiesCache;
}

function compileFromSlice(
  sliced: string,
  extraParams: string[] = [],
): (...args: unknown[]) => unknown {
  let rest = sliced.trim();
  let paramList = "e";
  const amd = rest.match(/^[\w$]+:function\(([^)]*)\)/);
  if (amd !== null) {
    paramList = amd[1] ?? "e";
    const closeParen = rest.indexOf(")", amd.index ?? 0);
    rest = rest.slice(closeParen + 1);
  } else {
    const legacy = rest.match(/^([^({]+)\{/);
    if (legacy !== null) {
      paramList = legacy[1]?.replace(/\)+$/, "").trim() ?? "e";
    }
  }
  const open = rest.indexOf("{");
  if (open < 0) throw new Error("invalid sliced method");
  const params =
    paramList === "" || paramList === "e"
      ? ["e", ...extraParams]
      : [...paramList.split(",").map((p) => p.trim()), ...extraParams];
  const inner = rest.endsWith("}")
    ? rest.slice(open + 1, -1)
    : rest.slice(open + 1);
  return new Function(...params, inner) as (...args: unknown[]) => unknown;
}

export function defaultPortalUtilStub(): PortalUtilStub {
  return {
    isGotamSkin: () => false,
    isOnlyMobile: () => false,
    typeAgent: { MASTER: "M" },
  };
}

export async function runPortalHierarchyOracle(
  general: readonly PortalGeneralRow[],
  options?: {
    readonly util?: PortalUtilStub;
    readonly context?: Partial<PortalOracleContext>;
    readonly runSetComplete?: boolean;
  },
): Promise<BaseHeriarchyResult> {
  const bodies = await loadBodies();
  const util = options?.util ?? defaultPortalUtilStub();
  const proto: Record<string, unknown> = {};
  const host = Object.assign(Object.create(proto), {
    MASTER_ID: options?.context?.MASTER_ID ?? "MASTER1",
    accountInfo: { Login: options?.context?.accountInfo?.Login ?? "MASTER1" },
    type: options?.context?.type ?? "M",
    isClassicSkin: options?.context?.isClassicSkin ?? (() => true),
    completeHeriarchyLength: 0,
    completeHeriarchyTree: null,
    callSearchComponentByAttr: () => undefined,
    setDisplayingAgents: () => undefined,
    searchComponent: () => undefined,
  }) as Record<string, unknown>;

  host.buildTree = compileFromSlice(bodies.buildTree).bind(host);
  host.findInTree = compileFromSlice(bodies.findInTree).bind(host);

  const baseHeriarchy = compileFromSlice(bodies.baseHeriarchy, ["n"]).bind(
    host,
  );
  host.baseHeriarchy = (payload: { data: PortalGeneralRow[] }) =>
    baseHeriarchy(payload, util);
  const nested = normalizeNested(baseHeriarchy({ data: [...general] }, util));
  let completeHeriarchy: unknown = nested;

  if (options?.runSetComplete === true) {
    const setComplete = compileFromSlice(bodies.setCompleteHeriarchy, [
      "n",
      "$",
      "require",
      "r",
    ]).bind(host);
    const $stub = (): unknown => {
      const chain = (): unknown => chain;
      return chain;
    };
    const require = (): void => undefined;
    const r = { write: (): void => undefined };
    setComplete({ data: [...general] }, util, $stub, require, r);
    completeHeriarchy = normalizeNested(proto.completeHeriarchy ?? nested);
  }

  return {
    nested,
    completeHeriarchy,
    completeHeriarchyLength: general.length,
  };
}

export async function expectOracleThrows(
  general: readonly PortalGeneralRow[],
): Promise<void> {
  let threw = false;
  try {
    await runPortalHierarchyOracle(general);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected portal baseHeriarchy to throw");
}

/** Portal returns sparse arrays; copy own keys for stable JSON. */
export function normalizeNested(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = normalizeNested(value);
  }
  return out;
}

export function oracleSnapshot(value: unknown): string {
  return `${JSON.stringify(normalizeNested(value), oracleReplacer)}\n`;
}

function oracleReplacer(_key: string, val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map((item) => item);
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
