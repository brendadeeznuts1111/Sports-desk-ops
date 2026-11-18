/** Negative fixture — must not be scanned in production allowlist runs. */
import { createProfileQueryHostRunner } from "../../../lib/profile_code_mode_host.ts";

export const noop = createProfileQueryHostRunner;
