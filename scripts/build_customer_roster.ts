#!/usr/bin/env bun
/** Fill the customer book from the projected roster, matched to live positions. Local only. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    roster: {
      type: "string",
      default: join(ROOT, "Scratch/agent-feed/roster.projected.json"),
    },
    profiles: {
      type: "string",
      default: join(ROOT, "data/customer-profiles.json"),
    },
    out: {
      type: "string",
      default: join(ROOT, "Scratch/agent-feed/customer-roster.json"),
    },
  },
});
const norm = (value: unknown): string =>
  typeof value === "string"
    ? value.trim().toUpperCase().replace(/\.+$/, "")
    : "";

const roster = JSON.parse(await readFile(values.roster, "utf8")) as {
  agents: Array<{ agentId: string; level: number | null; type: string | null }>;
  players: Array<{
    customerId: string;
    login: string | null;
    agent: string | null;
  }>;
};
const profiles = JSON.parse(await readFile(values.profiles, "utf8")) as {
  profiles: Array<{
    customerId: string;
    positions?: Array<{ risk_usd?: number }>;
  }>;
};

const agentById = new Map(
  roster.agents.map((agent) => [norm(agent.agentId), agent]),
);
const positionByCustomer = new Map<
  string,
  { count: number; riskUsd: number }
>();
for (const profile of profiles.profiles) {
  const positions = profile.positions ?? [];
  if (positions.length === 0) continue;
  const riskUsd = positions.reduce(
    (total, position) => total + (position.risk_usd ?? 0),
    0,
  );
  positionByCustomer.set(norm(profile.customerId), {
    count: positions.length,
    riskUsd,
  });
}

const seen = new Set<string>();
const customers: Array<Record<string, unknown>> = [];
for (const player of roster.players) {
  const customerId = norm(player.customerId) || norm(player.login);
  if (customerId === "" || seen.has(customerId)) continue;
  seen.add(customerId);
  const agent =
    player.agent === null ? undefined : agentById.get(norm(player.agent));
  const positions =
    positionByCustomer.get(customerId) ??
    positionByCustomer.get(norm(player.login));
  customers.push({
    customerId,
    login: player.login,
    agentId: player.agent,
    agentLevel: agent?.level ?? null,
    agentType: agent?.type ?? null,
    source: "roster",
    ...(positions === undefined
      ? {}
      : { openPositions: positions.count, openRiskUsd: positions.riskUsd }),
  });
}
const totalPositions = profiles.profiles.reduce(
  (total, profile) => total + (profile.positions?.length ?? 0),
  0,
);
const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    roster: values.roster.replace(ROOT, "."),
    profiles: values.profiles.replace(ROOT, "."),
  },
  summary: {
    playersInRoster: roster.players.length,
    customers: customers.length,
    duplicateRows: roster.players.length - customers.length,
    openPositions: totalPositions,
    customersWithPositions: customers.filter(
      (row) => row.openPositions !== undefined,
    ).length,
  },
  customers,
};
await writeFile(values.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out.summary));
