/**
 * Sole allowlisted importer of profile host registrars — use this instead of importing
 * `registerProfileCodeModeHostTools` in new tests.
 */
import { CodeModeRunner } from "../../lib/code_mode.ts";
import { registerProfileCodeModeHostTools } from "../../lib/profile_code_mode_host.ts";

export function attachProfileHostTools(
  runner: CodeModeRunner = new CodeModeRunner(),
): CodeModeRunner {
  registerProfileCodeModeHostTools(runner);
  return runner;
}
