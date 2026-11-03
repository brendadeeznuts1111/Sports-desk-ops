#!/usr/bin/env bun
/**
 * Stage 1 of two: prove DSH can LOAD this plugin under Bun, and that its tools REFUSE
 * input they do not understand.
 *
 * WHAT THIS PROVES: the module imports, `apply` registers exactly the seven tools, every tool
 * declaration is complete (description, parameters, output schema/render, execute), and the
 * closed sets reject unknown names — including prototype keys such as `toString` and
 * `__proto__`, which a plain `in` check would let through.
 *
 * WHAT IT DOES NOT PROVE: that a tool executes in production. `bun test` and this script run
 * under Bun, but the Host plugin shim runs in Electron's Node, where the `Bun` global does not
 * exist. That is stage 2 (`verify-runtime.mjs`), under the host's own runtime.
 *
 * Run: bun dsh-plugin/verify-load.mjs
 */

const HERE = import.meta.dir;
/** Every expected count below is read from this checkout, never written down. */
const REPO = "/Users/nolarose/code/sportsdesk-ops";

/**
 * Configuration is duplicated from `cordis.patch.yml` on purpose: the loader applies the
 * Schema defaults, but this script calls `apply` directly, exactly as the loader would after
 * parsing the patch.
 */
const CONFIG = {
  repoPath: "/Users/nolarose/code/sportsdesk-ops",
  bunPath: "bun",
  serviceUrl: "http://127.0.0.1:4020",
  timeoutMs: 60_000,
  gateTimeoutMs: 900_000,
  staleAfterMinutes: 1_440,
};

let failed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function check(label, body) {
  try {
    body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}
async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}

let plugin;
try {
  plugin = await import(`${HERE}/index.js`);
} catch (error) {
  console.error(
    `\nFAIL  cannot import ./index.js: ${error?.message ?? error}\n\n` +
      "This bundle is dependency-free by design: it must import nothing outside node: builtins.\n",
  );
  process.exit(1);
}
const SOURCE = await Bun.file(`${HERE}/index.js`).text();

const registered = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
    },
  },
};
plugin.apply(ctx, CONFIG);

const byName = new Map(registered.map((tool) => [tool.name, tool]));
const EXPECTED = [
  "sportsdesk_customer",
  "sportsdesk_data",
  "sportsdesk_dev",
  "sportsdesk_downline",
  "sportsdesk_markets",
  "sportsdesk_status",
  "sportsdesk_ticker",
];

console.log("verify-load: plugin shape");

check("module exports the cordis apply/name/inject contract", () => {
  assert(typeof plugin.apply === "function", "apply must be a function");
  assert(plugin.name === "sportsdesk-ops", `name is ${plugin.name}`);
  assert(
    Array.isArray(plugin.inject) && plugin.inject.includes("tools"),
    `inject is ${JSON.stringify(plugin.inject)}`,
  );
  // The bundle must stay dependency-free: a directory install is a link whose imports
  // resolve from this checkout, not from the profile (measured ERR_MODULE_NOT_FOUND).
  const imports = SOURCE.match(/from\s+"[^"]+"/g) ?? [];
  for (const specifier of imports) {
    assert(
      !specifier.includes("@deepseek-ai/"),
      `index.js imports a peer package: ${specifier}`,
    );
  }
});

check("registers exactly the seven read-only tools", () => {
  assert(
    registered.length === EXPECTED.length,
    `registered ${registered.length} tools`,
  );
  const names = registered.map((tool) => tool.name).sort();
  assert(
    Bun.deepEquals(names, EXPECTED, true),
    `names are ${JSON.stringify(names)}`,
  );
});

check("no tool name promises a writing action", () => {
  const WRITE = /deploy|ship|capture|dispatch|mutate|sync|import|resolve|write/;
  for (const tool of registered) {
    assert(!WRITE.test(tool.name), `${tool.name} looks like a writing tool`);
  }
});

for (const tool of registered) {
  check(`${tool.name} declares a complete contract`, () => {
    assert(
      typeof tool.description === "string" && tool.description.length > 80,
      "description must explain the capability",
    );
    assert(
      typeof tool.parameters === "object" && tool.parameters !== null,
      "parameters must be an object root",
    );
    assert(typeof tool.output?.schema === "object", "output.schema must exist");
    assert(
      typeof tool.output?.render === "function",
      "output.render must exist",
    );
    assert(typeof tool.execute === "function", "execute must exist");
  });
}

console.log("\nverify-load: closed sets refuse instead of guessing");

await checkAsync("sportsdesk_dev refuses unknown gates", async () => {
  for (const gate of [
    "nuke",
    "toString",
    "__proto__",
    "constructor",
    "env",
    "tokens",
  ]) {
    const result = await byName.get("sportsdesk_dev").execute({ run: [gate] });
    assert(result.available === false, `${gate} was accepted`);
    assert(
      result.reason === "unknown_gate",
      `${gate} reason is ${result.reason}`,
    );
  }
});

await checkAsync("sportsdesk_dev refuses a non-array run", async () => {
  // Raw registration does not validate arguments, so the body owns this refusal.
  const result = await byName.get("sportsdesk_dev").execute({ run: "secrets" });
  assert(result.available === false, "a non-array run was accepted");
  assert(result.reason === "invalid_run", `reason is ${result.reason}`);
});

await checkAsync("sportsdesk_data refuses an unknown dataset", async () => {
  const result = await byName.get("sportsdesk_data").execute({
    dataset: "not_a_dataset",
  });
  assert(result.reason === "unknown_dataset", `reason is ${result.reason}`);
});

await checkAsync("sportsdesk_data reports live-capture freshness", async () => {
  const tool = byName.get("sportsdesk_data");
  const capture = await tool.execute({ report: "capture" });
  assert(capture.available === true, "capture report was unavailable");
  assert(Array.isArray(capture.artifacts), "capture artifacts missing");
  const liveBets = capture.artifacts.find(
    (entry) => entry.name === "live-bets",
  );
  assert(liveBets !== undefined, "live-bets artifact not reported");
  assert(typeof liveBets.exists === "boolean", "exists must be a boolean");
  assert(liveBets.budgetMinutes === 120, "live-bets budget drifted");
  assert(
    typeof capture.ledger.present === "boolean",
    "ledger presence must be a boolean",
  );
  if (capture.ledger.present === false) {
    assert(
      String(capture.ledger.note).includes("MISSING"),
      "an absent journal must read MISSING, not zero sources",
    );
  }
  for (const artifact of capture.artifacts) {
    const effectiveAge =
      artifact.stampAgeMinutes ?? artifact.artifactAgeMinutes;
    assert(
      artifact.stale === null ||
        artifact.stale === effectiveAge > artifact.budgetMinutes,
      `stale flag disagrees with its own age for ${artifact.name}`,
    );
  }
  const unknownReport = await tool.execute({ report: "nope" });
  assert(
    unknownReport.reason === "unknown_report",
    "an unknown report was accepted",
  );
});

await checkAsync(
  "sportsdesk_downline refuses unknown subcommands",
  async () => {
    for (const subcommand of ["winners", "losers", "leaderboard", "drop"]) {
      const result = await byName
        .get("sportsdesk_downline")
        .execute({ subcommand });
      assert(result.available === false, `${subcommand} was accepted`);
      assert(
        result.reason === "unknown_subcommand",
        `${subcommand} reason is ${result.reason}`,
      );
    }
  },
);

await checkAsync("sportsdesk_downline validation refusals", async () => {
  const tool = byName.get("sportsdesk_downline");
  const missingId = await tool.execute({ subcommand: "agent" });
  assert(missingId.reason === "invalid_agent_id", "missing agentId accepted");
  const badLimit = await tool.execute({ subcommand: "top", limit: 0 });
  assert(badLimit.reason === "invalid_limit", "limit 0 accepted");
  const badSort = await tool.execute({ subcommand: "top", sortBy: "profit" });
  assert(badSort.reason === "unknown_sort", "unknown sort accepted");
});

console.log("\nverify-load: report form executes nothing");

await checkAsync(
  "sportsdesk_dev with no run names leaves every gate not_run",
  async () => {
    const result = await byName.get("sportsdesk_dev").execute({});
    assert(result.ok === null, `ok is ${JSON.stringify(result.ok)}`);
    assert(result.executed.length === 0, "something was executed");
    const statuses = new Set(
      Object.values(result.gates).map((gate) => gate.status),
    );
    assert(
      statuses.size === 1 && statuses.has("not_run"),
      `statuses are ${JSON.stringify([...statuses])}`,
    );
  },
);

console.log("\nverify-load: read-only tools answer against the real repo");

await checkAsync("sportsdesk_status reads the checkout", async () => {
  const result = await byName.get("sportsdesk_status").execute({
    service: false,
  });
  assert(result.available === true, "status was unavailable");
  assert(result.repo?.git?.available === true, "git state was unavailable");
  assert(typeof result.repo.git.branch === "string", "branch missing");
  JSON.stringify(result);
});

await checkAsync("sportsdesk_data inventories the datasets", async () => {
  const result = await byName.get("sportsdesk_data").execute({});
  assert(result.available === true, "data was unavailable");
  assert(
    Array.isArray(result.datasets) && result.datasets.length > 0,
    "no datasets were reported",
  );
  // EXPECTED counts come from the source files, not from this script.
  const downlineSource = await Bun.file(
    `${REPO}/sportsdesk_downline_data.json`,
  ).json();
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(downline?.exists === true, "downline snapshot missing");
  assert(
    downline.records === downlineSource.agents.length,
    `downline records ${downline.records} != source ${downlineSource.agents.length}`,
  );
  const bookSource = await Bun.file(
    `${REPO}/enriched_customers_full.json`,
  ).json();
  const customers = result.datasets.find((entry) => entry.name === "customers");
  assert(
    customers?.records === bookSource.length,
    `customer records ${customers?.records} != source ${bookSource.length}`,
  );
});

await checkAsync("sportsdesk_data inlines one requested dataset", async () => {
  const result = await byName
    .get("sportsdesk_data")
    .execute({ dataset: "downline" });
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(downline?.inlined === true, "downline was not inlined");
  assert(typeof downline.data?.meta === "object", "inlined data has no meta");
});

await checkAsync("sportsdesk_downline summarizes the snapshot", async () => {
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "summary" });
  assert(result.available === true, "downline was unavailable");
  assert(typeof result.source?.mtime === "string", "source mtime missing");
  assert(
    typeof result.meta?.total_sub_agents === "number",
    "meta.total_sub_agents missing",
  );
});

await checkAsync(
  "sportsdesk_downline finds one agent, case-insensitively",
  async () => {
    const result = await byName
      .get("sportsdesk_downline")
      .execute({ subcommand: "agent", agentId: "bigdad" });
    assert(result.found === true, "BIGDAD was not found");
    assert(
      result.agent?.agent === "BIGDAD",
      "agent id was not normalised back",
    );
  },
);

await checkAsync("sportsdesk_downline ranks agents by net", async () => {
  const snapshot = await Bun.file(
    `${REPO}/sportsdesk_downline_data.json`,
  ).json();
  const limit = 3;
  const expected = Math.min(limit, snapshot.agents.length);
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "top", limit });
  assert(
    result.agents?.length === expected,
    `returned ${result.agents?.length}, source has ${snapshot.agents.length}`,
  );
  const nets = result.agents.map((agent) => Number(agent.lifetime_net));
  for (let index = 1; index < nets.length; index += 1) {
    assert(
      nets[index - 1] >= nets[index],
      `not descending: ${JSON.stringify(nets)}`,
    );
  }
});

await checkAsync(
  "sportsdesk_customer derives every count from the book",
  async () => {
    const tool = byName.get("sportsdesk_customer");
    const book = await Bun.file(`${REPO}/enriched_customers_full.json`).json();
    const ticketTotal = book.reduce(
      (total, row) =>
        total +
        (Array.isArray(row.recent_tickets) ? row.recent_tickets.length : 0),
      0,
    );

    const summary = await tool.execute({ report: "summary" });
    assert(summary.available === true, "summary unavailable");
    assert(
      summary.derived?.customers === book.length,
      `customers ${summary.derived?.customers} != source ${book.length}`,
    );
    assert(
      summary.derived?.totalRecentTickets === ticketTotal,
      `tickets ${summary.derived?.totalRecentTickets} != source ${ticketTotal}`,
    );
    assert(
      typeof summary.source?.mtime === "string",
      "summary source mtime missing",
    );

    const limit = 3;
    const top = await tool.execute({ report: "top", sortBy: "net", limit });
    assert(
      top.customers?.length === Math.min(limit, book.length),
      `top returned ${top.customers?.length}`,
    );
    for (let index = 1; index < top.customers.length; index += 1) {
      assert(
        Number(top.customers[index - 1].lifetime_net_usd) >=
          Number(top.customers[index].lifetime_net_usd),
        "top is not descending by net",
      );
    }

    // The 7d window must also be derived from the source rows, not from a fixed list.
    const expectedSevenDay = book
      .filter((row) => (row.sports_7d_net_usd ?? 0) > 0)
      .sort(
        (left, right) =>
          (right.sports_7d_net_usd ?? 0) - (left.sports_7d_net_usd ?? 0),
      )
      .slice(0, Math.min(limit, book.length))
      .map((row) => row.customer_id);
    const sevenDayTop = await tool.execute({
      report: "top",
      sortBy: "net",
      window: "7d",
      limit,
    });
    assert(
      sevenDayTop.customers?.length === expectedSevenDay.length,
      `7d top returned ${sevenDayTop.customers?.length}, source has ${expectedSevenDay.length}`,
    );
    assert(
      sevenDayTop.customers?.[0]?.customer_id === expectedSevenDay[0],
      `7d top ${sevenDayTop.customers?.[0]?.customer_id} != source ${expectedSevenDay[0]}`,
    );
    const badWindow = await tool.execute({ report: "top", window: "month" });
    assert(
      badWindow.reason === "invalid_arguments",
      "an unsupported window was accepted",
    );
    const lifetimeOnlySort = await tool.execute({
      report: "top",
      sortBy: "clv",
      window: "7d",
    });
    assert(
      lifetimeOnlySort.reason === "invalid_arguments",
      "clv was accepted on the 7d window",
    );

    // "sharp" must derive its candidate set from the book, not from a list.
    const threshold = 70;
    const expectedCandidates = book.filter(
      (row) =>
        (row.sharp_score ?? Number.NEGATIVE_INFINITY) >= threshold ||
        (row.clv_bps ?? 0) > 0,
    );
    const sharp = await tool.execute({
      report: "sharp",
      minSharp: threshold,
      limit,
    });
    assert(sharp.available === true, "sharp report unavailable");
    assert(
      sharp.candidates === expectedCandidates.length,
      `sharp candidates ${sharp.candidates} != source ${expectedCandidates.length}`,
    );
    assert(
      sharp.customers?.length === Math.min(limit, expectedCandidates.length),
      `sharp returned ${sharp.customers?.length}`,
    );
    const badThreshold = await tool.execute({
      report: "sharp",
      minSharp: 101,
    });
    assert(
      badThreshold.reason === "invalid_arguments",
      "an out-of-range minSharp was accepted",
    );

    // "profile" / "signals" / "compare": ranks and cutoffs must be derived from the book.
    const topVolume = book
      .slice()
      .sort(
        (left, right) =>
          (right.lifetime_volume_usd ?? 0) - (left.lifetime_volume_usd ?? 0),
      )[0];
    const profile = await tool.execute({
      report: "profile",
      customerId: topVolume.customer_id,
    });
    assert(
      profile.available === true && profile.found === true,
      "profile was unavailable",
    );
    assert(
      profile.customer_id === topVolume.customer_id,
      `profile id ${profile.customer_id} != source ${topVolume.customer_id}`,
    );
    assert(
      profile.sample?.tickets === (topVolume.recent_tickets ?? []).length,
      `profile tickets ${profile.sample?.tickets} != source ${(topVolume.recent_tickets ?? []).length}`,
    );
    assert(
      profile.cohortRanksPct?.volume >= 90,
      `top-volume rank ${profile.cohortRanksPct?.volume} is below 90`,
    );
    assert(
      profile.cohortRanksPct?.volume <= 100,
      "a percentile above 100 was returned",
    );
    assert(
      profile.cutoffs?.volumeP90 !== null,
      "profile did not return the cohort volume cutoff",
    );
    assert(
      profile.flags?.topDecileVolume ===
        topVolume.lifetime_volume_usd >= profile.cutoffs.volumeP90,
      "profile flag disagrees with its own cutoff",
    );
    const noProfileId = await tool.execute({ report: "profile" });
    assert(
      noProfileId.reason === "invalid_arguments",
      "profile without customerId was accepted",
    );
    const unknownProfile = await tool.execute({
      report: "profile",
      customerId: "NOT-A-CUSTOMER",
    });
    assert(
      unknownProfile.found === false,
      "an unknown profile id was reported as found",
    );

    const signals = await tool.execute({ report: "signals", limit });
    assert(signals.available === true, "signals was unavailable");
    const expectedWhales = book.filter(
      (row) =>
        (row.lifetime_volume_usd ?? Number.NEGATIVE_INFINITY) >=
        signals.cutoffs.volumeP90,
    ).length;
    assert(
      signals.signals?.whales?.matched === expectedWhales,
      `whales ${signals.signals?.whales?.matched} != source ${expectedWhales}`,
    );
    assert(
      signals.signals?.whales?.returned === Math.min(limit, expectedWhales),
      "whales returned count does not match the limit",
    );
    for (const row of signals.signals.whales.customers) {
      assert(
        row.lifetime_volume_usd >= signals.cutoffs.volumeP90,
        "a whale is below the returned cutoff",
      );
    }
    const subnetCounts = new Map();
    for (const row of book) {
      const subnet = String(row.ip_subnet ?? "").trim();
      if (subnet !== "")
        subnetCounts.set(subnet, (subnetCounts.get(subnet) ?? 0) + 1);
    }
    const expectedNetworks = [...subnetCounts.values()].filter(
      (count) => count >= 2,
    ).length;
    assert(
      signals.multiAccountNetworks?.matched === expectedNetworks,
      `networks ${signals.multiAccountNetworks?.matched} != source ${expectedNetworks}`,
    );

    // Dormant must compare UNROUNDED staleness against the cutoff. Rounding it to one
    // decimal first made every customer fall below p90 and silently reported 0 matches.
    const lastByCustomer = new Map();
    let newestPlaced = "";
    for (const row of book) {
      let last = "";
      for (const ticket of row.recent_tickets ?? []) {
        const placed = String(ticket.placed_at ?? "");
        if (placed > last) last = placed;
        if (placed > newestPlaced) newestPlaced = placed;
      }
      if (last !== "") lastByCustomer.set(row.customer_id, last);
    }
    const newestMs = Date.parse(newestPlaced);
    const expectedDormant = book.filter((row) => {
      const last = lastByCustomer.get(row.customer_id);
      if (last === undefined) return false;
      return (
        (newestMs - Date.parse(last)) / 86_400_000 >=
        signals.cutoffs.dormantDaysP90
      );
    }).length;
    assert(
      signals.signals.dormant.matched === expectedDormant,
      `dormant ${signals.signals.dormant.matched} != source ${expectedDormant}`,
    );
    assert(
      expectedDormant > 0,
      "a book with a staleness spread derived 0 dormant customers",
    );

    // "integrity": the provenance verdict and every feature count must come from the book.
    const integrity = await tool.execute({ report: "integrity" });
    assert(integrity.available === true, "integrity was unavailable");
    const ticketRows = book.flatMap((row) => row.recent_tickets ?? []);
    const documentationPrefixes = ["192.0.2.", "198.51.100.", "203.0.113."];
    const expectedDocSubnets = new Set(
      book
        .map((row) => String(row.ip_subnet ?? "").trim())
        .filter((subnet) =>
          documentationPrefixes.some((prefix) => subnet.startsWith(prefix)),
        ),
    ).size;
    assert(
      integrity.integrity.subnets.documentationRange === expectedDocSubnets,
      `documentation subnets ${integrity.integrity.subnets.documentationRange} != source ${expectedDocSubnets}`,
    );
    const expectedPlaceholders = ticketRows.filter((ticket) =>
      /^(Selection #\d+|Game Matchup \d+)$/.test(
        String(ticket.selection ?? ""),
      ),
    ).length;
    assert(
      integrity.integrity.selections.placeholderCount === expectedPlaceholders,
      `placeholder tickets ${integrity.integrity.selections.placeholderCount} != source ${expectedPlaceholders}`,
    );
    const expectedStamps = new Set(
      ticketRows.map((ticket) => String(ticket.placed_at ?? "")),
    ).size;
    assert(
      integrity.integrity.timestamps.distinct === expectedStamps,
      `timestamps ${integrity.integrity.timestamps.distinct} != source ${expectedStamps}`,
    );
    assert(
      integrity.integrity.ticketCounts.distinct === 1,
      "the book no longer has a uniform sample size; revisit the feature",
    );
    assert(
      integrity.integrity.character === "generated-fixture",
      `expected a generated-fixture verdict, got ${integrity.integrity.character}`,
    );
    assert(
      integrity.integrity.features.length >= 3,
      `expected at least 3 provenance features, got ${integrity.integrity.features.length}`,
    );
    assert(
      profile.bookIntegrity?.character === integrity.integrity.character,
      "profile does not carry the same book character",
    );
    assert(
      signals.bookIntegrity?.character === integrity.integrity.character,
      "signals does not carry the same book character",
    );
    assert(
      typeof signals.multiAccountNetworks?.interpretation === "string",
      "multiAccountNetworks has no provenance interpretation",
    );

    const compare = await tool.execute({
      report: "compare",
      customerIds: [book[0].customer_id, book[1].customer_id],
    });
    assert(compare.available === true, "compare was unavailable");
    assert(
      compare.customers?.length === compare.compared && compare.compared === 2,
      `compare returned ${compare.customers?.length} of ${compare.compared}`,
    );
    const singleCompare = await tool.execute({
      report: "compare",
      customerIds: [book[0].customer_id],
    });
    assert(
      singleCompare.reason === "invalid_arguments",
      "compare accepted a single customer id",
    );

    const byAgent = new Map();
    for (const row of book) {
      const key = row.agent_id;
      const group = byAgent.get(key) ?? { customers: 0, net: 0 };
      group.customers += 1;
      group.net += row.lifetime_net_usd;
      byAgent.set(key, group);
    }
    const agentReport = await tool.execute({ report: "agent", limit });
    assert(agentReport.available === true, "agent report unavailable");
    assert(
      agentReport.totalAgents === byAgent.size,
      `totalAgents ${agentReport.totalAgents} != source ${byAgent.size}`,
    );
    const expectedTopAgent = [...byAgent.entries()].sort(
      (left, right) => right[1].net - left[1].net,
    )[0]?.[0];
    assert(
      agentReport.agents?.[0]?.agent_id === expectedTopAgent,
      `top agent ${agentReport.agents?.[0]?.agent_id} != source ${expectedTopAgent}`,
    );
    const agentFilter = await tool.execute({
      report: "agent",
      agentId: String(expectedTopAgent).toLowerCase(),
    });
    assert(
      agentFilter.agents?.length === 1 &&
        agentFilter.agents[0].agent_id === expectedTopAgent,
      "agent filter did not isolate one agent",
    );

    const firstId = book[0].customer_id;
    const lookup = await tool.execute({
      report: "lookup",
      customerId: String(firstId).toLowerCase(),
    });
    assert(lookup.found === true, `lookup missed ${firstId}`);
    assert(
      lookup.ticketDerived?.count === (book[0].recent_tickets ?? []).length,
      "ticket-derived count does not match the source row",
    );

    const search = await tool.execute({ report: "search", q: String(firstId) });
    assert(
      search.customers?.some((row) => row.customer_id === firstId),
      `search missed ${firstId}`,
    );

    const unknown = await tool.execute({ report: "nope" });
    assert(
      unknown.reason === "unknown_report",
      `unknown reason ${unknown.reason}`,
    );
    const missingId = await tool.execute({ report: "lookup" });
    assert(
      missingId.reason === "invalid_arguments",
      "a lookup without customerId was accepted",
    );
  },
);

await checkAsync("sportsdesk_markets refuses unknown reports", async () => {
  for (const report of ["winners", "toString", "__proto__", "constructor"]) {
    const result = await byName.get("sportsdesk_markets").execute({ report });
    assert(result.available === false, `${report} was accepted`);
    assert(result.reason === "unknown_report", `${report} -> ${result.reason}`);
  }
  const badLimit = await byName
    .get("sportsdesk_markets")
    .execute({ report: "bridge", limit: 0 });
  assert(badLimit.reason === "invalid_arguments", "limit 0 accepted");
});

await checkAsync(
  "sportsdesk_markets summarizes the staged reports",
  async () => {
    const tool = byName.get("sportsdesk_markets");
    const combos = await tool.execute({ report: "combo-uniqueness" });
    assert(combos.available === true, "combo-uniqueness unavailable");
    assert(
      typeof combos.source?.generatedAtIso === "string",
      "generatedAtIso missing",
    );
    assert(combos.gates?.permissive?.kept > 0, "permissive gate kept nothing");
    const bridgeSource = await Bun.file(
      `${REPO}/dist/cross-domain-bridge.json`,
    ).json();
    const leadLimit = 3;
    const bridge = await tool.execute({ report: "bridge", limit: leadLimit });
    assert(
      bridge.leads?.length === Math.min(leadLimit, bridgeSource.leads.length),
      `leads ${bridge.leads?.length}, source ${bridgeSource.leads.length}`,
    );
    const priorities = bridge.leads.map((lead) => Number(lead.priorityUsd));
    assert(
      priorities[0] >= priorities[1] && priorities[1] >= priorities[2],
      `leads not ranked: ${JSON.stringify(priorities)}`,
    );
    const backtest = await tool.execute({ report: "backtest", limit: 2 });
    assert(backtest.available === true, "backtest unavailable");
    assert(
      typeof backtest.totals?.baselineTotalDeskNetUsd4Wk === "number",
      "backtest totals missing",
    );
    const backtestSource = await Bun.file(
      `${REPO}/dist/backtest-4wk-cfb-nba.json`,
    ).json();
    assert(
      backtest.comboFamilies?.length ===
        Math.min(2, backtestSource.comboFamilyBreakdown.length) &&
        backtest.customerLeaderboard?.length ===
          Math.min(2, backtestSource.customerLeaderboard.length),
      "backtest list caps are not derived from source",
    );
  },
);

await checkAsync(
  "sportsdesk_markets filters lists from the source",
  async () => {
    const bridgeArtifact = await Bun.file(
      `${REPO}/dist/cross-domain-bridge.json`,
    ).json();
    const verdict = "POLY_ONLY_UP";
    const expectedLeads = bridgeArtifact.leads.filter(
      (lead) => lead.verdict === verdict,
    ).length;
    const leads = await byName
      .get("sportsdesk_markets")
      .execute({ report: "bridge", verdict, limit: 100 });
    assert(
      leads.leads?.length === Math.min(100, expectedLeads),
      `filtered leads ${leads.leads?.length} != source ${expectedLeads}`,
    );

    const backtestArtifact = await Bun.file(
      `${REPO}/dist/backtest-4wk-cfb-nba.json`,
    ).json();
    const sport = "CFB";
    const expectedFamilies = backtestArtifact.comboFamilyBreakdown.filter(
      (family) => family.sport === sport,
    ).length;
    const families = await byName
      .get("sportsdesk_markets")
      .execute({ report: "backtest", sport, limit: 100 });
    assert(
      families.comboFamilies?.length === Math.min(100, expectedFamilies),
      `filtered families ${families.comboFamilies?.length} != source ${expectedFamilies}`,
    );
  },
);

await checkAsync(
  "sportsdesk_customer subsport derives ROI and CLV per league",
  async () => {
    const book = await Bun.file(`${REPO}/enriched_customers_full.json`).json();
    const tool = byName.get("sportsdesk_customer");
    const result = await tool.execute({ report: "subsport", limit: 100 });
    assert(result.available === true, "subsport unavailable");
    assert(result.dimension === "league", "default dimension is not league");
    assert(result.cohort === "curated-profiles", `cohort ${result.cohort}`);
    assert(typeof result.cohortNote === "string", "cohortNote missing");
    const byLeague = new Map();
    for (const row of book) {
      for (const ticket of row.recent_tickets ?? []) {
        const league = ticket.league ?? "UNKNOWN";
        const bucket = byLeague.get(league) ?? { risk: 0, net: 0 };
        bucket.risk += Number(ticket.risk_usd ?? 0);
        bucket.net += Number(ticket.net_usd ?? 0);
        byLeague.set(league, bucket);
      }
    }
    const topLeague = [...byLeague.entries()].sort(
      (left, right) => right[1].risk - left[1].risk,
    )[0];
    assert(
      result.subsports?.[0]?.league === topLeague?.[0],
      `top league ${result.subsports?.[0]?.league} != source ${topLeague?.[0]}`,
    );
    assert(
      result.subsports?.[0]?.sample?.riskUsd === topLeague?.[1].risk,
      `league risk ${result.subsports?.[0]?.sample?.riskUsd} != source ${topLeague?.[1].risk}`,
    );
    const expectedLifetimeRoi =
      (book.reduce((total, row) => total + row.lifetime_net_usd, 0) /
        book.reduce((total, row) => total + row.lifetime_volume_usd, 0)) *
      100;
    assert(
      Math.abs((result.cohortLifetime?.roiPct ?? 0) - expectedLifetimeRoi) <
        1e-9,
      `cohort lifetime ROI ${result.cohortLifetime?.roiPct} != source ${expectedLifetimeRoi}`,
    );
    assert(
      typeof result.subsports?.[0]?.lifetime?.roiPct === "number",
      "lifetime ROI missing from the row",
    );
    for (const row of result.subsports) {
      assert(
        typeof row.sample === "object" &&
          typeof row.lifetime === "object" &&
          row.sample !== null &&
          row.lifetime !== null,
        "row is missing the sample/lifetime split",
      );
    }
    const badDimension = await tool.execute({
      report: "subsport",
      dimension: "nope",
    });
    assert(
      badDimension.reason === "invalid_arguments",
      "an unsupported dimension was accepted",
    );
  },
);

await checkAsync(
  "sportsdesk_ticker derives pending and wagers from the captures",
  async () => {
    const tool = byName.get("sportsdesk_ticker");
    const pendingSource = await Bun.file(`${REPO}/data/live-bets.json`).json();
    const pending = await tool.execute({ report: "pending", limit: 100 });
    assert(pending.available === true, "pending unavailable");
    assert(
      pending.pendingCount === pendingSource.pendingCount,
      `pendingCount ${pending.pendingCount} != source ${pendingSource.pendingCount}`,
    );
    const expectedWagered = pendingSource.games.reduce(
      (total, game) => total + Number(game.wagered ?? 0),
      0,
    );
    assert(
      pending.wagered === expectedWagered,
      `wagered ${pending.wagered} != source ${expectedWagered}`,
    );
    assert(
      pending.scope === "agent-pending-report",
      `pending scope ${pending.scope}`,
    );
    assert(
      typeof pending.ageMinutes === "number",
      "pending ageMinutes missing",
    );
    assert(
      pending.totalGames === pendingSource.games.length,
      "game count does not match the source",
    );

    const wagersSource = await Bun.file(`${REPO}/data/live-wagers.json`).json();
    const wagers = await tool.execute({ report: "wagers", limit: 100 });
    assert(wagers.available === true, "wagers unavailable");
    assert(
      wagers.totalWagers === wagersSource.LIST.length,
      "wager count does not match the source",
    );
    const expectedAmount = wagersSource.LIST.reduce(
      (total, wager) => total + Number(wager.AmountWagered ?? 0),
      0,
    );
    assert(
      wagers.wagered === expectedAmount,
      `wagered ${wagers.wagered} != source ${expectedAmount}`,
    );
    assert(
      wagers.scope === "clipboard-ticker-sample",
      `wagers scope ${wagers.scope}`,
    );
    assert(wagers.parseWarnings === 0, `parseWarnings ${wagers.parseWarnings}`);
    assert(
      typeof wagers.wagerTypeLegend === "string",
      "wagerTypeLegend missing",
    );
    assert(
      typeof wagers.wagers?.[0]?.descCode === "string",
      "wager descCode missing",
    );

    const reconcile = await tool.execute({ report: "reconcile" });
    assert(
      reconcile.scope === "disjoint",
      `reconcile scope ${reconcile.scope}`,
    );
    assert(reconcile.overlapKeys === 0, "reconcile found an overlap");
    assert(
      typeof reconcile.magnitudeGapWagered === "number",
      "magnitude gap missing",
    );

    const unknown = await tool.execute({ report: "nope" });
    assert(
      unknown.reason === "unknown_report",
      "unknown ticker report accepted",
    );
  },
);

console.log(
  failed === 0
    ? "\nverify-load: PASS — 7 tools load and refuse invalid input (stage 1/2)."
    : `\nverify-load: ${failed} FAILURE(S) (stage 1/2).`,
);
process.exit(failed === 0 ? 0 : 1);
