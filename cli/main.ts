/**
 * @file main.ts
 * @description Small entrypoint adapter for the ticket CLI: a testable argument parser and a
 * spawn wrapper. The full command implementation stays in `sportsdesk_ticket_cli.ts`.
 */
import { parseLangArg, type LangArg } from "./i18n.ts";
import { parseConfidenceArg, type Confidence } from "./info.ts";
import { loadCapture } from "./html.ts";

export { loadCapture };

export interface TicketArgs {
  readonly lang: LangArg;
  readonly currencyScale: number;
  readonly requireConfidence?: Confidence | undefined;
  readonly file?: string | undefined;
  readonly analyze: boolean;
  readonly captureInfo: boolean;
  readonly positionals: readonly string[];
}

/** Parse the flags shared by the confidence/i18n surface. Throws on invalid values. */
export function parseArgs(argv: readonly string[]): TicketArgs {
  let lang: LangArg = "ENGLISH";
  let currencyScale = 1;
  let requireConfidence: Confidence | undefined;
  let file: string | undefined;
  let analyze = false;
  let captureInfo = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--lang=")) {
      const value = parseLangArg(arg.slice("--lang=".length));
      if (value === null) throw new Error(`--lang: unknown value ${arg}`);
      lang = value;
    } else if (arg.startsWith("--currency-scale=")) {
      const value = Number(arg.slice("--currency-scale=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--currency-scale must be a positive number");
      }
      currencyScale = value;
    } else if (arg.startsWith("--require-confidence=")) {
      const value = parseConfidenceArg(
        arg.slice("--require-confidence=".length),
      );
      if (value === null) {
        throw new Error("--require-confidence: one of none|low|medium|high");
      }
      requireConfidence = value;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (arg === "--analyze") {
      analyze = true;
    } else if (arg === "--capture-info") {
      captureInfo = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    lang,
    currencyScale,
    requireConfidence,
    file,
    analyze,
    captureInfo,
    positionals,
  };
}

/** Spawn the canonical CLI so this module can be used as an entrypoint without duplicating it. */
export async function main(argv = Bun.argv.slice(2)): Promise<never> {
  const cli = new URL("./sportsdesk_ticket_cli.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, cli, ...argv], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
