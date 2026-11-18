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

const ROOT = join(import.meta.dir, "..");
const PUBLISHER = "packages/sportsdesk-ops/src/bin/xml-parse.ts";
const PARSER = "bin/xml-parse.ts";

const USAGE = `xml — canonical XML-ingest snapshot

Usage:
  ./bin/dx xml status [--json]        Is the snapshot published, and is the running daemon serving
                                      it? Prints the artifact state, then the daemon's answer on
                                      /api/xml-odds/soa (200 / 502 / 404 / unreachable).
                                      Exit 0 only when the panel would render rows.
  ./bin/dx xml ingest [flags...]      Run the shipped publisher. Key flags:
                                        --dry-run        parse + plan, no writes at all
                                        --url <feed>     live feed URL (or SPORTSDESK_XML_FEED_URL)
                                        --cursor <v>     resume cursor (default 0)
                                        --capacity <n>   SoA capacity (default 65536)
                                        --allow-empty    accept a zero-row frame
                                      A successful publish prints the same status afterwards.
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

function daemonOrigin(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const explicit =
    env.SPORTSDESK_DAEMON_URL?.trim() || env.SPORTSDESK_ORIGIN?.trim() || "";
  const port = env.PORT?.trim() || "4020";
  return (explicit !== "" ? explicit : `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    "",
  );
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
  origin: string,
  fetchImpl: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<Response> = (url, init) => fetch(url, init),
  timeoutMs = 5_000,
): Promise<EndpointProbe> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${XML_ODDS_SOA_PATH}`, {
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
      daemonOrigin(env),
      options.daemonFetch ?? ((url, init) => fetch(url, init)),
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

async function main(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "status": {
      const unknown = rest.filter((a) => a !== "--json");
      if (unknown.length > 0) {
        process.stderr.write(
          `xml status: unknown flag ${unknown[0]}\n${USAGE}\n`,
        );
        return 2;
      }
      return statusCommand({ json: rest.includes("--json") });
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
