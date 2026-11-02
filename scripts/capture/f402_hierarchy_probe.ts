#!/usr/bin/env bun
/**
 * Filter or fetch `getListAgenstByAgent` with Bun-native PLAYERS_MODE (default off).
 *
 *   bun run scripts/capture/f402_hierarchy_probe.ts --file raw.json --out slim.json
 *   bun run scripts/capture/f402_hierarchy_probe.ts --stdin < raw.json
 *   F402_PLAYERS_MODE=projected bun run scripts/capture/f402_hierarchy_probe.ts --dry-run --fetch
 *
 * Live fetch uses WebView dataStore profile (F402_WEBVIEW_PROFILE) or session file — not F402_COOKIE.
 */

import { parseArgs } from "node:util";

import {
  assertNoAgentLoginCollisions,
  generalRowsAboveLevel,
  maxGeneralLevel,
} from "../../lib/f402_hierarchy_agents.ts";
import {
  closeAuditDb,
  recordBustDrift,
  recordProbeLog,
  recordQuarantine,
} from "../../lib/f402_hierarchy_audit.ts";
import {
  AUDIT_DB_PATH,
  CAPTURE_LOG_PATH,
  MANAGER_RRO,
  PLAYERS_MODE,
  PROBE_HOST,
  readPlayersMode,
} from "../../lib/f402_hierarchy_config.ts";
import { isDuplicateEnvelope } from "../../lib/f402_hierarchy_dedupe.ts";
import {
  buildHierarchyFormBody,
  filterHierarchyJsonStream,
} from "../../lib/f402_hierarchy_envelope.ts";
import { HierarchyEnvelopeView } from "../../lib/f402_hierarchy_envelope_view.ts";
import {
  envelopeTreeHash,
  fastBodyFingerprint,
} from "../../lib/f402_hierarchy_hash.ts";
import { estimatePlayersShallowBytes } from "../../lib/f402_hierarchy_memory.ts";
import { packCaptureEnvelope } from "../../lib/f402_hierarchy_pack.ts";
import {
  flushCaptureLog,
  logCaptureEvent,
} from "../../lib/f402_hierarchy_redact_log.ts";
import { withTrace } from "../../lib/f402_hierarchy_trace.ts";
import { createF402ReplayTransport } from "../../lib/f402_replay_transport.ts";
import { describeListAgentsByAgentProbeResponse } from "../../lib/f402_list_agents_by_agent.ts";

const REPO_ROOT = Bun.fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}/tests/fixtures`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    file: { type: "string", short: "f" },
    out: { type: "string", short: "o" },
    "zstd-out": { type: "string" },
    stdin: { type: "boolean" },
    "dry-run": { type: "boolean" },
    fetch: { type: "boolean" },
    "agent-id": { type: "string" },
    "agent-type": { type: "string" },
    profile: { type: "string" },
    cookie: { type: "string" },
    bust: { type: "string", default: "1.0.280" },
    "players-mode": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`f402_hierarchy_probe — PLAYERS_MODE=${PLAYERS_MODE}
  fixtures: ${FIXTURES_DIR}

  --file, -f       Input JSON envelope path
  --stdin          Read envelope from stdin
  --out, -o        Write filtered JSON (default stdout)
  --zstd-out       Write Bun.zstdCompress packed envelope
  --dry-run        Print redacted request fields only (with --fetch)
  --fetch          POST getListAgenstByAgent (needs --agent-id, --agent-type, cookie)
  --players-mode   Override F402_PLAYERS_MODE for this run
  --bust           Manager bundle version for audit drift
  DEBUG_TRACE=1    Print Bun.inspect.table step timings
`);
  process.exit(0);
}

const mode = values["players-mode"]
  ? readPlayersMode(values["players-mode"])
  : PLAYERS_MODE;

async function readInputBytes(): Promise<Uint8Array<ArrayBuffer>> {
  if (values.stdin) {
    return new Uint8Array(await Bun.stdin.arrayBuffer());
  }
  const filePath = values.file ?? positionals[0];
  if (filePath === undefined) {
    throw new Error("Provide --file, --stdin, or --fetch");
  }
  return new Uint8Array(await Bun.file(filePath).arrayBuffer());
}

async function writeOutputs(
  envelope: Awaited<ReturnType<typeof filterHierarchyJsonStream>>,
  outJson: string,
): Promise<void> {
  if (values.out) await Bun.write(values.out, outJson);
  else if (values["zstd-out"] === undefined) await Bun.stdout.write(outJson);
  if (values["zstd-out"]) {
    const packed = await packCaptureEnvelope(envelope);
    await Bun.write(values["zstd-out"], packed);
  }
}

async function runPipeline(): Promise<void> {
  await withTrace("hierarchy_probe", async (trace) => {
    const traceId = trace.id;

    if (values.fetch) {
      trace.step("build_request");
      const agentId =
        values["agent-id"]?.trim() ?? Bun.env.F402_AGENT_ID?.trim() ?? "";
      const agentType = values["agent-type"]?.trim() ?? "M";
      if (agentId === "") {
        throw new Error("--fetch requires --agent-id or F402_AGENT_ID");
      }
      const body = buildHierarchyFormBody(
        { agentID: agentId, agentType },
        MANAGER_RRO,
      );
      const url = `${PROBE_HOST}/cloud/api/Manager/getListAgenstByAgent`;
      if (values["dry-run"]) {
        logCaptureEvent(CAPTURE_LOG_PATH, {
          kind: "hierarchy_dry_run",
          traceId,
          url,
          fields: Object.fromEntries(body),
          playersMode: mode,
        });
        console.log(
          JSON.stringify(
            { url, body: Object.fromEntries(body), mode },
            null,
            2,
          ),
        );
        return;
      }
      trace.step("fetch");
      const transport = await createF402ReplayTransport({
        profileDir: values.profile ?? Bun.env.F402_WEBVIEW_PROFILE,
      });
      let res: Response;
      try {
        res = await transport.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
          },
          body: body.toString(),
          redirect: "manual",
        });
      } finally {
        await transport.close();
      }
      if (res.status === 401 || res.redirected) {
        throw new Error("session expired — re-auth required");
      }
      if (!res.ok) throw new Error(`hierarchy ${res.status}`);
      const rawBody = res.body;
      if (rawBody === null) throw new Error("empty response body");
      trace.step("filter_stream");
      const envelope = await filterHierarchyJsonStream(rawBody, mode);
      try {
        assertNoAgentLoginCollisions(envelope.GENERAL);
      } catch (e) {
        if (AUDIT_DB_PATH !== "") {
          recordQuarantine(
            AUDIT_DB_PATH,
            "agent_login_collision",
            String(e),
            agentId,
          );
        }
        throw e;
      }
      const mem = estimatePlayersShallowBytes(envelope.PLAYERS);
      if (mem !== null && mode === "full") {
        logCaptureEvent(CAPTURE_LOG_PATH, {
          kind: "players_memory_estimate",
          traceId,
          ...mem,
        });
      }
      const maxLevel = maxGeneralLevel(envelope.GENERAL);
      if (maxLevel !== null && maxLevel > 12) {
        logCaptureEvent(CAPTURE_LOG_PATH, {
          kind: "level_drift",
          traceId,
          maxLevel,
          count: generalRowsAboveLevel(envelope.GENERAL, 12).length,
        });
      }
      trace.step("hash");
      const duplicate = isDuplicateEnvelope(envelope);
      const hash = await envelopeTreeHash(envelope);
      const outJson = `${JSON.stringify(envelope)}\n`;
      const hint = describeListAgentsByAgentProbeResponse(outJson);
      if (hint !== null) {
        console.error(`${hint} playersMode=${mode} duplicate=${duplicate}`);
      }
      if (Bun.env.DEBUG_TRACE === "1") {
        console.error(new HierarchyEnvelopeView(envelope));
      }
      if (AUDIT_DB_PATH !== "") {
        await recordBustDrift(AUDIT_DB_PATH, values.bust ?? "1.0.280");
        recordProbeLog(AUDIT_DB_PATH, {
          ts: Date.now(),
          host: PROBE_HOST,
          agentId,
          agentType,
          bust: values.bust ?? "1.0.280",
          status: res.status,
          bytes: outJson.length,
          playersMode: mode,
          hash,
          traceId,
        });
      }
      logCaptureEvent(CAPTURE_LOG_PATH, {
        kind: "hierarchy_fetch_ok",
        traceId,
        status: res.status,
        playersMode: mode,
        hash,
        duplicate,
      });
      trace.step("write");
      await writeOutputs(envelope, outJson);
      return;
    }

    trace.step("read_input");
    const bytes = await readInputBytes();
    const fp = await fastBodyFingerprint(bytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    trace.step("filter_stream");
    const envelope = await filterHierarchyJsonStream(stream, mode);
    assertNoAgentLoginCollisions(envelope.GENERAL);
    const duplicate = isDuplicateEnvelope(envelope);
    const hash = await envelopeTreeHash(envelope);
    const outJson = `${JSON.stringify(envelope)}\n`;
    logCaptureEvent(CAPTURE_LOG_PATH, {
      kind: "hierarchy_filter_ok",
      traceId,
      playersMode: mode,
      fastFingerprint: fp,
      hash,
      duplicate,
    });
    const hint = describeListAgentsByAgentProbeResponse(outJson);
    if (hint !== null) console.error(hint);
    trace.step("write");
    await writeOutputs(envelope, outJson);
  });
}

if (import.meta.path === Bun.main) {
  try {
    await runPipeline();
  } finally {
    flushCaptureLog();
    closeAuditDb();
  }
}
