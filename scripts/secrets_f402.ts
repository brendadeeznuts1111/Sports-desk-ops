#!/usr/bin/env bun
/**
 * @file scripts/secrets_f402.ts
 * @description Keep the F402 credentials in the OS credential store instead of `.env`.
 *
 * Values are never printed and never accepted on argv. `set` writes the canonical service
 * (`com.bookdeskops.sportsdesk`); reads are canonical-first with the legacy `sportsdesk-ops`
 * service as a fallback, and `status` reports which service actually holds each entry.
 * `delete` removes both services so a stale legacy copy cannot resurface after a rotation.
 *
 * `set` reads the password from stdin, so it composes with a password manager:
 * `op read ... | bun run secrets:f402 set --agent-id 118`.
 */

import {
  flagValue,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  readSecretWithSource,
} from "../lib/secrets.ts";

/**
 * @deprecated The legacy service name, kept for back-compat. New code reads through
 * `lib/secrets.ts` (canonical first, then legacy); nothing writes here any more.
 */
export const SECRETS_SERVICE = LEGACY_SECRETS_SERVICE;

const SERVICES = [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE] as const;

const HELP = `
secrets:f402 — store the F402 credentials in the OS credential store

Usage:
  bun run secrets:f402 status
  <password-source> | bun run secrets:f402 set --agent-id <id>
  bun run secrets:f402 delete

Options:
  --agent-id <id>   Manager agent id (not secret)
  -h, --help        This text

Examples:
  bun run secrets:f402 status
  op read "op://Private/f402/password" | bun run secrets:f402 set --agent-id 118
  bun run secrets:f402 delete

Reads are canonical-first (${CANONICAL_SECRETS_SERVICE}) with the legacy
${LEGACY_SECRETS_SERVICE} service as a fallback; set writes the canonical service;
delete removes both. Capture login reads the store via lib/f402_credentials_policy.ts
(not F402_PASSWORD in env).
`.trim();

async function readLine(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

async function status(): Promise<void> {
  let absent = 0;
  for (const [label, name] of [
    ["agent id", F402_KEYCHAIN_NAMES.agentId],
    ["password", F402_KEYCHAIN_NAMES.password],
  ] as const) {
    const found = await readSecretWithSource(name);
    if (found === null) {
      absent += 1;
      console.log(`${label}: absent (checked ${SERVICES.join(", ")})`);
    } else {
      console.log(`${label}: stored in ${found.service}`);
    }
  }
  if (absent > 0) {
    console.error(
      "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
    );
  }
}

async function store(agentId: string): Promise<void> {
  if (agentId === "") {
    console.error("secrets:f402: --agent-id is required.");
    console.error(
      "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
    );
    process.exit(2);
  }
  if (process.stdin.isTTY) {
    console.error(
      "secrets:f402: pipe the password on stdin; it is not accepted on argv.",
    );
    console.error(
      "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
    );
    process.exit(2);
  }
  const password = await readLine();
  if (password === "") {
    console.error("secrets:f402: stdin was empty; nothing stored.");
    console.error(
      "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>",
    );
    process.exit(2);
  }
  await Bun.secrets.set({
    service: CANONICAL_SECRETS_SERVICE,
    name: F402_KEYCHAIN_NAMES.agentId,
    value: agentId,
    persist: "local",
  });
  await Bun.secrets.set({
    service: CANONICAL_SECRETS_SERVICE,
    name: F402_KEYCHAIN_NAMES.password,
    value: password,
    persist: "local",
  });
  console.error(
    `secrets:f402: stored agent id and password under service ${CANONICAL_SECRETS_SERVICE}`,
  );
}

async function remove(): Promise<void> {
  let removed = 0;
  for (const service of SERVICES) {
    for (const name of [
      F402_KEYCHAIN_NAMES.agentId,
      F402_KEYCHAIN_NAMES.password,
    ]) {
      try {
        const deleted = await Bun.secrets.delete({ service, name });
        if (deleted) removed += 1;
      } catch {
        // A locked or unavailable keychain is not a deletion failure by itself.
      }
    }
  }
  console.error(
    `secrets:f402: removed ${removed} F402 credential entr${removed === 1 ? "y" : "ies"} from ${SERVICES.join(", ")}`,
  );
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ["--agent-id"],
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const command = parsed.positionals[0] ?? "status";

  switch (command) {
    case "status":
      await status();
      break;
    case "set":
      await store(flagValue(parsed, "--agent-id", ""));
      break;
    case "delete":
      await remove();
      break;
    default:
      console.error(
        `secrets:f402: unknown command "${command}" (status|set|delete).`,
      );
      console.error("  bun run secrets:f402 status");
      process.exit(2);
  }
}

if (import.meta.main) await main();
