/**
 * Graphviz DOT emission + build-time rendering (never called from an HTTP handler).
 */

import type { LaidOutGraph, LaidOutNode } from "./f402_agent_graph_metrics.ts";

/** Okabe–Ito palette (color-blind safe), assigned to branches by size. */
export const BRANCH_PALETTE = [
  "#56B4E9",
  "#E69F00",
  "#009E73",
  "#CC79A7",
  "#0072B2",
  "#F0E442",
] as const;
export const UNBRANCHED_COLOR = "#94a3b8";
export const OVERFLOW_COLOR = "#D55E00";

export interface AgentViewNode {
  readonly kind: "agent";
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly branchId: string;
  /** Subtree size including self (levels ≤ max). */
  readonly subtreeSize: number;
  /** Descendants folded into this node's `+N` badge (shown in another view). */
  readonly hiddenDescendants: number;
  /** Overflow agents (level > max) owned by this node. */
  readonly overflowCount: number;
}

/** Leaf children of one parent rendered as a single multi-column name table. */
export interface LeafBundleNode {
  readonly kind: "leaves";
  readonly id: string;
  readonly parentId: string;
  readonly level: number;
  readonly branchId: string;
  readonly logins: readonly string[];
  readonly agentIds: readonly string[];
  readonly overflowByAgent: Readonly<Record<string, number>>;
}

export type GraphViewNode = AgentViewNode | LeafBundleNode;

export type RankDir = "TB" | "LR";

export interface GraphView {
  readonly id: string;
  readonly title: string;
  readonly focusId: string | null;
  readonly nodes: readonly GraphViewNode[];
  readonly edges: readonly {
    readonly source: string;
    readonly target: string;
  }[];
  readonly branchColors: Readonly<Record<string, string>>;
}

export type GraphvizEngine = "dot" | "twopi";

const FONT = "Helvetica";
export const VIEW_FONT_SIZE = 12;

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function html(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function agentLabel(n: AgentViewNode): string {
  const lines = [
    n.label,
    `L${n.level} · ${n.subtreeSize} agent${n.subtreeSize === 1 ? "" : "s"}`,
  ];
  if (n.hiddenDescendants > 0) lines.push(`+${n.hiddenDescendants} below`);
  if (n.overflowCount > 0) lines.push(`+${n.overflowCount} L13+`);
  return lines.join("\n");
}

export function leafBundleColumns(count: number): number {
  return Math.max(1, Math.min(8, Math.ceil(Math.sqrt(count / 2.5))));
}

function bundleLabel(n: LeafBundleNode, color: string): string {
  const cols = leafBundleColumns(n.logins.length);
  const cells = n.logins.map((login, i) => {
    const overflow = n.overflowByAgent[n.agentIds[i] ?? ""] ?? 0;
    return overflow > 0
      ? `<TD ALIGN="LEFT"><FONT COLOR="${OVERFLOW_COLOR}"><B>${html(login)} +${overflow}</B></FONT></TD>`
      : `<TD ALIGN="LEFT">${html(login)}</TD>`;
  });
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += cols)
    rows.push(`<TR>${cells.slice(i, i + cols).join("")}</TR>`);
  return (
    `<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="2" BGCOLOR="${color}" COLOR="#1e293b">` +
    `<TR><TD COLSPAN="${cols}" ALIGN="LEFT"><B>${n.logins.length} leaf agents · L${n.level}</B></TD></TR>` +
    `${rows.join("")}</TABLE>>`
  );
}

export function renderViewDot(
  view: GraphView,
  options?: {
    readonly engine?: GraphvizEngine;
    readonly legend?: boolean;
    readonly rankdir?: RankDir;
  },
): string {
  const engine = options?.engine ?? "dot";
  const rankdir = options?.rankdir ?? "TB";
  const big = view.nodes.length > 400;
  const out: string[] = [];
  out.push(`digraph ${q(view.id)} {`);
  out.push(
    `  graph [bgcolor="#0b1220" fontname=${q(FONT)} fontcolor="#e2e8f0" fontsize=18 labelloc=t label=${q(view.title)}` +
      (engine === "dot"
        ? ` rankdir=${rankdir} nodesep=0.12 ranksep=0.45 splines=${big ? "line" : "ortho"}`
        : ` ranksep=1.4 overlap=false splines=line${view.focusId ? ` root=${q(view.focusId)}` : ""}`) +
      "];",
  );
  out.push(
    `  node [shape=box style="rounded,filled" fontname=${q(FONT)} fontsize=${VIEW_FONT_SIZE} fontcolor="#0b1220" color="#1e293b" penwidth=1 margin="0.06,0.03"];`,
  );
  out.push(`  edge [color="#64748b" arrowsize=0.5 penwidth=1];`);

  for (const n of view.nodes) {
    const color = view.branchColors[n.branchId] ?? UNBRANCHED_COLOR;
    if (n.kind === "leaves") {
      out.push(`  ${q(n.id)} [shape=plain label=${bundleLabel(n, color)}];`);
      continue;
    }
    const scale = Math.log10(Math.max(1, n.subtreeSize));
    const attrs = [
      `label=${q(agentLabel(n))}`,
      `fillcolor=${q(color)}`,
      `width=${(0.8 + 0.35 * scale).toFixed(2)}`,
      `height=${(0.35 + 0.12 * scale).toFixed(2)}`,
      `tooltip=${q(`${n.id} · level ${n.level} · subtree ${n.subtreeSize}`)}`,
    ];
    if (n.id === view.focusId) attrs.push(`penwidth=3 color="#f8fafc"`);
    else if (n.overflowCount > 0)
      attrs.push(`color=${q(OVERFLOW_COLOR)} penwidth=3`);
    if (n.hiddenDescendants > 0) attrs.push(`peripheries=2`);
    out.push(`  ${q(n.id)} [${attrs.join(" ")}];`);
  }
  for (const e of view.edges) out.push(`  ${q(e.source)} -> ${q(e.target)};`);

  if (options?.legend !== false) {
    const rows = Object.entries(view.branchColors)
      .map(
        ([branch, color]) =>
          `<TR><TD BGCOLOR="${color}" WIDTH="18"></TD><TD ALIGN="LEFT">branch ${html(branch)}</TD></TR>`,
      )
      .join("");
    out.push(
      `  "__legend" [shape=plain fontcolor="#e2e8f0" fontsize=11 label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="2">` +
        `<TR><TD COLSPAN="2" ALIGN="LEFT"><B>Legend</B></TD></TR>${rows}` +
        `<TR><TD BGCOLOR="${UNBRANCHED_COLOR}"></TD><TD ALIGN="LEFT">root / no level-2 branch</TD></TR>` +
        `<TR><TD COLSPAN="2" ALIGN="LEFT">LOGIN / L(level) · N agents = subtree incl. itself</TD></TR>` +
        `<TR><TD COLSPAN="2" ALIGN="LEFT">double border: +N below, see that agent's view</TD></TR>` +
        `<TR><TD BGCOLOR="${OVERFLOW_COLOR}"></TD><TD ALIGN="LEFT">orange: owns L13-19 overflow agents</TD></TR>` +
        `<TR><TD COLSPAN="2" ALIGN="LEFT">table: leaf agents of one parent</TD></TR>` +
        `<TR><TD COLSPAN="2" ALIGN="LEFT">box size: log(subtree size)</TD></TR>` +
        `</TABLE>>];`,
    );
  }
  out.push("}");
  return `${out.join("\n")}\n`;
}

export class GraphvizError extends Error {}

export async function runGraphviz(
  engine: GraphvizEngine,
  dot: string,
  format: "svg" | "png" | "json0",
  extraArgs: readonly string[] = [],
): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: [engine, `-T${format}`, ...extraArgs],
    stdin: new TextEncoder().encode(dot),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0)
    throw new GraphvizError(`${engine} exited ${code}: ${err.slice(0, 400)}`);
  return out;
}

interface Json0 {
  readonly bb?: string;
  readonly objects?: readonly {
    readonly name: string;
    readonly pos?: string;
    readonly width?: string;
    readonly height?: string;
  }[];
}

/** Lay out with Graphviz and return coordinates in points (y downward). */
export async function graphvizLayout(
  engine: GraphvizEngine,
  dot: string,
  edges: LaidOutGraph["edges"],
  fontSize: number,
): Promise<LaidOutGraph> {
  const json = JSON.parse(
    new TextDecoder().decode(await runGraphviz(engine, dot, "json0")),
  ) as Json0;
  const height = Number((json.bb ?? "0,0,0,0").split(",")[3] ?? 0);
  const nodes: LaidOutNode[] = [];
  for (const o of json.objects ?? []) {
    if (!o.pos || o.name.startsWith("__legend")) continue;
    const [x, y] = o.pos.split(",").map(Number);
    nodes.push({
      id: o.name,
      x: x ?? 0,
      y: height - (y ?? 0),
      w: Number(o.width ?? 0) * 72,
      h: Number(o.height ?? 0) * 72,
    });
  }
  return { nodes, edges, fontSize };
}
