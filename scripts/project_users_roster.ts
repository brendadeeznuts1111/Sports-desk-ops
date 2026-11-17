#!/usr/bin/env bun
/** Project a raw GENERAL/PLAYERS report to structural fields. Never writes the raw input. */

import { parseArgs } from "node:util";
import { projectUsersRoster } from "../lib/users_roster.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    in: { type: "string" },
    out: { type: "string", default: "Scratch/users-roster.projected.json" },
  },
});
if (!values.in) {
  console.error(
    "usage: bun scripts/project_users_roster.ts --in <raw.json> [--out <projected.json>]",
  );
  process.exit(2);
}
const raw = JSON.parse(await Bun.file(values.in).text());
const roster = projectUsersRoster(raw);
await Bun.write(values.out, `${JSON.stringify(roster, null, 2)}\n`);
console.log(
  `projected ${roster.agents.length} agents and ${roster.players.length} players to ${values.out} (no passwords/names retained)`,
);
