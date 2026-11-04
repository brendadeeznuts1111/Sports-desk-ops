#!/usr/bin/env bun
/**
 * Dry / replay / oracle for `getListAgenstByAgent` (no parser).
 *
 *   bun run scripts/capture/f402_hierarchy_replay.ts --mode dry \\
 *     --account tests/fixtures/f402-get-account-info-owner-fixture.json
 *
 *   bun run session:login --from-profile <dir>
 *   bun run scripts/capture/f402_hierarchy_replay.ts --mode replay --account ...
 *
 *   F402_REPLAY_PROXY_URL=http://127.0.0.1:PORT bun run scripts/capture/f402_hierarchy_replay.ts --mode oracle --account ...
 */

import { parseArgs } from "node:util";

import { PROBE_HOST } from "../../lib/f402_hierarchy_config.ts";
import {
  loadAccountInfoOwnerFixture,
  loadListAgentsRequestFixture,
  runHierarchyReplay,
  type HierarchyReplayMode,
} from "../../lib/f402_hierarchy_replay.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string", default: "dry" },
    account: { type: "string" },
    body: { type: "string" },
    host: { type: "string" },
    profile: { type: "string" },
    proxy: { type: "string" },
    cookie: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`f402_hierarchy_replay — modes: dry | replay | oracle

  --account   JSON fixture: { agentID, accountInfo: { AgentType, ... } }
  --body      Optional POST field overrides (agentID, agentType, agentOwner, RRO)
  --mode      dry (default): print URL + form body only
  --host      default F402_PROBE_HOST / ${PROBE_HOST}
  --profile   Deprecated/ignored by the transport; use \`bun run session:login --from-profile <dir>\`
  --proxy     localhost replay proxy (F402_REPLAY_PROXY_URL) — secondary
  --cookie    deprecated (F402_COOKIE); use the session file
`);
  process.exit(0);
}

const accountPath = values.account?.trim();
if (accountPath === undefined || accountPath === "") {
  console.error("--account is required");
  process.exit(1);
}

const modeRaw = (values.mode ?? "dry").trim().toLowerCase();
if (modeRaw !== "dry" && modeRaw !== "replay" && modeRaw !== "oracle") {
  console.error(
    `--mode must be dry|replay|oracle (got ${JSON.stringify(values.mode)})`,
  );
  process.exit(1);
}
const mode = modeRaw as HierarchyReplayMode;

const accountJson = await Bun.file(accountPath).json();
const account = loadAccountInfoOwnerFixture(accountJson);
const bodyFixture =
  values.body !== undefined
    ? loadListAgentsRequestFixture(await Bun.file(values.body).json())
    : {};

if (values.profile !== undefined && values.profile.trim() !== "") {
  console.error(
    `--profile is ignored: the replay transport does not read WebView profiles. Mint a session with \`bun run session:login --from-profile ${values.profile.trim()}\`.`,
  );
}

const outcome = await runHierarchyReplay({
  mode,
  account,
  bodyFixture,
  host: values.host,
  proxyUrl: values.proxy ?? Bun.env.F402_REPLAY_PROXY_URL,
});

if (mode === "dry") {
  console.log(
    JSON.stringify(
      {
        mode,
        url: outcome.plan.url,
        method: outcome.plan.method,
        headers: outcome.plan.headers,
        body: outcome.plan.bodyRecord,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  JSON.stringify(
    {
      mode,
      url: outcome.plan.url,
      generalLength: outcome.oracle?.generalLength,
      oracleSnapshot: outcome.oracle?.oracleSnapshot,
      envelopeBytes: outcome.envelopeText?.length,
    },
    null,
    2,
  ),
);
