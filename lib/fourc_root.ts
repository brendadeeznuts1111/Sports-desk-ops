import { existsSync } from "node:fs";
import { join } from "node:path";

/** Probe corpus root: `FOURC_ROOT` → first existing `~/4c-odds-intergration` or `$CODE_ROOT/...`. */
export function resolveFourcRoot(
  environment: NodeJS.ProcessEnv = Bun.env,
): string {
  const explicit = environment.FOURC_ROOT?.trim();
  if (explicit) return explicit;
  const home = environment.HOME ?? "";
  const codeRoot = environment.CODE_ROOT?.trim() || join(home, "code");
  const candidates = [
    join(home, "4c-odds-intergration"),
    join(codeRoot, "4c-odds-intergration"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}
