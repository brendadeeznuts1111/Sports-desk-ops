/**
 * Profile tools on the insecure host `CodeModeRunner` — dev/parity only.
 * Production: {@link runGuestCell} via `lib/code_mode_profile.ts`.
 */
import { CodeModeRunner } from "./code_mode.ts";
import {
  getProfileArgsSchema,
  getSummaryArgsSchema,
  queryProfilesArgsSchema,
} from "./profile_query_schema.ts";
import {
  getProfileTool,
  getSummaryTool,
  queryProfilesTool,
} from "./profile_query_tools.ts";

/** Set to `1` to allow {@link createProfileQueryHostRunner} and CLI `--realm profile-host`. */
export const PROFILE_CODE_MODE_HOST_ENV =
  "SPORTSDESK_PROFILE_CODE_MODE_HOST" as const;

export function isProfileCodeModeHostAllowed(): boolean {
  return process.env[PROFILE_CODE_MODE_HOST_ENV] === "1";
}

export function assertProfileCodeModeHostAllowed(context: string): void {
  if (isProfileCodeModeHostAllowed()) return;
  throw new Error(
    `${context}: profile Code Mode host realm is dev/parity only. ` +
      `Use executeProfileCodeMode(code, "guest") or \`bun run code-mode:profile\`. ` +
      `Local insecure host: ${PROFILE_CODE_MODE_HOST_ENV}=1.`,
  );
}

export const PROFILE_CODE_MODE_TOOL_NAMES = [
  "query_profiles",
  "get_profile",
  "get_profile_summary",
] as const;

/**
 * Attaches profile tools to an existing runner. **Ungated** — tests use
 * `tests/helpers/attachProfileHostTools.ts` (importable only from `*.test.ts` per AST allowlist).
 */
export function registerProfileCodeModeHostTools(runner: CodeModeRunner): void {
  runner.registerTool({
    name: "query_profiles",
    description:
      "Sortable customer profile rows by clv, vol, or sharp. Sentinel rows are omitted unless includeSentinels is exactly true; row.sentinel reflects profile sentinel state, not sort value.",
    parameters: queryProfilesArgsSchema,
    handler: async (args) =>
      queryProfilesTool.execute(queryProfilesArgsSchema.parse(args)),
  });

  runner.registerTool({
    name: "get_profile",
    description:
      "Returns one frozen profile snapshot by id (flags, vol, clv, sharp).",
    parameters: getProfileArgsSchema,
    handler: async (args) =>
      getProfileTool.execute(getProfileArgsSchema.parse(args)),
  });

  runner.registerTool({
    name: "get_profile_summary",
    description: "Aggregate desk snapshot deltas (deltaVol, deltaNet).",
    parameters: getSummaryArgsSchema,
    handler: async () => getSummaryTool.execute({}),
  });
}

/** Gated — {@link assertProfileCodeModeHostAllowed} must pass (env var). */
export function createProfileQueryHostRunner(): CodeModeRunner {
  assertProfileCodeModeHostAllowed("createProfileQueryHostRunner");
  const runner = new CodeModeRunner();
  registerProfileCodeModeHostTools(runner);
  return runner;
}

/**
 * @deprecated Use {@link registerProfileCodeModeHostTools}. Removal: first release after
 * **2026-06-01** (target sportsdesk-ops **v0.2.0**) — https://github.com/bw496915-cmyk/Sports-desk-ops/issues/227
 */
export function registerProfileQueryCodeModeTools(
  runner: CodeModeRunner,
): void {
  registerProfileCodeModeHostTools(runner);
}
