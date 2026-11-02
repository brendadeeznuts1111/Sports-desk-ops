/**
 * Wire boundary for `POST …/getListAgenstByAgent` JSON bodies (parse once, trust inside).
 */

import { parseListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { assertListAgentsTopLevelKeys } from "./f402_list_agents_envelope_strict.ts";

export function parseListAgentsByAgentWireText(
  bodyText: string,
): ListAgentsByAgentEnvelope {
  const trimmed = bodyText.trim();
  if (trimmed === "") {
    throw new Error(
      "getListAgenstByAgent empty body — same failure mode as silent ajax error",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const msg = String(e);
    const truncated =
      /unterminated string|unexpected end|Unexpected EOF/i.test(msg) ||
      (!trimmed.endsWith("}") && !trimmed.endsWith("]"));
    throw new Error(
      truncated
        ? `getListAgenstByAgent body is truncated or incomplete JSON (${msg}) — re-copy full DevTools response`
        : `getListAgenstByAgent body is not JSON: ${msg}`,
      { cause: e },
    );
  }
  assertListAgentsTopLevelKeys(parsed);
  return parseListAgentsByAgentEnvelope(parsed);
}
