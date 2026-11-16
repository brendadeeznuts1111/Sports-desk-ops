/**
 * Profile Code Mode entrypoints — guest (production) vs host (dev-only, env-gated).
 */
import type { CodeModeOptions } from "./code_mode.ts";
import { runGuestCell, type RunGuestCellOptions } from "./quickjs_code_mode.ts";
import {
  createProfileQueryHostRunner,
  PROFILE_CODE_MODE_TOOL_NAMES,
} from "./profile_code_mode_host.ts";

/** Production default; library API does not rely on the desk CLI default. */
export const PROFILE_CODE_MODE_DEFAULT_REALM = "guest" as const;

export type ProfileCodeModeRealm = "guest" | "host";

export const PROFILE_CODE_MODE_GUEST_TOOLS = [
  "query_profiles",
  "get_profile",
  "get_profile_summary",
] as const;

export function createProfileCodeModeGuestCell(
  code: string,
  options?: RunGuestCellOptions,
): Promise<unknown> {
  return runGuestCell(code, options);
}

/**
 * Dev / parity only — host cells see Bun. Prefer {@link createProfileCodeModeGuestCell}.
 */
export async function executeProfileCodeModeHost(
  code: string,
  options: CodeModeOptions = {},
) {
  const runner = createProfileQueryHostRunner();
  return runner.execute(code, options);
}

export async function executeProfileCodeMode(
  code: string,
  realm: ProfileCodeModeRealm = PROFILE_CODE_MODE_DEFAULT_REALM,
  options: CodeModeOptions & RunGuestCellOptions = {},
): Promise<unknown> {
  if (realm === "guest") {
    return createProfileCodeModeGuestCell(code, options);
  }
  const result = await executeProfileCodeModeHost(code, options);
  if (!result.success) {
    throw new Error(result.error?.message ?? "profile host cell failed");
  }
  return result.result;
}

export { PROFILE_CODE_MODE_TOOL_NAMES };
