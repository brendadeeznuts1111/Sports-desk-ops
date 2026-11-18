#!/usr/bin/env bun
/**
 * @file scripts/xml_ingest_cli.ts
 * @description Operator CLI for the canonical XML-ingest snapshot (`sportsdesk-ops-reports`).
 *
 * Three subcommands, one per question the operator actually asks:
 *
 *   status   — is `manifests/xml-ingest/latest` published, and would `GET /api/xml-odds/soa`
 *              serve rows? Read through the credential-free public base, so it works anywhere.
 *   ingest   — run the shipped publisher (`packages/sportsdesk-ops/src/bin/xml-parse.ts`).
 *              `--dry-run` parses the live feed and plans the snapshot without writing anything.
 *   parse    — the repo's XML parser (`bin/xml-parse.ts`), for inspecting a local file.
 *
 * `ingest` forwards its arguments verbatim so there is exactly one implementation of the
 * publish path and one set of exit codes; this file never re-implements either.
 *
 * Run: ./bin/dx xml <status|ingest|parse> [flags...]
 *      bun run xml:status            bun run xml:ingest -- --dry-run
 */
import { join } from "node:path";
import { R2S3Client } from "../lib/r2_s3_client.ts";
import {
  PORTAL_TAXONOMY_MANIFEST_KEY,
  createPortalTaxonomyR2Client,
  publishPortalTaxonomyToR2,
} from "../src/lib/portal_taxonomy_r2_publish.ts";
import type { PortalTaxonomyEntry } from "../src/lib/portal_taxonomy_normalizer.ts";
import { XML_INGEST_SINK } from "../src/lib/xml_ingest_r2_publish.ts";

const ROOT = join(import.meta.dir, "..");
const PUBLISHER = "packages/sportsdesk-ops/src/bin/xml-parse.ts";
const PARSER = "bin/xml-parse.ts";

const USAGE = `xml — canonical XML-ingest snapshot

Usage:
  ./bin/dx xml status [--json] [--base <url>] [--path <path>]
                                      Is the snapshot published, and is the running daemon serving
                                      it? Prints the artifact state, then the daemon's answer on
                                      /api/xml-odds/soa (200 / 502 / 404 / unreachable).
                                      --base takes a URL (and keeps a path prefix such as
                                      http://127.0.0.1:4020/desk); --path probes another route.
                                      Exit 0 only when the panel would render rows.
  ./bin/dx xml ingest [flags...]      Run the shipped publisher. Key flags:
                                        --dry-run        parse + plan, no writes at all
                                        --url <feed>     live feed URL (or SPORTSDESK_XML_FEED_URL)
                                        --cursor <v>     resume cursor (default 0)
                                        --capacity <n>   SoA capacity (default 65536)
                                        --allow-empty    accept a zero-row frame
                                      A successful publish prints the same status afterwards.
  ./bin/dx xml taxonomy <table.json> [--dry-run]
                                      Publish the portal-taxonomy manifest that xml:ingest reads.
                                      The table is [{sport, subSport, denseCode6, aliases?}];
                                      codes come from the portal and are validated 1..63.
  ./bin/dx xml parse <file|-> [--tree|--xml] [--indent N]
                                      Parse XML locally as JSON or round-trip XML.
  ./bin/dx xml help                   This text.

Daemon origin: SPORTSDESK_DAEMON_URL, else SPORTSDESK_ORIGIN, else http://127.0.0.1:$PORT (4020).

A 502 from /api/xml-odds/soa means no snapshot is published: run \`xml status\` for the exact
reason, then \`xml ingest --dry-run\` to preview, then \`xml ingest\` to publish.`;

export interface StatusLine {
  readonly ok: boolean;
  readonly summary: string;
}

/** What the local daemon answers on `/api/xml-odds/soa`, independent of the R2 artifact. */
export interface EndpointProbe {
  readonly origin: string;
  readonly reachable: boolean;
  readonly status: number | null;
  readonly kind:
    "serving" | "artifact-missing" | "route-absent" | "unreachable" | "error";
  readonly detail: string;
}

export const XML_ODDS_SOA_PATH = "/api/xml-odds/soa";

function daemonOrigin(env: Readonly<Record<string, string | undefined>>): URL {
  const explicit =
    env.SPORTSDESK_DAEMON_URL?.trim() || env.SPORTSDESK_ORIGIN?.trim() || "";
  const port = env.PORT?.trim() || "4020";
  return new URL(explicit !== "" ? explicit : `http://127.0.0.1:${port}`);
}

/**
 * Resolve a probe path against a base that may itself carry a path prefix.
 *
 * `new URL("/api/x", "http://h/prefix")` answers `http://h/api/x` — an absolute path discards the
 * base prefix — so the leading slashes come off the path and the base is treated as a directory.
 * Both a `URL` and a string are accepted, and a base without a trailing slash is normalised.
 *
 * @example endpointUrl(new URL("http://h:1/desk"), "api/x") // http://h:1/desk/api/x
 */
export function endpointUrl(base: string | URL, path: string): URL {
  const resolved = new URL(base.toString());
  if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
  return new URL(path.replace(/^\/+/, ""), resolved);
}

/**
 * Ask the running daemon for the route.
 *
 * The three answers that matter to an operator are different failures: `404` means this build
 * predates the route (restart needed), `502` means the route works and the R2 snapshot is
 * missing (publish needed), `200` means the panel has rows. A connection error is reported as
 * unreachable rather than thrown, because "no daemon" is a normal state on a workstation.
 */
export async function probeDaemonEndpoint(
  base: string | URL,
  fetchImpl: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<Response> = (url, init) => fetch(url, init),
  timeoutMs = 5_000,
  path: string = XML_ODDS_SOA_PATH,
): Promise<EndpointProbe> {
  const target = endpointUrl(base, path);
  const origin = target.origin;
  let response: Response;
  try {
    response = await fetchImpl(target.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      origin,
      reachable: false,
      status: null,
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const text = await response.text().catch(() => "");
  if (response.status === 404) {
    return {
      origin,
      reachable: true,
      status: 404,
      kind: "route-absent",
      detail: "this daemon build predates the route — restart it",
    };
  }
  if (response.status === 200) {
    let rowCount: unknown;
    try {
      rowCount = (JSON.parse(text) as Record<string, unknown>)["rowCount"];
    } catch {
      rowCount = undefined;
    }
    return {
      origin,
      reachable: true,
      status: 200,
      kind: "serving",
      detail:
        typeof rowCount === "number" ? `${rowCount} row(s)` : "serving rows",
    };
  }
  let reason = `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body["error"] === "string") reason = body["error"];
  } catch {
    // Non-JSON body: the status alone is the reason.
  }
  return {
    origin,
    reachable: true,
    status: response.status,
    kind: response.status === 502 ? "artifact-missing" : "error",
    detail: reason,
  };
}

/** One line for a daemon probe, with the origin so a non-default port is obvious. */
export function describeProbe(probe: EndpointProbe): string {
  const host = probe.origin.replace(/^https?:\/\//, "");
  switch (probe.kind) {
    case "serving":
      return `daemon ${host} → 200 (${probe.detail})`;
    case "artifact-missing":
      return `daemon ${host} → 502 (route live, snapshot missing: ${probe.detail})`;
    case "route-absent":
      return `daemon ${host} → 404 (${probe.detail})`;
    case "unreachable":
      return `daemon ${host} → unreachable (${probe.detail})`;
    case "error":
      return `daemon ${host} → ${probe.status ?? "error"} (${probe.detail})`;
  }
}

/**
 * One line for an outcome from `readXmlOddsSoaFromR2`.
 *
 * `available: false` is the normal not-published state (the route answers 502), not a crash, so
 * the caller decides the exit code and this only renders the reason the route would return.
 */
export function describeStatus(outcome: ArtifactOutcome): StatusLine {
  if (outcome.available) {
    const { rowCount, watermarkCursor, generatedAt, basis } = outcome.payload;
    return {
      ok: true,
      summary: `published · ${rowCount} row(s) · watermark ${watermarkCursor} · ${generatedAt} · ${basis}`,
    };
  }
  return { ok: false, summary: `not published · ${outcome.reason}` };
}

function forward(script: string, args: readonly string[]): number {
  const result = Bun.spawnSync(
    [process.execPath, "run", join(ROOT, script), ...args],
    {
      cwd: ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
    },
  );
  return result.exitCode ?? 1;
}

export interface StatusOptions {
  readonly json: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Daemon base, as a string or a `URL`; may carry a path prefix (`http://h/desk`). */
  readonly base?: string | URL | undefined;
  /** Probe path override; defaults to `/api/xml-odds/soa`. */
  readonly path?: string | undefined;
  /** Injected for tests: the R2 artifact read (defaults to the route's own producer). */
  readonly readArtifact?: () => Promise<ArtifactOutcome>;
  /** Injected for tests: the daemon probe's fetch. */
  readonly daemonFetch?: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<Response>;
}

export type ArtifactOutcome =
  | {
      readonly available: true;
      readonly payload: {
        readonly rowCount: number;
        readonly watermarkCursor: string;
        readonly generatedAt: string;
        readonly basis: string;
      };
    }
  | { readonly available: false; readonly reason: string };

/** Both halves of "why is the panel empty": the artifact, and the running daemon. */
export async function statusCommand(options: StatusOptions): Promise<number> {
  const env = options.env ?? Bun.env;
  const readArtifact =
    options.readArtifact ??
    (async (): Promise<ArtifactOutcome> => {
      const { readXmlOddsSoaFromR2 } =
        await import("../services/sportsdesk_webview_server.ts");
      return readXmlOddsSoaFromR2();
    });
  const [outcome, probe] = await Promise.all([
    readArtifact(),
    probeDaemonEndpoint(
      options.base ?? daemonOrigin(env),
      options.daemonFetch ?? ((url, init) => fetch(url, init)),
      5_000,
      options.path,
    ),
  ]);
  const artifact = describeStatus(outcome);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ artifact: outcome, daemon: probe }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`xml-ingest: ${artifact.summary}\n`);
    process.stdout.write(`${describeProbe(probe)}\n`);
    if (artifact.ok && probe.kind !== "serving") {
      process.stdout.write(
        "the snapshot exists but this daemon is not serving it: restart with `bun run serve`\n",
      );
    }
  }

  // Exit 0 only when the panel would actually render rows; either half failing is actionable.
  return artifact.ok && probe.kind === "serving" ? 0 : 1;
}

/**
 * Publish the portal-taxonomy manifest from a JSON table.
 *
 * The dense codes come from the portal, so this command cannot derive them — it reads the table
 * (`[{sport, subSport, denseCode6, aliases?}]` or `{entries: [...]}`), validates it against the
 * 6-bit field, and CAS-publishes it to the key `xml:ingest` reads.
 */
export async function taxonomyCommand(
  filePath: string,
  options: { readonly dryRun: boolean } = { dryRun: false },
): Promise<number> {
  const raw = (await Bun.file(filePath).json()) as unknown;
  const entries = Array.isArray(raw)
    ? (raw as PortalTaxonomyEntry[])
    : Array.isArray((raw as { entries?: unknown })?.entries)
      ? (raw as { entries: PortalTaxonomyEntry[] }).entries
      : null;
  if (entries === null) {
    process.stderr.write(
      `xml taxonomy: ${filePath} must be an array of entries or {"entries": [...]}\n`,
    );
    return 2;
  }

  // A dry run needs no credentials: it validates and prints the plan.
  if (options.dryRun) {
    const plan = await publishPortalTaxonomyToR2({
      client: {
        write: async () => undefined,
        fetch: async () => new Response(null, { status: 200 }),
      },
      entries,
      prevManifestETag: "",
      nextGenerationU32: 1,
      dryRun: true,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          dry_run: true,
          entries: plan.entryCount,
          merkle_root_sha256: plan.merkleRootSha256,
          manifest_key: PORTAL_TAXONOMY_MANIFEST_KEY,
          generation_key: plan.generationKey,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const accessKeyId = Bun.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = Bun.env.R2_SECRET_ACCESS_KEY;
  const endpoint = Bun.env.R2_ENDPOINT;
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    process.stderr.write("ERR_CF_R2_CREDENTIALS_MISSING\n");
    return 65;
  }
  const s3 = R2S3Client.fromOptions({
    bucket: XML_INGEST_SINK.r2Bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    publicBase: endpoint,
  });

  let prevManifestETag = "";
  let nextGenerationU32 = 1;
  try {
    const etag = await s3.headEtag(PORTAL_TAXONOMY_MANIFEST_KEY);
    if (etag !== null && etag.trim() !== "") {
      prevManifestETag = etag;
      const current = JSON.parse(
        await s3.file(PORTAL_TAXONOMY_MANIFEST_KEY).text(),
      ) as { generation_u32?: number };
      nextGenerationU32 = ((current.generation_u32 ?? 0) >>> 0) + 1;
    }
  } catch {
    // Absent manifest: first publish, generation 1, If-None-Match: *.
  }

  const published = await publishPortalTaxonomyToR2({
    client: createPortalTaxonomyR2Client(s3),
    entries,
    prevManifestETag,
    nextGenerationU32,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        published: PORTAL_TAXONOMY_MANIFEST_KEY,
        entries: published.entryCount,
        generation_u32: nextGenerationU32,
        merkle_root_sha256: published.merkleRootSha256,
        r2_published_at_epoch_ms: published.r2PublishedAtEpochMs,
        generation_key: published.generationKey,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "status": {
      let base: string | undefined;
      let path: string | undefined;
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index]!;
        if (arg === "--json") continue;
        if (arg === "--base" || arg === "--path") {
          const value = rest[index + 1];
          if (value === undefined || value.startsWith("--")) {
            process.stderr.write(
              `xml status: ${arg} needs a value\n${USAGE}\n`,
            );
            return 2;
          }
          if (arg === "--base") base = value;
          else path = value;
          index += 1;
          continue;
        }
        process.stderr.write(`xml status: unknown flag ${arg}\n${USAGE}\n`);
        return 2;
      }
      try {
        return await statusCommand({
          json: rest.includes("--json"),
          ...(base === undefined ? {} : { base }),
          ...(path === undefined ? {} : { path }),
        });
      } catch (error) {
        // `new URL("not-a-url")` throws; a bad --base is a usage error, not a crash.
        process.stderr.write(
          `xml status: invalid base "${base}": ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        return 2;
      }
    }
    case "ingest": {
      const code = forward(PUBLISHER, rest);
      // Close the loop: a successful publish is only useful if the route now serves it.
      if (code === 0 && !rest.includes("--dry-run")) {
        process.stdout.write("\n");
        await statusCommand({ json: false });
      }
      return code;
    }
    case "taxonomy": {
      const file = rest.find((a) => !a.startsWith("--"));
      const unknown = rest.filter(
        (a) => a.startsWith("--") && a !== "--dry-run",
      );
      if (file === undefined || unknown.length > 0) {
        process.stderr.write(
          `${unknown.length > 0 ? `xml taxonomy: unknown flag ${unknown[0]}\n` : "xml taxonomy: needs a table file\n"}${USAGE}\n`,
        );
        return 2;
      }
      return taxonomyCommand(file, { dryRun: rest.includes("--dry-run") });
    }
    case "parse":
      return forward(PARSER, rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`xml: unknown subcommand "${sub}"\n${USAGE}\n`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
