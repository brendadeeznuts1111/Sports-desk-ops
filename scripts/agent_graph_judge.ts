#!/usr/bin/env bun
/**
 * Outside-judge harness: fixed operator questions, ground truth from the envelope tree,
 * scoring of answers produced by a human operator or a blind vision model.
 *
 *   bun run graph:agent:judge -- --questions
 *   bun run graph:agent:judge -- --score answers.json [--label new-views]
 *   answers.json: { "q1": "...", ..., "seconds"?: number }
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  resolveDefaultAgentGraphEnvelope,
  sha256HexFile,
} from "../lib/f402_agent_graph_artifacts.ts";
import {
  AGENT_GRAPH_VIEWS_DIR,
  type AgentGraphViewIndex,
} from "../lib/f402_agent_graph_views.ts";
import {
  type AgentTree,
  type AgentTreeNode,
  ancestorsOf,
  buildAgentTreeFromGeneral,
} from "../lib/f402_agent_tree.ts";
import { parseListAgentsByAgentWireText } from "../lib/f402_list_agents_wire_boundary.ts";

const REPO = join(import.meta.dir, "..");

interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly answer: string;
}

/** Largest subtree first, ties by id, so subject choice is deterministic per envelope. */
function largest(nodes: Iterable<AgentTreeNode>): AgentTreeNode {
  const sorted = [...nodes].sort(
    (a, b) => b.descendantCount - a.descendantCount || a.id.localeCompare(b.id),
  );
  if (sorted[0] === undefined) throw new Error("No agent matches the question rule");
  return sorted[0];
}

/**
 * Subjects are chosen by rule from the envelope, so no login is written in source: the
 * largest level-5 and level-8 agents, and the largest level-6 agent with its own view.
 */
export function buildQuestions(
  tree: AgentTree,
  focusIds: ReadonlySet<string>,
): readonly Question[] {
  const all = [...tree.nodes.values()];
  const atLevel = (level: number) => all.filter((n) => n.level === level);
  const parentOf = largest(atLevel(5));
  const sized = largest(atLevel(8));
  const chained = largest(atLevel(6).filter((n) => focusIds.has(n.id)));
  const login = (id: string | null) => (id ? tree.nodes.get(id)?.login : "") ?? "";
  return [
    {
      id: "q1",
      prompt:
        "Which level-2 agent has the largest downline (most agents beneath it)? Answer with its login.",
      answer: largest(atLevel(2)).login,
    },
    {
      id: "q2",
      prompt: `What is the login of the direct upline (parent) of agent ${parentOf.login}?`,
      answer: login(parentOf.parentId),
    },
    {
      id: "q3",
      prompt:
        "Which agent owns the most overflow agents (agents deeper than level 12 that are not drawn individually)? Answer with its login.",
      answer: [...all].sort((a, b) => b.overflowCount - a.overflowCount)[0]!.login,
    },
    {
      id: "q4",
      prompt: `How many agents are in ${sized.login}'s subtree, counting ${sized.login} itself? Answer with a number.`,
      answer: String(sized.descendantCount + 1),
    },
    {
      id: "q5",
      prompt: `List the full upline chain of ${chained.login} from the root down to its parent, as logins separated by ' > '.`,
      answer: ancestorsOf(tree, chained.id)
        .map((n) => n.login)
        .join(" > "),
    },
  ];
}

function normalize(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[›→]/g, ">")
    .replace(/\s*>\s*/g, " > ")
    .replace(/[^A-Z0-9 >]/g, "")
    .trim();
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    questions: { type: "boolean" },
    score: { type: "string" },
    label: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

async function main(): Promise<void> {
  if (values.help || (!values.questions && !values.score)) {
    console.log(`graph:agent:judge — operator / vision-model questions + scoring

  --questions          print the question sheet (JSON)
  --score <file>       score answers JSON against envelope ground truth
  --label <name>       label for the scored run (e.g. old-grid, new-views)
`);
    return;
  }
  const envelopePath = resolveDefaultAgentGraphEnvelope(REPO);
  const envelope = parseListAgentsByAgentWireText(
    await Bun.file(envelopePath).text(),
  );
  const tree = buildAgentTreeFromGeneral(envelope.GENERAL);
  const indexFile = Bun.file(join(REPO, "scratch", AGENT_GRAPH_VIEWS_DIR, "index.json"));
  if (!(await indexFile.exists())) {
    throw new Error("Missing views index — run: bun run graph:agent:views");
  }
  const index = JSON.parse(await indexFile.text()) as AgentGraphViewIndex;
  const questions = buildQuestions(
    tree,
    new Set(index.views.flatMap((v) => (v.focusId ? [v.focusId] : []))),
  );
  if (values.questions) {
    console.log(
      JSON.stringify(
        questions.map((q) => ({ id: q.id, prompt: q.prompt })),
        null,
        2,
      ),
    );
    return;
  }
  const answers = JSON.parse(await Bun.file(values.score!).text()) as Record<
    string,
    unknown
  >;
  const rows = questions.map((q) => {
    const expected = q.answer;
    const given = answers[q.id];
    return {
      id: q.id,
      correct: normalize(given) === normalize(expected),
      given,
      expected,
    };
  });
  const correct = rows.filter((r) => r.correct).length;
  console.log(
    JSON.stringify(
      {
        label: values.label ?? values.score,
        envelopeSha256: await sha256HexFile(envelopePath),
        correct,
        total: rows.length,
        seconds: answers["seconds"] ?? null,
        rows,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
