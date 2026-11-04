#!/usr/bin/env bun
/**
 * @file secrets_r2.ts
 * @description Seed/inspect the canonical `com.bookdeskops.sportsdesk` Bun.secrets
 * service used as the R2/BLOB fallback when `.env` is an unmounted FIFO.
 *
 *   bun scripts/secrets_r2.ts seed        # migrate sportsdesk-ops + Keychain, generate gateway tokens
 *   bun scripts/secrets_r2.ts status      # names present, never values
 *   bun scripts/secrets_r2.ts delete      # remove canonical entries
 *
 * Values are read from the macOS Keychain (`security`) without being printed and
 * stored with persist: "local". Missing BLOB_API_TOKEN / BLOB_TICKET_SECRET are
 * generated as CSPRNG 32-byte hex values.
 */

import {
  assertSecretField,
  assertSecretValue,
  R2_SECRETS_LEGACY_SERVICE,
  R2_SECRETS_SERVICE,
  R2_SECRET_NAMES,
  secretSetOptions,
} from "../lib/r2_s3_client.ts";

const DEFAULT_ACCOUNT_ID = "7a470541a704caaf91e71efccc78fd36";
const DEFAULT_BUCKET = "sportsdesk-ops-reports";

type Action = "seed" | "status" | "delete";

function usage(): never {
  console.error("usage: bun scripts/secrets_r2.ts [seed|status|delete]");
  process.exit(2);
}

async function keychainValue(name: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-a", name, "-w"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [stdout, code] = await Promise.all([proc.stdout.text(), proc.exited]);
  return code === 0 && stdout.trim() !== "" ? stdout.trim() : null;
}

async function readService(
  service: string,
  name: string,
): Promise<string | null> {
  assertSecretField(service, "service");
  assertSecretField(name, "name");
  const value = await Bun.secrets.get({ service, name });
  assertSecretValue(value ?? "x");
  return value;
}

async function storedValue(name: string): Promise<string | null> {
  return (
    (await readService(R2_SECRETS_SERVICE, name)) ??
    (await readService(R2_SECRETS_LEGACY_SERVICE, name))
  );
}

function generatedToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "hex",
  );
}

async function seed(): Promise<void> {
  const defaults = new Map<string, string>();
  defaults.set(
    "CLOUDFLARE_ACCOUNT_ID",
    Bun.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
  );
  defaults.set("R2_BUCKET_NAME", Bun.env.R2_BUCKET_NAME ?? DEFAULT_BUCKET);

  for (const name of R2_SECRET_NAMES) {
    let value = (await storedValue(name)) ?? defaults.get(name) ?? null;
    if (
      value === null &&
      (name === "R2_ACCESS_KEY_ID" || name === "R2_SECRET_ACCESS_KEY")
    ) {
      value = (await keychainValue(name)) ?? Bun.env[name] ?? null;
    }
    if (
      value === null &&
      (name === "BLOB_API_TOKEN" || name === "BLOB_TICKET_SECRET")
    ) {
      value = generatedToken();
    }
    if (value === null) {
      console.error(`secrets_r2: ${name} not found (skipped)`);
      continue;
    }
    await Bun.secrets.set(secretSetOptions(R2_SECRETS_SERVICE, name, value));
    console.log(`secrets_r2: stored ${name} in ${R2_SECRETS_SERVICE}`);
  }
}

async function status(): Promise<void> {
  for (const name of R2_SECRET_NAMES) {
    const canonical = await Bun.secrets.get({
      service: R2_SECRETS_SERVICE,
      name,
    });
    const legacy = await Bun.secrets.get({
      service: R2_SECRETS_LEGACY_SERVICE,
      name,
    });
    console.log(
      `${name}: ${canonical === null ? (legacy === null ? "missing" : "legacy only") : "present"}`,
    );
  }
}

async function remove(): Promise<void> {
  for (const name of R2_SECRET_NAMES) {
    const deleted = await Bun.secrets.delete({
      service: R2_SECRETS_SERVICE,
      name,
    });
    console.log(`${name}: ${deleted ? "deleted" : "not found"}`);
  }
}

async function main(): Promise<void> {
  const action = (process.argv[2] ?? "status") as Action;
  if (action === "seed") await seed();
  else if (action === "status") await status();
  else if (action === "delete") await remove();
  else usage();
}

if (import.meta.main) await main();
