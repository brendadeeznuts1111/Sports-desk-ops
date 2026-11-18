#!/usr/bin/env bun
/**
 * @file scripts/secrets_f402.ts
 * @description Keep the F402 credentials in the OS credential store instead of `.env`.
 *
 * Values are never printed and never accepted on argv. `set` writes the canonical service
 * (`com.bookdeskops.sportsdesk`); reads are canonical-first with the legacy `sportsdesk-ops`
 * service as a read-only fallback. `delete` removes both services so a stale legacy copy cannot
 * resurface after a rotation; `migrate` never writes the legacy service.
 *
 * `set` reads the password from stdin, so it composes with a password manager:
 * `op read ... | bun run secrets:f402 set --agent-id 118`.
 *
 * Exit codes and the `--json` schema are documented in HELP below and in
 * docs/runbooks/f402_session_refresh.md; both are a stable contract.
 */

import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  F402KeychainUnavailable,
  F402SecretError,
  deleteF402Secret,
  migrateLegacyF402Secrets,
  probeSecretsBackend,
  readF402SecretStrict,
  writeF402Secret,
  type MigrationResult,
} from "../lib/f402_secret_store.ts";
import {
  F402_SESSION_SECRET_NAME,
  F402SessionStoreConfigError,
  resolveF402SessionStore,
  type F402SessionStoreKind,
} from "../lib/f402_session.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
} from "../lib/secrets.ts";

/**
 * @deprecated The legacy service name, kept for back-compat. New code reads through
 * `lib/secrets.ts` (canonical first, then legacy); nothing writes here any more.
 */
export const SECRETS_SERVICE = LEGACY_SECRETS_SERVICE;

const SERVICES = [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE] as const;

/** Stable exit codes for every command. */
export const SECRETS_F402_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  keychainUnavailable: 3,
  secretBackend: 4,
  absent: 5,
} as const;

/** @deprecated Use {@link SECRETS_F402_EXIT}. */
export const EXIT_KEYCHAIN_UNAVAILABLE = SECRETS_F402_EXIT.keychainUnavailable;
/** @deprecated Use {@link SECRETS_F402_EXIT}. */
export const EXIT_SECRET_BACKEND = SECRETS_F402_EXIT.secretBackend;

/** `schema` field of every `--json` document; bump the suffix on a breaking change. */
export const SECRETS_F402_JSON_SCHEMA = "sportsdesk.secrets-f402.v1";

const HELP = `
secrets:f402 — store the F402 credentials in the OS credential store

Usage:
  bun run secrets:f402 status  [--json]
  <password-source> | bun run secrets:f402 set --agent-id <id> [--json]
  bun run secrets:f402 delete  [--json]
  bun run secrets:f402 migrate [--json]   # copy legacy entries to the canonical service
  bun run secrets:f402 probe   [--json]   # is there a working OS keychain here? (throwaway entry)

Options:
  --agent-id <id>   Manager agent id (not secret)
  --json            One JSON document on stdout (schema ${SECRETS_F402_JSON_SCHEMA}), nothing on stderr
  -h, --help        This text

Exit codes:
  0  ok (status: every entry present; probe: keychain works; migrate: finished)
  1  unexpected internal error
  2  usage or configuration error (unknown command, missing --agent-id, no stdin,
     invalid F402_SESSION_STORE)
  3  F402KeychainUnavailable (no Secret Service / D-Bus / libsecret, or the call timed out)
  4  F402SecretBackendError and its subclasses (access denied, interaction required,
     user canceled, invalid argument, platform error, unknown Bun code), or a refused delete
  5  status only: the keychain answered but at least one entry is absent

Examples:
  bun run secrets:f402 status
  op read "op://Private/f402/password" | bun run secrets:f402 set --agent-id 118
  bun run secrets:f402 migrate --json
  bun run secrets:f402 delete

Reads are canonical-first (${CANONICAL_SECRETS_SERVICE}) with the legacy
${LEGACY_SECRETS_SERVICE} service as a read-only fallback; set writes the canonical
service; delete removes both; migrate copies legacy to canonical, never overwrites a
canonical value, never writes legacy, and is safe to re-run. With
F402_SESSION_STORE=keychain the portal session is the "${F402_SESSION_SECRET_NAME}" entry in
the canonical service instead of a file. Capture login reads the store via
lib/f402_credentials_policy.ts (not F402_PASSWORD in env).
`.trim();

const SET_HINT =
  "  printf '%s\\n' \"$F402_PASSWORD\" | bun run secrets:f402 set --agent-id <id>";

type Command = "status" | "set" | "delete" | "migrate" | "probe";

/** The `error` member of a `--json` document. Every field is non-secret. */
export interface SecretsF402JsonError {
  readonly name: string;
  readonly kind: string | null;
  readonly code: string | null;
  readonly platformCode: number | null;
  readonly op: string | null;
  readonly service: string | null;
  readonly entry: string | null;
  readonly message: string;
}

class CliFailure extends Error {
  readonly exitCode: number;
  readonly json: SecretsF402JsonError;
  readonly hint: string | undefined;
  constructor(exitCode: number, json: SecretsF402JsonError, hint?: string) {
    super(json.message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
    this.json = json;
    this.hint = hint;
  }
}

function usageFailure(message: string, hint?: string): CliFailure {
  return new CliFailure(
    SECRETS_F402_EXIT.usage,
    {
      name: "F402SecretsUsageError",
      kind: null,
      code: null,
      platformCode: null,
      op: null,
      service: null,
      entry: null,
      message,
    },
    hint,
  );
}

/** Named store errors keep their non-secret message; anything else reports its name only. */
export function toCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof F402SecretError) {
    return new CliFailure(
      error instanceof F402KeychainUnavailable
        ? SECRETS_F402_EXIT.keychainUnavailable
        : SECRETS_F402_EXIT.secretBackend,
      {
        name: error.name,
        kind: error.kind,
        code: error.bunCode ?? null,
        platformCode: error.platformCode ?? null,
        op: error.op,
        service: error.service,
        entry: error.secretName,
        message: error.message,
      },
    );
  }
  if (error instanceof F402SessionStoreConfigError) {
    return new CliFailure(SECRETS_F402_EXIT.usage, {
      name: error.name,
      kind: null,
      code: null,
      platformCode: null,
      op: null,
      service: null,
      entry: null,
      message: error.message,
    });
  }
  const name = (error as { name?: unknown } | null)?.name;
  return new CliFailure(SECRETS_F402_EXIT.unexpected, {
    name: typeof name === "string" ? name : "Error",
    kind: null,
    code: null,
    platformCode: null,
    op: null,
    service: null,
    entry: null,
    message:
      "unexpected error (message withheld; it is not from the secret store)",
  });
}

interface Outcome {
  readonly exitCode: number;
  readonly data: Record<string, unknown>;
  /** Human lines for stdout. */
  readonly lines: readonly string[];
  /** Human lines for stderr. */
  readonly notes: readonly string[];
}

async function readLine(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
    if (chunks.join("").includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
}

export interface StatusEntry {
  readonly label: "agentId" | "password" | "session";
  readonly entry: string;
  readonly present: boolean;
  readonly service: string | null;
}

async function status(): Promise<Outcome> {
  const sessionStore: F402SessionStoreKind = resolveF402SessionStore();
  const wanted: [StatusEntry["label"], string][] = [
    ["agentId", F402_KEYCHAIN_NAMES.agentId],
    ["password", F402_KEYCHAIN_NAMES.password],
  ];
  if (sessionStore === "keychain") {
    wanted.push(["session", F402_SESSION_SECRET_NAME]);
  }
  const entries: StatusEntry[] = [];
  for (const [label, entry] of wanted) {
    const found = await readF402SecretStrict(entry);
    entries.push({
      label,
      entry,
      present: found !== null,
      service: found?.service ?? null,
    });
  }
  const absent = entries.filter((entry) => !entry.present).length;
  return {
    exitCode: absent === 0 ? SECRETS_F402_EXIT.ok : SECRETS_F402_EXIT.absent,
    data: { sessionStore, services: SERVICES, entries },
    lines: entries.map((entry) =>
      entry.present
        ? `${entry.label}: stored in ${entry.service}`
        : `${entry.label}: absent (checked ${SERVICES.join(", ")})`,
    ),
    notes: absent > 0 ? [SET_HINT] : [],
  };
}

async function store(agentId: string): Promise<Outcome> {
  if (agentId === "") {
    throw usageFailure("--agent-id is required", SET_HINT);
  }
  if (process.stdin.isTTY) {
    throw usageFailure(
      "pipe the password on stdin; it is not accepted on argv",
      SET_HINT,
    );
  }
  const password = await readLine();
  if (password === "") {
    throw usageFailure("stdin was empty; nothing stored", SET_HINT);
  }
  await writeF402Secret(F402_KEYCHAIN_NAMES.agentId, agentId);
  await writeF402Secret(F402_KEYCHAIN_NAMES.password, password);
  return {
    exitCode: SECRETS_F402_EXIT.ok,
    data: {
      service: CANONICAL_SECRETS_SERVICE,
      stored: [F402_KEYCHAIN_NAMES.agentId, F402_KEYCHAIN_NAMES.password],
    },
    lines: [],
    notes: [
      `secrets:f402: stored agent id and password under service ${CANONICAL_SECRETS_SERVICE}`,
    ],
  };
}

async function remove(): Promise<Outcome> {
  let removed = 0;
  let alreadyAbsent = 0;
  const failures: SecretsF402JsonError[] = [];
  for (const service of SERVICES) {
    for (const name of [
      F402_KEYCHAIN_NAMES.agentId,
      F402_KEYCHAIN_NAMES.password,
    ]) {
      try {
        if (await deleteF402Secret(service, name)) removed += 1;
        else alreadyAbsent += 1;
      } catch (error) {
        if (error instanceof F402KeychainUnavailable) throw error;
        // One refused delete must not stop the others; the stale entry may still be there.
        failures.push(toCliFailure(error).json);
      }
    }
  }
  return {
    exitCode:
      failures.length === 0
        ? SECRETS_F402_EXIT.ok
        : SECRETS_F402_EXIT.secretBackend,
    data: { services: SERVICES, removed, alreadyAbsent, failures },
    lines: [],
    notes: [
      `secrets:f402: removed ${removed}, already absent ${alreadyAbsent} F402 credential entr${
        removed + alreadyAbsent === 1 ? "y" : "ies"
      } from ${SERVICES.join(", ")}`,
      ...failures.map(
        (failure) =>
          `secrets:f402: delete failed — ${failure.name}: ${failure.message}`,
      ),
      ...(failures.length > 0
        ? [
            `secrets:f402: ${failures.length} keychain delete(s) failed; entries may still be present`,
          ]
        : []),
    ],
  };
}

async function migrate(): Promise<Outcome> {
  const results: readonly MigrationResult[] = await migrateLegacyF402Secrets([
    F402_KEYCHAIN_NAMES.agentId,
    F402_KEYCHAIN_NAMES.password,
  ]);
  return {
    exitCode: SECRETS_F402_EXIT.ok,
    data: {
      canonicalService: CANONICAL_SECRETS_SERVICE,
      legacyService: LEGACY_SECRETS_SERVICE,
      legacyWritten: false,
      results,
    },
    lines: results.map((result) => `${result.name}: ${result.outcome}`),
    notes: [
      `secrets:f402: legacy service ${LEGACY_SECRETS_SERVICE} was read only; nothing there was changed`,
    ],
  };
}

async function probe(): Promise<Outcome> {
  const result = await probeSecretsBackend();
  if (!result.available) throw result.error;
  const cleanup =
    result.cleanup.status === "failed"
      ? { status: "failed", error: toCliFailure(result.cleanup.error).json }
      : { status: result.cleanup.status, error: null };
  return {
    exitCode: SECRETS_F402_EXIT.ok,
    data: {
      available: true,
      platform: process.platform,
      service: result.service,
      cleanup,
    },
    lines: ["keychain: available (throwaway set/delete succeeded)"],
    notes:
      cleanup.error === null
        ? []
        : [
            `secrets:f402: throwaway entry ${result.service}/probe was not removed — ${cleanup.error.name}: ${cleanup.error.message}`,
          ],
  };
}

function emitJson(
  command: string,
  exitCode: number,
  body: Record<string, unknown>,
): void {
  process.stdout.write(
    `${JSON.stringify({
      schema: SECRETS_F402_JSON_SCHEMA,
      command,
      ok: exitCode === SECRETS_F402_EXIT.ok,
      exitCode,
      ...body,
    })}\n`,
  );
}

/** Run the CLI in-process; returns the exit code (tests inject a fake adapter). */
export async function runSecretsF402Cli(
  argv: readonly string[],
): Promise<number> {
  const parsed = parseCliArgs(argv, { valueFlags: ["--agent-id"] });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    return SECRETS_F402_EXIT.ok;
  }
  const json = hasFlag(parsed, "--json");
  const command = parsed.positionals[0] ?? "status";
  const run: Record<Command, () => Promise<Outcome>> = {
    status,
    set: () => store(flagValue(parsed, "--agent-id", "")),
    delete: remove,
    migrate,
    probe,
  };
  try {
    if (!Object.hasOwn(run, command)) {
      throw usageFailure(
        `unknown command "${command}" (status|set|delete|migrate|probe)`,
        "  bun run secrets:f402 status",
      );
    }
    const outcome = await run[command as Command]();
    if (json) {
      emitJson(command, outcome.exitCode, { ...outcome.data, error: null });
    } else {
      for (const line of outcome.lines) console.log(line);
      for (const note of outcome.notes) console.error(note);
    }
    return outcome.exitCode;
  } catch (error) {
    const failure = toCliFailure(error);
    if (json) {
      emitJson(command, failure.exitCode, { error: failure.json });
    } else {
      console.error(
        `secrets:f402: ${failure.json.name}: ${failure.json.message}`,
      );
      if (failure.hint !== undefined) console.error(failure.hint);
    }
    return failure.exitCode;
  }
}

if (import.meta.main) {
  process.exitCode = await runSecretsF402Cli(process.argv.slice(2));
}
