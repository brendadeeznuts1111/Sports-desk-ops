/** Single resolver for the retained F402 bet-ticker JSONL (Mode 6 / live positions). */
import { existsSync } from "node:fs";

/** Operator machine default; override with `F402_BETS_JSONL` on VPS or CI. */
export const F402_BETS_JSONL_OPERATOR_DEFAULT =
  "/Users/nolarose/4c-odds-intergration/probes/out13/f402-bets.jsonl";

export interface ResolveF402BetsJsonlPathOptions {
  readonly cliValue?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly operatorDefault?: string;
}

export function resolveF402BetsJsonlPath(
  options: ResolveF402BetsJsonlPathOptions = {},
): string {
  const env = options.environment ?? Bun.env;
  const exists = options.exists ?? existsSync;
  const operatorDefault =
    options.operatorDefault ?? F402_BETS_JSONL_OPERATOR_DEFAULT;
  const cli = options.cliValue?.trim();
  const fromCli = cli !== undefined && cli !== "" ? cli : undefined;
  const fromEnv = env.F402_BETS_JSONL?.trim();
  const resolved =
    fromCli ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined) ??
    operatorDefault;

  if (!exists(resolved)) {
    throw new Error(
      `f402-bets.jsonl not found at ${resolved}. ` +
        `Set F402_BETS_JSONL or pass --bets. ` +
        `The known-good location is ${operatorDefault}.`,
    );
  }
  return resolved;
}
