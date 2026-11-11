#!/usr/bin/env bun
/**
 * Fantasy402 desk catalog — validate, diff, refresh fixtures.
 */

import { resolve } from "node:path";
import {
  buildCatalogDiffReport,
  renderCatalogDiffMarkdown,
} from "../catalog/fantasy402_sport_catalog_diff.ts";
import {
  applyForcedCollisionRegistry,
  buildProposedCatalogRefresh,
  CatalogProbeFetchError,
  computeCatalogProvenance,
  loadFantasy402SportCatalogFromFile,
  loadFantasy402SportCatalogFromProbe,
  normalizeCatalogCounts,
  type CatalogValidationResult,
  validateFantasy402SportCatalog,
} from "../catalog/fantasy402_sport_catalog.ts";

type GlobalOpts = {
  json: boolean;
};

function printRootHelp(): void {
  console.log(`Fantasy402 sport catalog (subSport lanes + period menus)

Commands:
  validate   Structural parse + period rules + collision registry SSOT
  diff       Fixture vs probe — markdown table (PR-ready) or --json
  refresh    Recompute header counts; collisions require human merge

Global:
  -h, --help        Help
  --json            Machine-readable stdout

Examples:
  bun run catalog validate --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json
  bun run catalog diff --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json --probe ./probe.json
  bun run catalog refresh --from ./probe.json --propose --out ./fixture.proposed.json
`);
}

function printValidateHelp(): void {
  console.log(`catalog validate

Options:
  --fixture <path>   Catalog JSON (required)

Exit: 0 ok · 1 blocking · 2 parse/read error
`);
}

function printDiffHelp(): void {
  console.log(`catalog diff

Options:
  --fixture <path>      Baseline JSON (required)
  --probe <path|url>    Probe capture (required)
  --timeout <ms>        URL probe timeout (default: 5000)

Validates fixture + probe (strict header) before diffing.

Exit:
  0 match · 2 structural · 3 collision (observed tree)
  4 empty-name quality (unexpected empty or filled structural path)
  5 probe I/O / timeout · 6 fixture or probe failed validation

Examples:
  bun run catalog diff --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json --probe ./live.json
`);
}

function printRefreshHelp(): void {
  console.log(`catalog refresh

Options:
  --from <path>                          Source JSON (required)
  --out <path>                           Destination (default: --from)
  --propose                              Write proposedCollisions[]; do NOT mutate collisions
  --force --i-know-this-is-a-domain-decision
                                         Overwrite collisions[] from tree (dangerous)

Default (no flags): normalize sportCount/subSportCount/sportPeriodCount only.

Examples:
  bun run catalog refresh --from ./probe.json --propose --out ./fixture.proposed.json
  bun run catalog refresh --from ./probe.json --force --i-know-this-is-a-domain-decision
`);
}

function parseGlobal(args: string[]): { rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = { json: false };
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--json") opts.json = true;
    else rest.push(a);
  }
  return { rest, opts };
}

function requireFlag(
  args: string[],
  flag: string,
  example: string,
): string | null {
  const i = args.indexOf(flag);
  if (i === -1 || !args[i + 1]) {
    console.error(`Error: missing ${flag}`);
    console.error(`  ${example}`);
    return null;
  }
  return args[i + 1]!;
}

function printValidationFailure(
  label: string,
  result: CatalogValidationResult,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({ label, validation: result }, null, 2));
  } else {
    console.error(`${label}: validation failed`);
    for (const issue of result.issues) {
      console.error(JSON.stringify(issue));
    }
  }
}

async function cmdValidate(args: string[], opts: GlobalOpts): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printValidateHelp();
    return 0;
  }
  const fixturePath = requireFlag(
    args,
    "--fixture",
    "bun run catalog validate --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
  );
  if (!fixturePath) return 2;

  try {
    const catalog = await loadFantasy402SportCatalogFromFile(
      resolve(fixturePath),
    );
    const provenance = computeCatalogProvenance(catalog);
    const result = validateFantasy402SportCatalog(catalog);

    if (opts.json) {
      console.log(JSON.stringify({ ...result, provenance }, null, 2));
    } else {
      console.log(
        result.ok ? "validate: ok" : "validate: FAILED (blocking issues)",
      );
      console.log(
        `digests: subSport=${provenance.digests.subSportTreeSha256Hex.slice(0, 12)}… collisionObs=${provenance.digests.observedCollisionSetSha256Hex.slice(0, 12)}…`,
      );
      console.log(
        `metrics (info): expectedEmpty=${provenance.metrics.emptyNames.expectedEmptySubSportNameCount} unexpectedEmpty=${provenance.metrics.emptyNames.unexpectedEmptySubSportNameCount} sports=${result.computed.sportCount}`,
      );
      for (const issue of result.issues) {
        console.log(JSON.stringify(issue));
      }
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

async function cmdDiff(args: string[], opts: GlobalOpts): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printDiffHelp();
    return 0;
  }
  const fixturePath = requireFlag(
    args,
    "--fixture",
    "bun run catalog diff --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json --probe ./probe.json",
  );
  const probeSource = requireFlag(
    args,
    "--probe",
    "bun run catalog diff --fixture tests/fixtures/fantasy402-sport-catalog-2026-10-21.json --probe ./probe.json",
  );
  if (!fixturePath || !probeSource) return 5;

  let timeoutMs = 5_000;
  const tIdx = args.indexOf("--timeout");
  if (tIdx !== -1 && args[tIdx + 1]) {
    timeoutMs = Number.parseInt(args[tIdx + 1]!, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(
        "Error: --timeout must be a positive integer (milliseconds)",
      );
      return 5;
    }
  }

  try {
    const fixture = await loadFantasy402SportCatalogFromFile(
      resolve(fixturePath),
    );
    const fixtureVal = validateFantasy402SportCatalog(fixture, {
      strictHeader: true,
    });
    if (!fixtureVal.ok) {
      printValidationFailure("fixture", fixtureVal, opts.json);
      return 6;
    }

    const probe = await loadFantasy402SportCatalogFromProbe(probeSource, {
      timeoutMs,
    });
    const probeVal = validateFantasy402SportCatalog(probe, {
      strictHeader: true,
    });
    if (!probeVal.ok) {
      printValidationFailure("probe", probeVal, opts.json);
      return 6;
    }

    const report = buildCatalogDiffReport(fixture, probe);

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderCatalogDiffMarkdown(report));
    }
    return report.exitCode;
  } catch (e) {
    if (e instanceof CatalogProbeFetchError) {
      console.error(e.message);
      return 5;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 5;
  }
}

async function cmdRefresh(args: string[], opts: GlobalOpts): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printRefreshHelp();
    return 0;
  }
  const fromPath = requireFlag(
    args,
    "--from",
    "bun run catalog refresh --from ./probe.json",
  );
  if (!fromPath) return 2;

  const propose = args.includes("--propose");
  const force =
    args.includes("--force") &&
    args.includes("--i-know-this-is-a-domain-decision");

  if (args.includes("--force") && !force) {
    console.error(
      "Error: --force requires --i-know-this-is-a-domain-decision (collisions[] is a domain decision, not auto-merge)",
    );
    return 2;
  }

  let outPath = resolve(fromPath);
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outPath = resolve(args[outIdx + 1]!);
  } else if (propose) {
    outPath = `${resolve(fromPath).replace(/\.json$/i, "")}.proposed.json`;
  }

  try {
    const loaded = await loadFantasy402SportCatalogFromFile(resolve(fromPath));
    let payload: unknown;
    let catalogForDigest;

    if (force) {
      catalogForDigest = applyForcedCollisionRegistry(loaded);
      payload = catalogForDigest;
      if (!opts.json) {
        console.warn(
          "WARN: collisions[] overwritten from tree — domain decision logged in commit message",
        );
      }
    } else if (propose) {
      const proposed = buildProposedCatalogRefresh(loaded);
      catalogForDigest = proposed;
      payload = proposed;
    } else {
      catalogForDigest = normalizeCatalogCounts(loaded);
      payload = catalogForDigest;
    }

    const provenance = computeCatalogProvenance(catalogForDigest);
    await Bun.write(outPath, `${JSON.stringify(payload, null, 2)}\n`);

    if (opts.json) {
      console.log(JSON.stringify({ outPath, provenance }, null, 2));
    } else {
      console.log(`refresh: wrote ${outPath}`);
      console.log(
        `subSportTreeSha256: ${provenance.digests.subSportTreeSha256Hex}`,
      );
      console.log(
        `observedCollisionSetSha256: ${provenance.digests.observedCollisionSetSha256Hex}`,
      );
      if (propose && "proposedCollisions" in (payload as object)) {
        console.log(
          "proposedCollisions: written for human review (collisions[] unchanged)",
        );
      }
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printRootHelp();
    return 0;
  }

  const { rest, opts } = parseGlobal(argv);
  const [command, ...cmdArgs] = rest;
  if (!command) {
    printRootHelp();
    return 0;
  }

  switch (command) {
    case "validate":
      return cmdValidate(cmdArgs, opts);
    case "diff":
      return cmdDiff(cmdArgs, opts);
    case "refresh":
      return cmdRefresh(cmdArgs, opts);
    default:
      console.error(`Unknown command: ${command}`);
      printRootHelp();
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
