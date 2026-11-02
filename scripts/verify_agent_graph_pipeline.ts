#!/usr/bin/env bun
/**
 * Deterministic proof for agent-graph pipeline (run after graph:agent / graph:agent:image).
 * Exit 0 only when every check passes.
 *
 *   bun run verify:agent-graph
 *   bun run verify:agent-graph -- --strict   # requires webp + idempotent graph:agent subprocess
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  AGENT_GRAPH_READABILITY_THRESHOLDS,
  agentGraphArtifactPathsFromJsonOut,
  isAgentGraphBuildFresh,
  isAgentGraphViewsFresh,
  isAgentGraphWebpFreshForManifest,
  readAgentGraphManifest,
  resolveDefaultAgentGraphEnvelope,
  sha256HexFile,
} from "../lib/f402_agent_graph_artifacts.ts";
import {
  AGENT_GRAPH_VIEWS_DIR,
  type AgentGraphViewIndex,
  type StructuralGraphExport,
} from "../lib/f402_agent_graph_views.ts";
import { looksLike } from "../lib/screenshot_encode.ts";
import { loadAgentGraphExport } from "../lib/f402_agent_graph_view_http.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const REPO = join(import.meta.dir, "..");
const SCRATCH = join(REPO, "scratch");
const GRAPH_JSON = join(SCRATCH, "agent-graph.json");
const GRAPH_DB = join(SCRATCH, "agent-graph.sqlite");
const paths = agentGraphArtifactPathsFromJsonOut(GRAPH_JSON);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    strict: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`verify:agent-graph — read manifest + artifacts (+ optional HTTP)

  --strict   require fresh webp, min webp size, sqlite row count, graph:agent skip subprocess,
             fresh readable views (coverage, reconciliation, overflow sum, font/crossing/overlap
             thresholds), /views + /agent HTTP
  -h, --help
`);
  process.exit(0);
}

const strict = values.strict === true;

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function main(): Promise<void> {
  const envelope = resolveDefaultAgentGraphEnvelope(REPO);
  const envelopeExists = await Bun.file(envelope).exists();
  record("envelope exists", envelopeExists, envelope);
  if (!envelopeExists) {
    printAndExit();
    return;
  }

  const envelopeSha = await sha256HexFile(envelope);
  const manifest = await readAgentGraphManifest(paths.manifest);
  record("manifest readable", manifest !== null, paths.manifest);

  if (manifest) {
    record(
      "manifest envelope sha matches file",
      manifest.envelopeSha256 === envelopeSha,
      `${manifest.envelopeSha256.slice(0, 16)} vs ${envelopeSha.slice(0, 16)}`,
    );
    record(
      "manifest nodeCount matches math",
      manifest.envelopeGeneralRows - manifest.skippedOverflowCount ===
        manifest.ingestedRowCount,
      `general=${manifest.envelopeGeneralRows} overflow=${manifest.skippedOverflowCount} ingested=${manifest.ingestedRowCount}`,
    );
    record(
      "ingested row count sane (full tree)",
      manifest.ingestedRowCount >= 100,
      String(manifest.ingestedRowCount),
    );
  }

  const buildFresh = await isAgentGraphBuildFresh({
    manifestPath: paths.manifest,
    artifactPaths: paths,
    envelopeSha256: envelopeSha,
  });
  record(
    "graph build fresh (idempotent skip safe)",
    buildFresh,
    String(buildFresh),
  );

  if (strict && buildFresh) {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(REPO, "scripts/build_agent_graph.ts"),
        "--no-show-security-notice",
      ],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    record(
      "graph:agent subprocess skips when fresh",
      code === 0 && err.includes("up-to-date"),
      `exit=${code}`,
    );
  }

  let graph: Awaited<ReturnType<typeof loadAgentGraphExport>> | undefined;
  try {
    graph = await loadAgentGraphExport(GRAPH_JSON);
    record("agent-graph.json loads", true, `${graph.nodes.length} nodes`);
  } catch (e) {
    record("agent-graph.json loads", false, String(e));
  }

  if (graph && manifest) {
    record(
      "json node count matches manifest",
      graph.nodes.length === manifest.nodeCount,
      `json=${graph.nodes.length} manifest=${manifest.nodeCount}`,
    );
    record(
      "json edge count matches manifest",
      graph.edges.length === manifest.edgeCount,
      `json=${graph.edges.length} manifest=${manifest.edgeCount}`,
    );
  }

  if ((await Bun.file(GRAPH_DB).exists()) && manifest) {
    const db = openSportsdeskSqlite(GRAPH_DB);
    try {
      const row = db.query("SELECT COUNT(*) AS c FROM agents").get() as {
        c: number;
      };
      record(
        "sqlite agents count matches manifest",
        Number(row.c) === manifest.ingestedRowCount,
        `sqlite=${row.c} manifest=${manifest.ingestedRowCount}`,
      );
    } finally {
      db.close();
    }
  }

  const svgExists = await Bun.file(paths.graphSvg).exists();
  record("agent-graph.svg exists", svgExists, paths.graphSvg);

  const webpExists = await Bun.file(paths.graphWebp).exists();
  record(
    strict ? "agent-graph.webp exists (required)" : "agent-graph.webp exists",
    strict ? webpExists : true,
    webpExists ? paths.graphWebp : strict ? "missing" : "optional",
  );

  if (webpExists) {
    const webpBytes = new Uint8Array(
      await Bun.file(paths.graphWebp).arrayBuffer(),
    );
    record(
      "webp magic bytes",
      looksLike("webp", webpBytes),
      `${webpBytes.length} bytes`,
    );
    if (strict && manifest && manifest.nodeCount > 100) {
      record(
        "webp min size (non-blank capture)",
        webpBytes.length >= 50_000,
        `${webpBytes.length} >= 50000`,
      );
    }
    const webpFresh = await isAgentGraphWebpFreshForManifest(
      paths.manifest,
      paths.graphWebp,
    );
    record(
      "webp fresh for manifest",
      strict ? webpFresh : true,
      strict && !webpFresh ? "STRICT FAIL" : String(webpFresh),
    );
  } else if (strict) {
    record("webp fresh for manifest", false, "no webp file");
  }

  await verifyReadableViews(manifest);

  async function largestStructuralRootId(): Promise<string | null> {
    const file = Bun.file(join(SCRATCH, AGENT_GRAPH_VIEWS_DIR, "structural.json"));
    if (!(await file.exists())) return null;
    const structural = JSON.parse(await file.text()) as StructuralGraphExport;
    const roots = structural.nodes
      .filter((n) => n.data.upline === null)
      .sort((a, b) => b.data.subtree - a.data.subtree);
    return roots[0]?.data.id ?? null;
  }

  const port = Number(Bun.env.GRAPH_VIEW_PORT ?? "9876");
  if (strict) {
    const largestRoot = await largestStructuralRootId();
    for (const path of [
      "/views",
      `/agent/${encodeURIComponent(largestRoot ?? "(no structural.json)")}`,
    ]) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(3000),
        });
        record(
          `GET ${path} strict`,
          res.status === 200,
          `status=${res.status}`,
        );
      } catch (e) {
        record(`GET ${path} strict`, false, String(e));
      }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/graph.webp`, {
        signal: AbortSignal.timeout(3000),
      });
      record(
        "GET /graph.webp strict",
        res.ok && res.headers.get("content-type")?.includes("webp") === true,
        `status=${res.status} type=${res.headers.get("content-type")}`,
      );
      if (res.ok && webpExists) {
        const body = new Uint8Array(await res.arrayBuffer());
        const fileLen = (await Bun.file(paths.graphWebp).arrayBuffer())
          .byteLength;
        record(
          "/graph.webp body matches file",
          body.length === fileLen,
          `${body.length} bytes`,
        );
      }
    } catch (e) {
      record("GET /graph.webp strict", false, String(e));
    }
  }

  printAndExit();
}

async function verifyReadableViews(
  manifest: Awaited<ReturnType<typeof readAgentGraphManifest>>,
): Promise<void> {
  const fresh = await isAgentGraphViewsFresh(paths.manifest);
  record(
    strict ? "readable views fresh (required)" : "readable views fresh",
    strict ? fresh : true,
    fresh ? "viewsEnvelopeSha256 matches" : "run graph:agent:views",
  );
  const r = manifest?.readability;
  if (!fresh || !manifest || !r) return;
  const t = AGENT_GRAPH_READABILITY_THRESHOLDS;
  record(
    "views cover every ingested agent",
    r.coverage === manifest.ingestedRowCount,
    `covered=${r.coverage} ingested=${manifest.ingestedRowCount}`,
  );
  record(
    "every view reconciles (shown + +N badges = subtree)",
    r.reconciled,
    String(r.reconciled),
  );
  record(
    "overflow markers sum to skippedOverflow",
    r.overflowDrawn === manifest.skippedOverflowCount,
    `drawn=${r.overflowDrawn} skipped=${manifest.skippedOverflowCount}`,
  );
  record(
    `worst view font >= ${t.minFontPx}px`,
    r.worstFontPx >= t.minFontPx,
    `${r.worstFontPx}px over ${r.viewCount} views (${r.rankdir}, budget ${r.budget})`,
  );
  record(
    `edge crossings <= ${t.maxCrossings}`,
    r.totalCrossings <= t.maxCrossings,
    String(r.totalCrossings),
  );
  record(
    `node overlaps <= ${t.maxOverlaps}`,
    r.totalOverlaps <= t.maxOverlaps,
    String(r.totalOverlaps),
  );
  record(
    "portal-parser parent divergence (informational)",
    true,
    `${r.parentDivergence} agents differ from envelope nesting`,
  );

  const indexFile = Bun.file(
    join(SCRATCH, AGENT_GRAPH_VIEWS_DIR, "index.json"),
  );
  const structuralFile = Bun.file(
    join(SCRATCH, AGENT_GRAPH_VIEWS_DIR, "structural.json"),
  );
  if (!(await indexFile.exists()) || !(await structuralFile.exists())) {
    record("views index + structural.json exist", false, "missing");
    return;
  }
  const index = JSON.parse(await indexFile.text()) as AgentGraphViewIndex;
  record(
    "views index envelope sha matches manifest",
    index.envelopeSha256 === manifest.envelopeSha256,
    index.envelopeSha256.slice(0, 16),
  );
  let missing = 0;
  for (const v of index.views) {
    if (
      !(await Bun.file(join(SCRATCH, AGENT_GRAPH_VIEWS_DIR, v.webp)).exists())
    )
      missing += 1;
  }
  record(
    "every view webp on disk",
    missing === 0,
    `${index.views.length - missing}/${index.views.length}`,
  );

  // Independent check: recursive CTE over the portal-parser SQLite tree must agree with the
  // envelope-structural tree on per-root totals (divergence stays inside each root).
  const structural = JSON.parse(
    await structuralFile.text(),
  ) as StructuralGraphExport;
  const structuralRoots = new Map(
    structural.nodes
      .filter((n) => n.data.upline === null)
      .map((n) => [n.data.id, n.data.subtree]),
  );
  const db = openSportsdeskSqlite(GRAPH_DB);
  try {
    const rows = db
      .query(
        `WITH RECURSIVE t(agent_id, root) AS (
           SELECT agent_id, agent_id FROM agents WHERE level = 1
           UNION ALL SELECT a.agent_id, t.root FROM agents a JOIN t ON a.parent_id = t.agent_id)
         SELECT root, COUNT(*) AS c FROM t GROUP BY root`,
      )
      .all() as { root: string; c: number }[];
    const agree =
      rows.length === structuralRoots.size &&
      rows.every((row) => structuralRoots.get(row.root) === Number(row.c));
    record(
      "SQLite CTE per-root sizes match envelope tree",
      agree,
      rows.map((row) => `${row.root}=${row.c}`).join(" "),
    );
  } finally {
    db.close();
  }
}

function printAndExit(): void {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  }
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"} ${checks.length - failed.length}/${checks.length} checks (${strict ? "strict" : "default"})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
