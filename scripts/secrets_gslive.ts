#!/usr/bin/env bun
/** Store/read/delete the GSLive manager session in the OS keychain via `Bun.secrets`.
 *
 *  This retires the old "plaintext GSID in .env only" default: the capture and report CLIs
 *  resolve the session keychain-first (see `resolveManagerSession` in `fetch-bet-tally.ts`) and
 *  fall back to the environment for CI/operator use.
 *
 *  Values are never printed and never accepted on argv: `set` reads the cookie from stdin so it
 *  composes with a password manager, e.g.
 *    op read "op://Private/sportsdesk-gslive/GSID" | bun run secrets:gslive set
 */

import { parseCliArgs, printHelp, wantsHelp } from "../lib/cli_args.ts";
import type { BunSecretSetOptions } from "../types/bun-api";
import { secretSetOptions } from "../lib/r2_s3_client.ts";
import { LEGACY_SECRETS_SERVICE } from "../lib/secrets.ts";
import { GSID_SECRET, GSID_SECRET_LEGACY } from "./fetch-bet-tally.ts";
import { secrets, stdin } from "bun";

const HELP = `
secrets:gslive — store the GSLive manager session (GSID) in the OS keychain

Usage:
  bun run secrets:gslive status
  <session-source> | bun run secrets:gslive set
  bun run secrets:gslive delete

Options:
  -h, --help        This text

The value is read from stdin, never from argv and never printed. Keychain entries
(read/delete in this order, first hit wins):
  service ${GSID_SECRET.service}
  name    ${GSID_SECRET.name}  (canonical)
  service ${GSID_SECRET_LEGACY.service}
  name    ${GSID_SECRET_LEGACY.name}  (legacy)
  service ${LEGACY_SECRETS_SERVICE}
  name    ${GSID_SECRET.name}  (legacy)

Examples:
  printf '%s' "$GSID" | bun run secrets:gslive set
  op read "op://Private/sportsdesk-gslive/GSID" | bun run secrets:gslive set
  bun run secrets:gslive status
`.trim();

/** Minimal injectable keychain surface so tests never touch the real OS store. */
export interface SecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: BunSecretSetOptions): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export function defaultSecretStore(): SecretStore {
  return {
    get: (options) => secrets.get(options),
    set: async (options) => {
      await secrets.set(options);
    },
    delete: (options) => secrets.delete(options),
  };
}

export interface SecretStatus {
  /** Service the session was found in; canonical when absent. */
  readonly service: string;
  readonly name: string;
  readonly present: boolean;
}

/**
 * Every service the GSID has lived under: canonical first, then the two legacy
 * names. Reads and deletes walk the whole list so a stale copy cannot resurface
 * (audit Finding 4), and status reports the service it actually found.
 */
export const GSID_SERVICES = [
  GSID_SECRET,
  GSID_SECRET_LEGACY,
  { service: LEGACY_SECRETS_SERVICE, name: GSID_SECRET.name },
] as const;

/** Report whether a session is stored. Never returns or logs the value. */
export async function gsliveSecretStatus(
  store: SecretStore = defaultSecretStore(),
): Promise<SecretStatus> {
  for (const entry of GSID_SERVICES) {
    try {
      const value = (await store.get(entry))?.trim() ?? "";
      if (value !== "") {
        return { service: entry.service, name: entry.name, present: true };
      }
    } catch {
      // A locked/unavailable keychain means "not readable here"; keep looking.
    }
  }
  return {
    service: GSID_SECRET.service,
    name: GSID_SECRET.name,
    present: false,
  };
}

/** Store a trimmed session; an empty value is refused, not silently written. */
export async function setGsliveSecret(
  value: string,
  store: SecretStore = defaultSecretStore(),
): Promise<"stored" | "empty"> {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  await store.set(
    secretSetOptions(GSID_SECRET.service, GSID_SECRET.name, trimmed),
  );
  return "stored";
}

/** Remove every GSID entry; returns how many services actually held one. */
export async function deleteGsliveSecret(
  store: SecretStore = defaultSecretStore(),
): Promise<number> {
  let removed = 0;
  for (const entry of GSID_SERVICES) {
    try {
      if (await store.delete(entry)) removed += 1;
    } catch {
      // A locked/unavailable keychain is not a deletion failure by itself.
    }
  }
  return removed;
}

/** Read one stdin line; the value is not echoed, stored in shell history, or put on argv. */
async function readStdInValue(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: [] });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const command = parsed.positionals[0] ?? "status";

  switch (command) {
    case "status": {
      const status = await gsliveSecretStatus();
      console.log(`service: ${status.service}`);
      console.log(`name: ${status.name}`);
      console.log(`session: ${status.present ? "stored" : "absent"}`);
      if (!status.present) {
        console.error("  printf '%s' \"$GSID\" | bun run secrets:gslive set");
      }
      break;
    }
    case "set": {
      if (process.stdin.isTTY) {
        console.error(
          "secrets:gslive: pipe the session on stdin; it is not accepted on argv.",
        );
        console.error("  printf '%s' \"$GSID\" | bun run secrets:gslive set");
        process.exit(2);
      }
      const result = await setGsliveSecret(await readStdInValue());
      if (result === "empty") {
        console.error("secrets:gslive: stdin was empty; nothing stored.");
        process.exit(2);
      }
      console.error(
        `secrets:gslive: stored the session under service ${GSID_SECRET.service}, name ${GSID_SECRET.name}`,
      );
      break;
    }
    case "login": {
      const { ensureGsid } = await import("../lib/gslive_auto_session.ts");
      const gsid = await ensureGsid();
      console.error(
        `secrets:gslive: GSLive session ready (GSID ${gsid === "" ? "missing" : "verified"}, value not printed)`,
      );
      break;
    }
    case "delete": {
      const removed = await deleteGsliveSecret();
      console.error(
        `secrets:gslive: removed ${removed} GSLive session entr${removed === 1 ? "y" : "ies"} from ${GSID_SERVICES.map((entry) => entry.service).join(", ")}`,
      );
      break;
    }
    default: {
      console.error(
        `secrets:gslive: unknown command "${command}" (status|set|delete).`,
      );
      console.error("  bun run secrets:gslive status");
      process.exit(2);
    }
  }
}

if (import.meta.main) await main();
