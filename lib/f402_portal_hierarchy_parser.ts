/**
 * TypeScript port of pinned `baseHeriarchy` (manager.js) — diff target for portal oracle.
 */

import {
  normalizeNested,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";

export interface PortalHierarchyParserContext {
  readonly masterId: string;
  readonly masterLogin: string;
}

export interface PortalHierarchyAgentMapEntry {
  readonly AgentID: string;
  readonly AgentType: string;
  readonly Login: string;
  readonly Master: string;
}

export interface PortalHierarchyParserResult {
  readonly nested: unknown;
  readonly agentMap: Readonly<Record<string, PortalHierarchyAgentMapEntry>>;
}

type SparseNode = Record<string, unknown>;

/** Mirrors extracted `baseHeriarchy:function(e){…}` (levels 1–12, trim + uppercase keys). */
export function runBaseHeriarchyParser(
  general: readonly PortalGeneralRow[],
  ctx: PortalHierarchyParserContext,
): unknown {
  return runBaseHeriarchyParserWithAgentMap(general, ctx).nested;
}

export function runBaseHeriarchyParserWithAgentMap(
  general: readonly PortalGeneralRow[],
  ctx: PortalHierarchyParserContext,
): PortalHierarchyParserResult {
  let t = "";
  let a = "";
  let o = "";
  let i = "";
  let s = "";
  let r = "";
  let c = "";
  let l = "";
  let d = "";
  let g = "";
  let u = "";
  const p: SparseNode = {};
  const agentMap: SparseNode = {};
  const m = general.map((row) => ({ ...row }));

  for (let y = 0; y < m.length; y += 1) {
    const v = m[y];
    if (v === undefined) continue;
    v.Login = v.Login.toString().trim().toUpperCase();
    const A = v.AgentID.toString().trim().toUpperCase();
    const level = v.Level;

    if (level === 1) {
      if (p[A] === undefined) p[A] = [];
      p[A] = v;
      t = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: ctx.masterId,
        masterLogin: ctx.masterLogin,
      });
    } else if (level === 2) {
      if (p[t] === undefined) p[t] = [];
      slot(p, t)[A] = v;
      a = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: t,
      });
    } else if (level === 3) {
      if (slot(p, t)[a] === undefined) slot(p, t)[a] = [];
      slot(slot(p, t), a)[A] = v;
      o = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: a,
      });
    } else if (level === 4) {
      if (slot(slot(p, t), a)[o] === undefined) slot(slot(p, t), a)[o] = [];
      slot(slot(slot(p, t), a), o)[A] = v;
      i = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: o,
      });
    } else if (level === 5) {
      if (slot(slot(slot(p, t), a), o)[i] === undefined) {
        slot(slot(slot(p, t), a), o)[i] = [];
      }
      slot(slot(slot(slot(p, t), a), o), i)[A] = v;
      s = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: i,
      });
    } else if (level === 6) {
      if (slot(slot(slot(slot(p, t), a), o), i)[s] === undefined) {
        slot(slot(slot(slot(p, t), a), o), i)[s] = [];
      }
      slot(slot(slot(slot(slot(p, t), a), o), i), s)[A] = v;
      r = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: i,
      });
    } else if (level === 7) {
      if (slot(slot(slot(slot(slot(p, t), a), o), i), s)[r] === undefined) {
        slot(slot(slot(slot(slot(p, t), a), o), i), s)[r] = [];
      }
      slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r)[A] = v;
      c = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: r,
      });
    } else if (level === 8) {
      if (
        slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r)[c] === undefined
      ) {
        slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r)[c] = [];
      }
      slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c)[A] = v;
      l = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: c,
      });
    } else if (level === 9) {
      if (
        slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c)[l] ===
        undefined
      ) {
        slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c)[l] =
          [];
      }
      slot(slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c), l)[
        A
      ] = v;
      d = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: l,
      });
    } else if (level === 10) {
      if (
        slot(
          slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
          l,
        )[d] === undefined
      ) {
        slot(
          slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
          l,
        )[d] = [];
      }
      slot(
        slot(
          slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
          l,
        ),
        d,
      )[A] = v;
      g = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: d,
      });
    } else if (level === 11) {
      if (
        slot(
          slot(
            slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
            l,
          ),
          d,
        )[g] === undefined
      ) {
        slot(
          slot(
            slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
            l,
          ),
          d,
        )[g] = [];
      }
      slot(
        slot(
          slot(
            slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
            l,
          ),
          d,
        ),
        g,
      )[A] = v;
      u = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: g,
      });
    } else if (level === 12) {
      if (
        slot(
          slot(
            slot(
              slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
              l,
            ),
            d,
          ),
          g,
        )[u] === undefined
      ) {
        slot(
          slot(
            slot(
              slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
              l,
            ),
            d,
          ),
          g,
        )[u] = [];
      }
      slot(
        slot(
          slot(
            slot(
              slot(slot(slot(slot(slot(slot(slot(p, t), a), o), i), s), r), c),
              l,
            ),
            d,
          ),
          g,
        ),
        u,
      )[A] = v;
      const masterL11 = u;
      u = A;
      fSet(agentMap, A, {
        AgentID: A,
        AgentType: v.AgentType,
        Login: v.Login,
        Master: masterL11,
      });
    }
  }

  const mapOut: Record<string, PortalHierarchyAgentMapEntry> = {};
  for (const [key, value] of Object.entries(agentMap)) {
    const row = value as PortalHierarchyAgentMapEntry;
    mapOut[key] = {
      AgentID: row.AgentID,
      AgentType: row.AgentType,
      Login: row.Login,
      Master: row.Master,
    };
  }
  return { nested: p, agentMap: mapOut };
}

function fSet(map: SparseNode, key: string, value: unknown): void {
  map[key] = value;
}

function slot(parent: SparseNode, key: string): SparseNode {
  const cur = parent[key];
  if (typeof cur === "object" && cur !== null) return cur as SparseNode;
  const created = emptySparseArray();
  parent[key] = created;
  return created;
}

/** Portal nests rows under string-keyed arrays (`p[t] = []`), not plain objects. */
function emptySparseArray(): SparseNode {
  const keyed: SparseNode = {};
  return Object.assign([], keyed);
}

export function normalizeParserNested(value: unknown): unknown {
  return normalizeNested(value);
}
