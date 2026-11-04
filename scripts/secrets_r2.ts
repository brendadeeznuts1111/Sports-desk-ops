#!/usr/bin/env bun
/**
 * @file secrets_r2.ts
 * @description Seed/inspect the `sportsdesk-ops` Bun.secrets service used as the
 * fallback for R2 credentials when `.env` is an unmounted FIFO.
 *
 *   bun scripts/secrets_r2.ts seed        # read existing macOS Keychain items
 *   bun scripts/secrets_r2.ts status      # names present, never values
 *   bun scripts/secrets_r2.ts delete      # remove the entries
 *
 * Values are read from the macOS Keychain (`security`) without being printed, then
 * stored with Bun.secrets. A missing BLOB_API_TOKEN is reported and skipped; it is
 * not derivable from the R2 access keys.
 */

import { R2_SECRETS_SERVICE, R2_SECRET_NAMES } from "../lib/r2_s3_client.ts";

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

async function seed(): Promise<void> {
  const values = new Map<string, string>();
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const) {
    const value = (await keychainValue(name)) ?? Bun.env[name] ?? null;
    if (value !== null) values.set(name, value);
  }
  values.set(
    "CLOUDFLARE_ACCOUNT_ID",
    Bun.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
  );
  // The generic R2_BUCKET keychain item belongs to other projects; seed the
  // reports bucket unless the operator explicitly names a different one.
  values.set("R2_BUCKET_NAME", Bun.env.R2_BUCKET_NAME ?? DEFAULT_BUCKET);
  const blobToken =
    Bun.env.BLOB_API_TOKEN ?? (await keychainValue("BLOB_API_TOKEN"));
  if (blobToken !== null) values.set("BLOB_API_TOKEN", blobToken);

  for (const name of R2_SECRET_NAMES) {
    const value = values.get(name);
    if (value === undefined) {
      console.error(`secrets_r2: ${name} not found (skipped)`);
      continue;
    }
    await Bun.secrets.set({
      service: R2_SECRETS_SERVICE,
      name,
      value,
    });
    console.log(`secrets_r2: stored ${name}`);
  }
}

async function status(): Promise<void> {
  for (const name of R2_SECRET_NAMES) {
    const value = await Bun.secrets.get({
      service: R2_SECRETS_SERVICE,
      name,
    });
    console.log(`${name}: ${value === null ? "missing" : "present"}`);
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

const action = (process.argv[2] ?? "status") as Action;
if (action === "seed") await seed();
else if (action === "status") await status();
else if (action === "delete") await remove();
else usage();
