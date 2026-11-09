#!/usr/bin/env bun
/**
 * @file scripts/registry_check.ts
 * @description Show which registry each name resolves to and whether it is reachable.
 *
 *   bun run registry:check
 *   bun run registry:check sportsdesk-ops --json
 *
 * `bun info` against an unpublished private name reports a 404, and against a stopped private registry
 * a bare ConnectionRefused. This says which registry was tried and whether it is up.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  type NpmrcConfig,
  parseNpmrc,
  registryFor,
  registryHost,
} from "../lib/npm_registry.ts";

const HELP = `
registry:check — resolve registries and probe reachability

Options:
  --json          Machine-readable output
  -h, --help      This text

Examples:
  bun run registry:check
  bun run registry:check sportsdesk-ops
  bun run registry:check --json

Reads the project .npmrc, then ~/.npmrc, then uses the package argument.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2));
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

function merge(base: NpmrcConfig, over: NpmrcConfig): NpmrcConfig {
  return {
    defaultRegistry: over.defaultRegistry ?? base.defaultRegistry,
    scopes: { ...base.scopes, ...over.scopes },
  };
}

const projectNpmrc = Bun.file(".npmrc");
const homeNpmrc = Bun.file(join(homedir(), ".npmrc"));
const config = merge(
  (await projectNpmrc.exists())
    ? parseNpmrc(await projectNpmrc.text())
    : { defaultRegistry: null, scopes: {} },
  (await homeNpmrc.exists())
    ? parseNpmrc(await homeNpmrc.text())
    : { defaultRegistry: null, scopes: {} },
);

const target = parsed.positionals[0] ?? "sportsdesk-ops";
const registry = registryFor(target, config);

async function probe(
  url: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { ok: response.ok, status: response.status, error: null };
  } catch (error) {
    return { ok: false, status: null, error: (error as Error).message };
  }
}

const scopes = Object.entries(config.scopes).map(([scope, url]) => ({
  scope,
  url,
}));
const result = {
  package: target,
  registry,
  host: registry === null ? null : registryHost(registry),
  probe: registry === null ? null : await probe(registry),
  defaultRegistry: config.defaultRegistry,
  scopes,
};

if (hasFlag(parsed, "--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`package:  ${target}`);
  console.log(`registry: ${result.host ?? "(none configured)"}`);
  if (result.probe !== null) {
    console.log(
      result.probe.ok
        ? `probe:    reachable (HTTP ${result.probe.status})`
        : `probe:    unreachable${result.probe.error === null ? ` (HTTP ${result.probe.status})` : `: ${result.probe.error}`}`,
    );
  }
  for (const { scope, url } of scopes)
    console.log(`scope:    ${scope} -> ${registryHost(url)}`);
}

// An unreachable registry is the actionable case; a 404 from a reachable one means "not published".
if (result.probe !== null && !result.probe.ok && result.probe.error !== null)
  process.exit(1);
