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
import type { BunSecretSetOptions } from "../types/bun-api.ts";
import { secretSetOptions } from "../lib/r2_s3_client.ts";
import {
  GANCHROW_SESSION_SECRET,
  GSID_SECRET,
  GSID_SECRET_LEGACY,
  GSID_SECRET_PRE_RENAME,
} from "./fetch-bet-tally.ts";

const HELP = `
secrets:gslive — GSLive manager session in the OS keychain

Usage:
  bun run secrets:gslive <command>

Commands:
  status    Show whether GSLIVE_SESSION_ID is stored (never prints the value)
  set       Read a raw GSID from stdin and store it (manual browser cookie)
  set-gate  Read ganchrowSessionId (x-gs-session) from stdin into keychain
  login     Auto-mint a fresh GSID from keychain GSLIVE_USERNAME/GSLIVE_PASSWORD
  delete    Remove the stored session

Options:
  -h, --help        This text

Keychain (service ${GSID_SECRET.service}):
  GSLIVE_SESSION_ID       manager GSID cookie (name ${GSID_SECRET.name})
  GSLIVE_GANCHROW_SESSION x-gs-session / ganchrowSessionId (${GANCHROW_SESSION_SECRET.name})
  GSLIVE_USERNAME         sign-in for login command
  GSLIVE_PASSWORD         sign-in for login command

Examples:
  bun run gslive:status
  bun run gslive:login
  printf '%s' "$GSLIVE_SESSION_ID" | bun run secrets:gslive set
  printf '%s' "$GANCHROW_SESSION" | bun run secrets:gslive set-gate
  op read "op://Private/sportsdesk-gslive/GSID" | bun run secrets:gslive set
`.trim();

/** Minimal injectable keychain surface so tests never touch the real OS store. */
export interface SecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: BunSecretSetOptions): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export function defaultSecretStore(): SecretStore {
  return {
    get: (options) => Bun.secrets.get(options),
    set: async (options) => {
      await Bun.secrets.set(options);
    },
    delete: (options) => Bun.secrets.delete(options),
  };
}

export interface SecretStatus {
  readonly service: string;
  readonly name: string;
  readonly present: boolean;
}

export interface GsliveDualSecretStatus {
  readonly gsid: SecretStatus;
  readonly ganchrowGate: SecretStatus;
}

/** Report whether a session is stored. Never returns or logs the value. */
export async function gsliveDualSecretStatus(
  store: SecretStore = defaultSecretStore(),
): Promise<GsliveDualSecretStatus> {
  const gsid = await gsliveSecretStatus(store);
  let gatePresent = false;
  try {
    const value = await store.get(GANCHROW_SESSION_SECRET);
    gatePresent = (value ?? "").trim() !== "";
  } catch {
    gatePresent = false;
  }
  return {
    gsid,
    ganchrowGate: {
      service: GANCHROW_SESSION_SECRET.service,
      name: GANCHROW_SESSION_SECRET.name,
      present: gatePresent,
    },
  };
}

export async function gsliveSecretStatus(
  store: SecretStore = defaultSecretStore(),
): Promise<SecretStatus> {
  let present = false;
  try {
    const value =
      (await store.get(GSID_SECRET)) ??
      (await store.get(GSID_SECRET_PRE_RENAME)) ??
      (await store.get(GSID_SECRET_LEGACY));
    present = (value ?? "").trim() !== "";
  } catch {
    // A locked/unavailable keychain means "not readable here", not "stored".
    present = false;
  }
  return { service: GSID_SECRET.service, name: GSID_SECRET.name, present };
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

export async function setGsliveGanchrowGate(
  value: string,
  store: SecretStore = defaultSecretStore(),
): Promise<"stored" | "empty"> {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  await store.set(
    secretSetOptions(
      GANCHROW_SESSION_SECRET.service,
      GANCHROW_SESSION_SECRET.name,
      trimmed,
    ),
  );
  return "stored";
}

export async function deleteGsliveSecret(
  store: SecretStore = defaultSecretStore(),
): Promise<boolean> {
  // Remove the pre-rename entry too, or a deleted session would still resolve through the fallback.
  const removed = await store.delete(GSID_SECRET);
  const removedPreRename = await store.delete(GSID_SECRET_PRE_RENAME);
  const removedGate = await store.delete(GANCHROW_SESSION_SECRET);
  return removed || removedPreRename || removedGate;
}

/** Read one stdin line; the value is not echoed, stored in shell history, or put on argv. */
async function readStdInValue(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: [] });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const command = parsed.positionals[0] ?? "status";

switch (command) {
  case "status": {
    const status = await gsliveDualSecretStatus();
    console.log(`service: ${status.gsid.service}`);
    console.log(`gsid: ${status.gsid.name} ${status.gsid.present ? "stored" : "absent"}`);
    console.log(
      `ganchrow gate: ${status.ganchrowGate.name} ${status.ganchrowGate.present ? "stored" : "absent"}`,
    );
    if (!status.gsid.present) {
      console.error("  printf '%s' \"$GSID\" | bun run secrets:gslive set");
    }
    if (!status.ganchrowGate.present) {
      console.error(
        "  printf '%s' \"$GANCHROW_SESSION\" | bun run secrets:gslive set-gate",
      );
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
  case "set-gate": {
    if (process.stdin.isTTY) {
      console.error(
        "secrets:gslive: pipe ganchrowSessionId on stdin; it is not accepted on argv.",
      );
      console.error(
        "  printf '%s' \"$GANCHROW_SESSION\" | bun run secrets:gslive set-gate",
      );
      process.exit(2);
    }
    const result = await setGsliveGanchrowGate(await readStdInValue());
    if (result === "empty") {
      console.error("secrets:gslive: stdin was empty; nothing stored.");
      process.exit(2);
    }
    console.error(
      `secrets:gslive: stored x-gs-session under service ${GANCHROW_SESSION_SECRET.service}, name ${GANCHROW_SESSION_SECRET.name}`,
    );
    break;
  }
  case "login": {
    const { ensureGsid } = await import("../lib/gslive_auto_session.ts");
    const gsid = await ensureGsid();
    console.error(
      `secrets:gslive: GSLive session ready (GSLIVE_SESSION_ID ${gsid === "" ? "missing" : "verified"}, value not printed)`,
    );
    break;
  }
  case "delete": {
    await deleteGsliveSecret();
    console.error(`secrets:gslive: removed the ${GSID_SECRET.service} session`);
    break;
  }
  default: {
    console.error(
      `secrets:gslive: unknown command "${command}" (status|set|set-gate|login|delete).`,
    );
    console.error("  bun run secrets:gslive status");
    process.exit(2);
  }
}
