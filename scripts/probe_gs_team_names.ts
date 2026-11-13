#!/usr/bin/env bun
/**
 * @file probe_gs_team_names.ts
 * @description Collect team names from the Ganchrow Diffusion feed, derive candidate team-logo
 * filenames, HEAD-check them on the Manager console CDN, and optionally merge the verified ones
 * into `data/unified_team_registry.json`.
 *
 * The SDK (`@ganchrowsci/gs-sdk`) publishes `Team { name, nick_name? }` — it carries no logo URL.
 * Its only contribution here is the name/nickname pair for the `<City>-<Nickname>.png` spelling.
 *
 * Requires `GS_DIFFUSION_URL`, `GS_DIFFUSION_USERNAME`, `GS_DIFFUSION_PASSWORD` (see
 * `lib/secret_manifest.ts`). Fails closed with instructions when they are absent.
 *
 * Usage:
 *   bun run scripts/probe_gs_team_names.ts                  # report candidates
 *   bun run scripts/probe_gs_team_names.ts --seconds 20     # longer feed sample
 *   bun run scripts/probe_gs_team_names.ts --apply          # merge CDN-verified logos
 */

import { resolve } from "node:path";
import { GsSdk, ValidKinds } from "@ganchrowsci/gs-sdk";

import {
  collectFeedTeams,
  deriveLogoFileCandidates,
  type FeedTeam,
} from "../lib/gs_feed_team_logos.ts";
import { mergeLogoFilesIntoRegistryFile } from "../lib/unified_team_registry_scoreboard.ts";

const LOGO_ORIGIN = "https://cdn.fastassets.io/images/team-logos/";
const PRO_LEAGUES = ["NFL", "NBA", "NHL"] as const;

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

async function headOk(file: string): Promise<boolean> {
  const url = `${LOGO_ORIGIN}${encodeURIComponent(file)}`;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (
      response.ok &&
      (response.headers.get("content-type") ?? "").startsWith("image/")
    ) {
      return true;
    }
    if (response.status === 405 || response.status === 501) {
      const get = await fetch(url, {
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(10_000),
      });
      return (
        (get.status === 200 || get.status === 206) &&
        (get.headers.get("content-type") ?? "").startsWith("image/")
      );
    }
    return false;
  } catch {
    return false;
  }
}

const argv = Bun.argv.slice(2);
const apply = argv.includes("--apply");
const seconds = Math.max(
  1,
  Math.min(120, Number(flagValue(argv, "--seconds") ?? "10")),
);
const registryPath = resolve(
  process.cwd(),
  flagValue(argv, "--registry") ?? "data/unified_team_registry.json",
);

const url = (Bun.env.GS_DIFFUSION_URL ?? "").trim();
const username = (Bun.env.GS_DIFFUSION_USERNAME ?? "").trim();
const password = (Bun.env.GS_DIFFUSION_PASSWORD ?? "").trim();
if (url === "" || username === "" || password === "") {
  console.error(
    [
      "probe_gs_team_names: the Diffusion feed is not configured; nothing was sampled.",
      "Set GS_DIFFUSION_URL, GS_DIFFUSION_USERNAME and GS_DIFFUSION_PASSWORD",
      "(register them via `bun run secrets:env set` / the keychain; see lib/secret_manifest.ts).",
      "The vendor supplies the Diffusion URL; it is not recorded in this repository.",
    ].join("\n"),
  );
  process.exit(2);
}

const sdk = new GsSdk({ url, username, password });
const payloads: unknown[] = [];
try {
  await sdk.connect();
} catch (error) {
  // The SDK validates options and protocol inside connect(), and its stack trace is not useful
  // to an operator; report the reason and stop before any sampling.
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `probe_gs_team_names: could not connect to the Diffusion feed (${message.slice(0, 200)})`,
  );
  process.exit(1);
}
try {
  sdk.addEventListener(ValidKinds.events, (payload: unknown) => {
    payloads.push(payload);
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, seconds * 1_000));
} finally {
  sdk.close();
}

const teams: FeedTeam[] = collectFeedTeams(payloads);
const candidates = deriveLogoFileCandidates(teams);
const verified: string[] = [];
const queue = [...candidates];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (;;) {
      const file = queue.shift();
      if (file === undefined) return;
      if (await headOk(file)) verified.push(file);
    }
  }),
);
verified.sort();

let merge: ReturnType<typeof mergeLogoFilesIntoRegistryFile> | null = null;
if (apply && verified.length > 0) {
  merge = mergeLogoFilesIntoRegistryFile(registryPath, verified, {
    leagues: [...PRO_LEAGUES],
  });
  const formatted = Bun.spawnSync(["bun", "fmt", registryPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (formatted.exitCode !== 0) {
    console.error("probe_gs_team_names: bun fmt failed on", registryPath);
    process.exit(1);
  }
}

console.log(
  JSON.stringify(
    {
      sampledSeconds: seconds,
      events: payloads.length,
      teams: teams.length,
      candidates: candidates.length,
      verified: verified.length,
      verifiedFiles: verified,
      apply,
      merge:
        merge === null
          ? null
          : {
              updated: merge.updated,
              aliased: merge.aliased,
              total: merge.total,
            },
    },
    null,
    2,
  ),
);
