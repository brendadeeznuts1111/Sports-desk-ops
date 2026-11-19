import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { buildAgentTree, readAgentTreeFile } from "../lib/agent_tree.ts";
import { createAgentProfileLookup } from "../lib/agent_profile_lookup.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    agent: { type: "string" },
    scope: { type: "string", default: "self" },
    tree: { type: "string" },
    profiles: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: bun run profiles:agents --agent <login> [--scope self|children|downline] [--profiles <registry.json>] [--tree <agent-tree.json>]",
  );
  process.exit(0);
}
const { agent, scope } = values;
if (
  !agent?.trim() ||
  (scope !== "self" && scope !== "children" && scope !== "downline")
) {
  console.error(
    "Supply --agent <login> and a scope of self, children, or downline.",
  );
  process.exit(2);
}
const root = resolve(import.meta.dir, "..");
const registry = await Bun.file(
  values.profiles ?? resolve(root, "data/customer-profiles.json"),
).json();
if (
  registry?.schemaVersion !== 1 ||
  !Array.isArray(registry.profiles) ||
  !registry.profiles.every(
    (r: unknown) =>
      typeof r === "object" &&
      r !== null &&
      "agentId" in r &&
      typeof r.agentId === "string" &&
      "customerId" in r &&
      typeof r.customerId === "string",
  )
) {
  throw new Error(
    "Expected a v1 profile registry with agentId and customerId on each row",
  );
}
const path =
  values.tree ??
  (typeof registry.source?.tree === "string" &&
    resolve(root, registry.source.tree));
if (!path)
  throw new Error(
    "Supply --tree or record source.tree in the profile registry",
  );
const input = readAgentTreeFile(await Bun.file(path).json());
if (!input) throw new Error("Expected a v1 agent tree");
const { tree } = buildAgentTree(input);
const lookup = createAgentProfileLookup(
  tree,
  registry.profiles as { agentId: string; customerId: string }[],
  (r) => r.agentId,
  (r) => r.customerId,
);
console.log(JSON.stringify(lookup(agent, scope), null, 2));
