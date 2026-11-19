import { expect, test } from "bun:test";
import { buildAgentTree, readAgentTreeFile } from "../lib/agent_tree.ts";
import { createAgentProfileLookup } from "../lib/agent_profile_lookup.ts";
import { buildCustomerProfiles } from "../lib/customer_profile.ts";
import { fixtureBookRows, fixtureTree } from "./__fixtures__/v1-edge-cases.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wire = {
  schemaVersion: 1,
  nodes: {
    ...fixtureTree.nodes,
    EMPTY: { p: "ROOT_AGENT" },
    ORPHAN: { p: "MISSING" },
  },
};
const { tree } = buildAgentTree(readAgentTreeFile(wire)!);
const { profiles } = buildCustomerProfiles(fixtureBookRows, fixtureTree);
const lookup = createAgentProfileLookup(
  tree,
  profiles,
  (r) => r.agentId,
  (r) => r.customerId,
);

test("root scopes preserve attribution and empty groups and isolate the disconnected C004", () => {
  expect(lookup("ROOT_AGENT", "self").meta?.customerIds).toEqual(["C001"]);
  const children = lookup(" root_agent ", "children");
  expect(children.query).toEqual({
    agentId: "ROOT_AGENT",
    rawAgentId: " root_agent ",
    scope: "children",
  });
  expect(children.byAgent?.map((g) => [g.agentId, g.rowCount])).toEqual([
    ["CHILD_OK", 1],
    ["EMPTY", 0],
  ]);
  const result = lookup("ROOT_AGENT", "downline");
  expect(result.agentCount).toBe(3);
  expect(result.profileRowCount).toBe(2);
  expect(result.attributedRows?.map((r) => [r.agentId, r.customerId])).toEqual([
    ["CHILD_OK", "C004"],
    ["CHILD_NO_LEVEL", "C005"],
  ]);
  expect(result.meta?.diagnostics).toMatchObject({
    emptyAgentCount: 1,
    excludedNodeCount: 3,
    uniqueCustomerIdCount: 2,
    duplicateCustomerIdCount: 0,
  });
});
test("unknown, cyclic, and orphan anchors have distinct status and never leak rows", () => {
  for (const [id, status] of [
    ["ghost_agent", "not_in_tree"],
    ["CYCLE_A", "disconnected"],
    ["ORPHAN", "disconnected"],
  ] as const) {
    expect(lookup(id, "self")).toMatchObject({
      agentStatus: status,
      agentIds: [],
      rows: [],
    });
  }
});
test("duplicate IDs in scope retain both rows and count extra occurrences", () => {
  const row = { agentId: "CHILD_OK", customerId: "same" };
  const query = createAgentProfileLookup(
    tree,
    [row, row],
    (r) => r.agentId,
    (r) => r.customerId,
    { capturedAt: null, snapshotId: "fixture" },
  );
  expect(query("ROOT_AGENT", "children")).toMatchObject({
    profileRowCount: 2,
    meta: {
      snapshotId: "fixture",
      capturedAt: null,
      customerIds: ["same", "same"],
      diagnostics: { duplicateCustomerIdCount: 1, uniqueCustomerIdCount: 1 },
    },
  });
});
test("package CLI follows the profile registry's recorded tree path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-profiles-"));
  try {
    const path = join(dir, "tree.json"),
      registry = join(dir, "registry.json");
    await Bun.write(path, JSON.stringify(wire));
    await Bun.write(
      registry,
      JSON.stringify({ schemaVersion: 1, profiles, source: { tree: path } }),
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "--silent",
        "profiles:agents",
        "--profiles",
        registry,
        "--agent",
        "ROOT_AGENT",
        "--scope",
        "downline",
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual(lookup("ROOT_AGENT", "downline"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
