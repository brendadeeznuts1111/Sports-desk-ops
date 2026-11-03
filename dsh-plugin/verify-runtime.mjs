#!/usr/bin/env node
/**
 * Stage 2 of two: prove the plugin EXECUTES under the HOST's real runtime.
 *
 * WHY THIS EXISTS
 *
 * `verify-load.mjs` runs under Bun, which is the one runtime that cannot detect the bug that
 * actually shipped in the reference plugin: it used `Bun.spawn`, loaded fine, and passed every
 * test — because `bun test` runs under Bun. The first real tool call failed with
 * "Bun is not defined", because the Host plugin shim runs in Electron's Node main process.
 *
 * This script runs under the host runtime and imports the ACTUAL module (which is why the
 * plugin is plain JavaScript: Node cannot import TypeScript), then calls every tool against
 * the real checkout. A crash here is a production crash.
 *
 * Run under the host binary, not plain node:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     dsh-plugin/verify-runtime.mjs
 *
 * `node dsh-plugin/verify-runtime.mjs` also works when the local Node matches (20+), but the
 * Electron binary is the runtime that matters.
 */

// ast-grep-ignore: node-fs-read-write-file -- stage 2 runs under Electron's Node, where Bun.file does not exist; reading the real files is the point.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const REPO = "/Users/nolarose/code/sportsdesk-ops";

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
async function check(label, body) {
  try {
    await body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}

const runtime = process.versions.bun
  ? `Bun ${process.versions.bun}`
  : process.versions.electron
    ? `Electron ${process.versions.electron} / Node ${process.versions.node}`
    : `Node ${process.versions.node}`;
console.log(`verify-runtime: ${runtime}\n`);

if (process.versions.bun) {
  console.log(
    "  WARN  running under Bun: this does not prove the Electron-Node Host runtime.\n",
  );
}

const plugin = await import(new URL("./index.js", import.meta.url).href);
const registered = [];
plugin.apply(
  {
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  },
  CONFIG,
);
const byName = new Map(registered.map((tool) => [tool.name, tool]));

await check("the shim has Node globals the plugin relies on", () => {
  assert(typeof fetch === "function", "fetch is missing");
  assert(typeof process.versions === "object", "process.versions is missing");
});

await check("the module loaded and registered seven tools", () => {
  assert(registered.length === 7, `registered ${registered.length} tools`);
});

await check(
  "sportsdesk_status executes (git spawn, no Bun global)",
  async () => {
    const result = await byName
      .get("sportsdesk_status")
      .execute({ service: false });
    assert(result.available === true, "status was unavailable");
    assert(result.repo?.git?.available === true, "git was not readable");
    JSON.stringify(result);
  },
);

await check("sportsdesk_data executes (node:fs reads)", async () => {
  const result = await byName.get("sportsdesk_data").execute({});
  assert(result.available === true, "data was unavailable");
  const snapshot = JSON.parse(
    // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
    readFileSync(`${REPO}/sportsdesk_downline_data.json`, "utf8"),
  );
  const downline = result.datasets.find((entry) => entry.name === "downline");
  assert(
    downline.records === snapshot.agents.length,
    `downline records ${downline.records} != source ${snapshot.agents.length}`,
  );
  JSON.stringify(result);
});

await check("sportsdesk_downline executes (snapshot parse)", async () => {
  const result = await byName
    .get("sportsdesk_downline")
    .execute({ subcommand: "summary" });
  assert(result.available === true, "downline was unavailable");
  JSON.stringify(result);
});

await check("sportsdesk_customer executes (derived book counts)", async () => {
  const book = JSON.parse(
    // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
    readFileSync(`${REPO}/enriched_customers_full.json`, "utf8"),
  );
  const result = await byName
    .get("sportsdesk_customer")
    .execute({ report: "summary" });
  assert(result.available === true, "summary was unavailable");
  assert(
    result.derived.customers === book.length,
    `customers ${result.derived.customers} != source ${book.length}`,
  );
  JSON.stringify(result);
});

await check(
  "sportsdesk_customer profile executes (derived ranks)",
  async () => {
    const book = JSON.parse(
      // ast-grep-ignore: node-fs-read-async -- same runtime split: this script must run under Node.
      readFileSync(`${REPO}/enriched_customers_full.json`, "utf8"),
    );
    const top = book
      .slice()
      .sort(
        (left, right) =>
          (right.lifetime_volume_usd ?? 0) - (left.lifetime_volume_usd ?? 0),
      )[0];
    const result = await byName.get("sportsdesk_customer").execute({
      report: "profile",
      customerId: top.customer_id,
    });
    assert(result.available === true, "profile was unavailable");
    assert(
      result.found === true,
      "profile did not find the top-volume customer",
    );
    assert(
      typeof result.cohortRanksPct?.volume === "number",
      "profile returned no volume percentile",
    );
    assert(
      typeof result.cutoffs?.volumeP90 === "number",
      "profile returned no cohort cutoff",
    );
    JSON.stringify(result);
  },
);

await check("sportsdesk_markets executes (dist artifact parse)", async () => {
  const result = await byName
    .get("sportsdesk_markets")
    .execute({ report: "backtest", limit: 2 });
  assert(result.available === true, "backtest was unavailable");
  assert(
    typeof result.totals?.baselineTotalDeskNetUsd4Wk === "number",
    "backtest totals missing",
  );
  JSON.stringify(result);
});

await check("sportsdesk_ticker executes (ticker captures)", async () => {
  const result = await byName
    .get("sportsdesk_ticker")
    .execute({ report: "wagers", limit: 3 });
  assert(result.available === true, "wagers was unavailable");
  JSON.stringify(result);
});

await check("sportsdesk_dev executes a real gate (spawns bun)", async () => {
  const result = await byName
    .get("sportsdesk_dev")
    .execute({ run: ["secrets"] });
  assert(
    result.gates?.secrets?.status === "passed",
    `secrets gate is ${JSON.stringify(result.gates?.secrets)}`,
  );
  JSON.stringify(result);
});

await check("the report form still executes nothing", async () => {
  const result = await byName.get("sportsdesk_dev").execute({});
  assert(result.ok === null, `ok is ${JSON.stringify(result.ok)}`);
  assert(result.executed.length === 0, "a gate was executed");
});

await check("bun is resolvable from the host runtime", () => {
  assert(
    CONFIG.bunPath === "bun" &&
      (existsSync(`${homedir()}/.bun/bin/bun`) || CONFIG.bunPath !== "bun"),
    "no bun at ~/.bun/bin/bun — set config.bunPath to an absolute path",
  );
});

console.log(
  failed === 0
    ? "\nverify-runtime: PASS — every tool executed in the host runtime (stage 2/2)."
    : `\nverify-runtime: ${failed} FAILURE(S) (stage 2/2).`,
);
process.exit(failed === 0 ? 0 : 1);
