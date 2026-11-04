#!/usr/bin/env bun
/**
 * Path B probe: fetch or read raw envelope → parse GENERAL only → write tree to scratch/.
 * Never writes raw envelope, PLAYERS, or response text.
 *
 *   MODE=file bun run probe:parse-tree
 *   MODE=replay F402_AGENT_ID=… F402_AGENT_TYPE=M bun run probe:parse-tree -- --account tests/fixtures/f402-get-account-info-owner-fixture.json
 */
import { join } from "node:path";

import {
  logCaptureEvent,
  flushCaptureLog,
} from "../../lib/f402_hierarchy_redact_log.ts";
import {
  fetchListAgentsGeneralProbe,
  generalProbeFromWireText,
  loadAccountForGeneralProbe,
  masterContextFromAccount,
} from "../../lib/f402_list_agents_general_probe.ts";
import { normalizeNested } from "../../lib/f402_portal_hierarchy_oracle.ts";
import { runBaseHeriarchyParser } from "../../lib/f402_portal_hierarchy_parser.ts";

const REPO = join(import.meta.dir, "../..");
const SCRATCH = join(REPO, "scratch");

const mode = (Bun.env.MODE ?? "file").trim().toLowerCase();
const outPath =
  Bun.env.F402_PARSED_TREE_OUT?.trim() || join(SCRATCH, "parsed-tree.json");
const logPath =
  Bun.env.F402_PROBE_LOG?.trim() || join(SCRATCH, "parse-tree-only.log.jsonl");

function emit(event: Record<string, unknown>): void {
  logCaptureEvent(logPath, event);
  console.error(JSON.stringify(event));
}

async function loadGeneralProbe(): Promise<{
  probe: Awaited<ReturnType<typeof generalProbeFromWireText>>;
  master: { masterId: string; masterLogin: string };
}> {
  if (mode === "file") {
    const rawPath =
      Bun.env.F402_RAW_ENVELOPE?.trim() ||
      join(SCRATCH, "raw-f402-list-agents.json");
    if (!rawPath.startsWith(`${SCRATCH}/`)) {
      throw new Error("F402_RAW_ENVELOPE must be under scratch/ (gitignored)");
    }
    const t0 = Bun.nanoseconds();
    const text = await Bun.file(rawPath).text();
    const probe = generalProbeFromWireText(text);
    emit({
      signal: "F402_PROBE_ENVELOPE_LOADED",
      mode: "file",
      ms: (Bun.nanoseconds() - t0) / 1_000_000,
      generalRowCount: probe.generalRowCount,
      playersRowCount: probe.playersRowCount,
      extra: probe.extra,
    });
    return {
      probe,
      master: {
        masterId: Bun.env.F402_MASTER_ID?.trim() || "MASTER1",
        masterLogin: Bun.env.F402_MASTER_LOGIN?.trim() || "MASTER1",
      },
    };
  }

  if (mode !== "replay") {
    throw new Error(`MODE must be file|replay (got ${JSON.stringify(mode)})`);
  }

  const accountArg =
    Bun.argv
      .find((a) => a.startsWith("--account="))
      ?.slice(9)
      ?.trim() ??
    (Bun.argv.includes("--account")
      ? Bun.argv[Bun.argv.indexOf("--account") + 1]?.trim()
      : undefined) ??
    "tests/fixtures/f402-get-account-info-owner-fixture.json";

  const account =
    Bun.env.F402_AGENT_ID !== undefined && Bun.env.F402_AGENT_TYPE !== undefined
      ? {
          agentID: Bun.env.F402_AGENT_ID.trim(),
          accountInfo: { AgentType: Bun.env.F402_AGENT_TYPE.trim() },
        }
      : await loadAccountForGeneralProbe(accountArg);

  const t0 = Bun.nanoseconds();
  const probe = await fetchListAgentsGeneralProbe({
    account,
    proxyUrl: Bun.env.F402_REPLAY_PROXY_URL,
  });
  emit({
    signal: "F402_PROBE_ENVELOPE_FETCHED",
    mode: "replay",
    ms: (Bun.nanoseconds() - t0) / 1_000_000,
    generalRowCount: probe.generalRowCount,
    playersRowCount: probe.playersRowCount,
    extra: probe.extra,
  });
  return { probe, master: masterContextFromAccount(account) };
}

const tMain = Bun.nanoseconds();
const { probe, master } = await loadGeneralProbe();

if (probe.generalRowCount === 0) {
  throw new Error("GENERAL is empty");
}

const tParse0 = Bun.nanoseconds();
const tree = runBaseHeriarchyParser(probe.general, {
  masterId: master.masterId,
  masterLogin: master.masterLogin,
});
const normalized = normalizeNested(tree);
const parseMs = (Bun.nanoseconds() - tParse0) / 1_000_000;

if (!outPath.startsWith(`${SCRATCH}/`)) {
  throw new Error("F402_PARSED_TREE_OUT must be under scratch/");
}

await Bun.write(outPath, `${JSON.stringify(normalized, null, 2)}\n`);

emit({
  signal: "F402_PROBE_TREE_WRITTEN",
  outPath: outPath.replace(`${REPO}/`, ""),
  parseMs,
  totalMs: (Bun.nanoseconds() - tMain) / 1_000_000,
  generalRowCount: probe.generalRowCount,
});

flushCaptureLog();

if (typeof Bun.gc === "function") {
  Bun.gc(true);
}
