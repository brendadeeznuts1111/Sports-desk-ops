#!/usr/bin/env bun
/**
 * @file scripts/secrets_env.ts
 * @description Hand keychain-backed credentials to a program as environment variables, without
 * writing them to a file or to your shell.
 *
 *   ./bin/dx exec --with pages -- wrangler pages deploy dist   # inject a group (or names)
 *   bun run secrets:env status [--with r2,pages] [--json]      # where each value would come from
 *   printf %s "$TOKEN" | bun run secrets:env set CLOUDFLARE_API_TOKEN
 *
 * Precedence is environment first, keychain second (see lib/secret_env.ts). Only the names you ask
 * for are injected, and only into the child process. Output names sources, never values.
 */

import { parseArgs } from "node:util";

import {
  CANONICAL_SECRETS_SERVICE,
  readSecretWithSource,
} from "../lib/secrets.ts";
import {
  childEnv,
  describeSource,
  expandSecretSelection,
  manifestStatus,
  resolveSecretEnv,
  SECRET_ENV_GROUPS,
  SECRET_ENV_NAMES,
} from "../lib/secret_env.ts";
import { secretSetOptions } from "../lib/r2_s3_client.ts";
import { SECRET_MANIFEST } from "../lib/secret_manifest.ts";
import { UsageError } from "../lib/usage_error.ts";

const USAGE = `usage:
  secrets_env.ts exec --with <group|NAME>[,…] [--] <program> [args…]
  secrets_env.ts status [--with <group|NAME>[,…] | --all] [--json]
  secrets_env.ts set <NAME>          (value on stdin, never argv)

groups: ${Object.keys(SECRET_ENV_GROUPS).join(", ")}`;

function withTokens(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(","));
}

async function status(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      with: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.all) {
    if (values.with !== undefined) {
      throw new UsageError("--all lists the whole manifest; drop --with");
    }
    const rows = await manifestStatus();
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      const width = Math.max(...rows.map((row) => row.name.length));
      const groupWidth = Math.max(
        ...rows.map((row) => row.groups.join("+").length),
      );
      for (const row of rows) {
        const inject = row.injectable ? "inject" : "no-inject";
        console.log(
          `${row.name.padEnd(width)}  ${row.groups.join("+").padEnd(groupWidth)}  ${inject.padEnd(9)}  ${describeSource(row.source)}`,
        );
      }
    }
    return rows.some((row) => row.source.kind === "missing") ? 1 : 0;
  }
  const names =
    values.with === undefined
      ? [...SECRET_ENV_NAMES]
      : expandSecretSelection(withTokens(values.with));
  const { report } = await resolveSecretEnv(names);
  if (values.json) {
    console.log(
      JSON.stringify(
        report.map((row) => ({ name: row.name, source: row.source })),
        null,
        2,
      ),
    );
  } else {
    const width = Math.max(...report.map((row) => row.name.length));
    for (const row of report) {
      console.log(`${row.name.padEnd(width)}  ${describeSource(row.source)}`);
    }
  }
  return report.some((row) => row.source.kind === "missing") ? 1 : 0;
}

async function exec(argv: readonly string[]): Promise<number> {
  const dashdash = argv.indexOf("--");
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
  let command = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  const { values, positionals } = parseArgs({
    args: [...own],
    options: { with: { type: "string", multiple: true } },
    strict: true,
    allowPositionals: true,
  });
  if (dashdash === -1) command = positionals;
  if (command.length === 0) throw new UsageError("no program to run");
  const tokens = withTokens(values.with);
  if (tokens.length === 0) {
    throw new UsageError(
      "--with is required: name the group or variables to inject",
    );
  }
  const names = expandSecretSelection(tokens);
  const resolved = await resolveSecretEnv(names);
  const missing = resolved.report.filter(
    (row) => row.source.kind === "missing",
  );
  if (missing.length > 0) {
    console.error(
      `secrets: not found in the environment or the keychain: ${missing.map((row) => row.name).join(", ")}`,
    );
    console.error(
      `  store one with: printf %s "$VALUE" | bun run secrets:env set <NAME>  (service ${CANONICAL_SECRETS_SERVICE})`,
    );
    return 2;
  }
  const summary = resolved.report
    .map((row) => `${row.name}←${describeSource(row.source)}`)
    .join(", ");
  console.error(`secrets: injecting ${summary}`);
  const child = Bun.spawn(command, {
    env: childEnv(Bun.env, resolved),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

async function set(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || rest.length > 0) {
    throw new UsageError("set takes exactly one NAME");
  }
  if (!SECRET_ENV_NAMES.includes(name)) {
    throw new UsageError(
      `unknown secret "${name}" (names: ${SECRET_ENV_NAMES.join(", ")})`,
    );
  }
  if (process.stdin.isTTY === true) {
    throw new UsageError(
      'pipe the value on stdin (printf %s "$VALUE" | …); a typed value would land in shell history or the screen',
    );
  }
  const value = (await Bun.stdin.text()).trim();
  const entry =
    SECRET_MANIFEST.find((secret) => secret.envName === name)?.keychainName ??
    name;
  await Bun.secrets.set(
    secretSetOptions(CANONICAL_SECRETS_SERVICE, entry, value),
  );
  const check = await readSecretWithSource(entry);
  console.log(
    `${name}: stored in ${CANONICAL_SECRETS_SERVICE} (read back ${check === null ? "FAILED" : "ok"}, ${new TextEncoder().encode(value).byteLength} bytes)`,
  );
  return check === null ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "exec":
        return await exec(rest);
      case "status":
        return await status(rest);
      case "set":
        return await set(rest);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`secrets:env: ${error.message}\n${USAGE}`);
      return 2;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      console.error(`secrets:env: ${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
