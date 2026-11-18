/**
 * @file lib/bun_reference_audit.ts
 * @description Orchestration for the bun.sh/reference audit: fetch the landing page, the module
 * indexes and the module sidebars, reconcile documented symbols against the pinned runtime, and
 * derive the machine-readable contract. Parsing/verdicts live in `bun_reference_tree.ts`; the
 * manifest schema lives in `bun_reference_contract.ts`.
 *
 * `fetchJson` is injectable, so tests run offline against fixture payloads. The compile-time probe
 * is a child process (skipped with `probe: false`) because `bun:bundle` cannot be inspected in-process.
 */
import { join } from "node:path";
import { bunRevisionComposite } from "./bun_runtime.ts";
import {
  contractSchema,
  negativeSelfTest,
  validateContractManifest,
  type ContractManifest,
} from "./bun_reference_contract.ts";
import {
  checkModuleGroups,
  colourContract,
  crossCheckModuleSources,
  explainMissing,
  fetchJson as defaultFetchJson,
  generatedFromClaim,
  type JoinedBadge,
  KNOWN_SECTION_KINDS,
  mergeIndexRows,
  type ModuleFailure,
  modulePathsFromLanding,
  modulePathsFromSidebar,
  parseIndex,
  parseLandingGroups,
  parseSidebarBadges,
  REFERENCE_INDEX_URL,
  type SidebarBadge,
  type Verdict,
  verdictOf,
} from "./bun_reference_tree.ts";

export type FetchJson = (url: string) => Promise<unknown>;

export interface ReferenceAuditOptions {
  readonly fetchJson?: FetchJson | undefined;
  /** Origin used to build module page URLs, e.g. `https://bun.sh`. */
  readonly origin?: string | undefined;
  /** Run the `bun:bundle` child probe (default true; tests pass false). */
  readonly probe?: boolean | undefined;
}

export interface SymbolRow {
  readonly module: string;
  readonly name: string;
  readonly kinds: string[];
  readonly summary: string;
  readonly present: boolean;
  readonly runtimeTypeof: string;
  readonly verdict: Verdict;
}

export interface ModuleStatus {
  readonly module: string;
  readonly how: string;
  readonly failure: string;
  readonly parsed: number;
  readonly distinct: number;
}

export interface OtherSectionLink {
  readonly module: string;
  readonly href: string;
}

export interface ProbeObservation {
  readonly featureFlagTakesTheOnBranch: string;
  readonly featureBindingType: string;
  readonly namespaceImportBinding: string;
  readonly dynamicImportBehavior: string;
}

export interface ReferenceReport {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly modules: number;
  readonly distinctPairs: number;
  readonly distinctNames: number;
  readonly moduleSource: {
    readonly landing: string[];
    readonly sidebar: string[];
    readonly match: boolean;
    readonly onlyLanding: string[];
    readonly onlySidebar: string[];
    readonly generatedFrom: string | null;
  };
  readonly moduleGroups: {
    counts: Record<string, number>;
    mismatches: { path: string; expected: string; actual: string }[];
  };
  readonly counts: Record<Verdict, number>;
  readonly contradicted: SymbolRow[];
  readonly missing: (SymbolRow & { explain: string })[];
  readonly typeAlsoValue: SymbolRow[];
  readonly duplicates: { module: string; name: string; kinds: string[] }[];
  readonly otherSectionLinks: OtherSectionLink[];
  readonly kindMatrix: Record<string, Record<string, number>>;
  readonly kindColours: ReturnType<typeof colourContract>;
  readonly badgeCoverage: {
    module: string;
    rows: number;
    badges: number;
    unmatched: string[];
  }[];
  readonly badges: { total: number; matched: number; unmatched: number };
  readonly kindModules: Record<string, string[]>;
  readonly unknownKinds: string[];
  readonly unavailableModules: ModuleStatus[];
  readonly moduleStatus: ModuleStatus[];
  readonly compileTimeProbe:
    (ProbeObservation & { togglesWithFeature: boolean }) | null;
}

export interface ReferenceAuditResult {
  readonly report: ReferenceReport;
  readonly manifest: ContractManifest;
  readonly schema: Record<string, unknown>;
  readonly validation: { ok: boolean; errors: string[] };
  readonly schemaSelfTest: boolean;
  readonly sourceDigest: string;
}

/**
 * `bun:*` modules must be imported with a **static** specifier. With a computed one
 * (`import(spec)` where `spec` is a variable) resolution falls through to the package registry and
 * reports `Cannot find package 'bun:bundle'` — a probe bug, not a missing runtime module.
 */
const BUN_BUILTINS: Readonly<
  Record<string, () => Promise<Record<string, unknown>>>
> = {
  "bun:bundle": () =>
    import("bun:bundle") as unknown as Promise<Record<string, unknown>>,
  "bun:ffi": () =>
    import("bun:ffi") as unknown as Promise<Record<string, unknown>>,
  "bun:jsc": () =>
    import("bun:jsc") as unknown as Promise<Record<string, unknown>>,
  "bun:sqlite": () =>
    import("bun:sqlite") as unknown as Promise<Record<string, unknown>>,
  "bun:test": () =>
    import("bun:test") as unknown as Promise<Record<string, unknown>>,
};

/** `No such built-in module` means the runtime does not implement it; anything else is our bug. */
export function classifyFailure(message: string): ModuleFailure {
  if (/No such built-in module/i.test(message)) return "unsupported";
  if (/Cannot find package 'bun:/i.test(message)) return "compile-time-only";
  return "unresolvable";
}

async function namespaceFor(path: string): Promise<{
  ns: Record<string, unknown> | null;
  how: string;
  failure?: ModuleFailure;
}> {
  const rel = path.slice("/reference/".length);
  if (rel === "bun") {
    return { ns: Bun as unknown as Record<string, unknown>, how: "Bun" };
  }
  if (rel === "globals") {
    return {
      ns: globalThis as unknown as Record<string, unknown>,
      how: "globalThis",
    };
  }
  if (rel.startsWith("bun/")) {
    const spec = `bun:${rel.slice(4)}`;
    const load = BUN_BUILTINS[spec];
    if (load === undefined) {
      return { ns: null, how: `unmapped: ${spec}`, failure: "unresolvable" };
    }
    try {
      return { ns: await load(), how: spec };
    } catch (error) {
      const message = (error as Error).message.slice(0, 80);
      return {
        ns: null,
        how: `unavailable: ${message}`,
        failure: classifyFailure(message),
      };
    }
  }
  if (rel.startsWith("node/")) {
    const spec = `node:${rel.slice(5)}`;
    try {
      return { ns: (await import(spec)) as Record<string, unknown>, how: spec };
    } catch (error) {
      const message = (error as Error).message.slice(0, 80);
      return {
        ns: null,
        how: `unavailable: ${message}`,
        failure: classifyFailure(message),
      };
    }
  }
  return { ns: null, how: "unmapped", failure: "unresolvable" };
}

function runBundleProbe(flags: readonly string[]): {
  observation: ProbeObservation | null;
  raw: string;
} {
  const runner = join(import.meta.dir, "bun_reference_probe_run.ts");
  try {
    const result = Bun.spawnSync([process.execPath, ...flags, runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = result.stdout.toString().trim();
    const line = raw.split("\n").at(-1) ?? "";
    try {
      return { observation: JSON.parse(line) as ProbeObservation, raw };
    } catch {
      return { observation: null, raw: raw.slice(0, 200) };
    }
  } catch (error) {
    return { observation: null, raw: String(error).slice(0, 200) };
  }
}

function probeCompileTimeModule(): ReferenceReport["compileTimeProbe"] {
  const plain = runBundleProbe([]);
  const withFeature = runBundleProbe(["--feature=TEST"]);
  if (plain.observation === null || withFeature.observation === null)
    return null;
  return {
    ...plain.observation,
    togglesWithFeature:
      plain.observation.featureFlagTakesTheOnBranch !==
      withFeature.observation.featureFlagTakesTheOnBranch,
  };
}

/** Fetch, reconcile and derive the contract. Throws on a network failure; never writes files. */
export async function runReferenceAudit(
  options: ReferenceAuditOptions = {},
): Promise<ReferenceAuditResult> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const origin = options.origin ?? "https://bun.sh";
  const pageJson: FetchJson = fetchJson;

  const landing = (await pageJson(REFERENCE_INDEX_URL)) as {
    props?: { contentHtml?: string };
  };
  const landingContent = landing.props?.contentHtml ?? "";
  const landingPaths = modulePathsFromLanding(landingContent);
  const generatedFrom = generatedFromClaim(landingContent);
  const moduleGroups = checkModuleGroups(parseLandingGroups(landingContent));

  const bunPage = (await pageJson(`${origin}/reference/bun.props.json`)) as {
    props?: { contentHtml?: string; sidebarHtml?: string };
  };
  const sidebarPaths = modulePathsFromSidebar(bunPage.props?.sidebarHtml ?? "");
  const moduleSource = crossCheckModuleSources(landingPaths, sidebarPaths);

  const symbols: SymbolRow[] = [];
  const moduleStatus: ModuleStatus[] = [];
  const moduleNamespaces = new Map<string, Record<string, unknown> | null>();
  const duplicates: { module: string; name: string; kinds: string[] }[] = [];
  const otherSectionLinks: OtherSectionLink[] = [];
  const joinedBadges: JoinedBadge[] = [];
  const badgeCoverage: {
    module: string;
    rows: number;
    badges: number;
    unmatched: string[];
  }[] = [];
  const allBadges: SidebarBadge[] = [];
  const kindMatrix = new Map<string, Map<string, number>>();
  const kindModules = new Map<string, Set<string>>();
  const unknownKinds = new Set<string>();

  const hashes: string[] = [];
  for (const path of moduleSource.landing) {
    const payload =
      path === "/reference/bun"
        ? bunPage
        : ((await pageJson(`${origin}${path}.props.json`)) as {
            props?: { contentHtml?: string; sidebarHtml?: string };
          });
    const contentHtml = payload.props?.contentHtml ?? "";
    const sidebarHtml = payload.props?.sidebarHtml ?? "";
    hashes.push(
      `${path}\n${new Bun.CryptoHasher("sha256")
        .update(contentHtml)
        .update("\u0000")
        .update(sidebarHtml)
        .digest("hex")}\n`,
    );

    const index = parseIndex(contentHtml, path.slice("/reference/".length));
    const badges = parseSidebarBadges(sidebarHtml);
    const { ns, how, failure } = await namespaceFor(path);
    moduleNamespaces.set(path, ns);
    otherSectionLinks.push(
      ...index.otherLinks.map((link) => ({ module: path, href: link.href })),
    );

    for (const [kind, observed] of Object.entries(index.sectionCounts)) {
      if (observed === 0) continue;
      const modules = kindModules.get(kind) ?? new Set<string>();
      modules.add(path);
      kindModules.set(kind, modules);
    }

    const merged = mergeIndexRows(index.rows);
    const kindsOf = new Map<string, string[]>();
    for (const entry of merged.entries) {
      kindsOf.set(entry.name, entry.kinds);
      const primaryKind = entry.kinds[0] ?? "unknown";
      if (!KNOWN_SECTION_KINDS.has(primaryKind)) unknownKinds.add(primaryKind);

      let value: unknown;
      if (ns !== null) {
        try {
          value = ns[entry.name];
        } catch {
          value = undefined;
        }
      }
      const verdict = verdictOf({
        kinds: entry.kinds,
        summary: entry.summary,
        present: value !== undefined,
        resolvable: ns !== null,
        failure,
      });
      const verdicts = kindMatrix.get(primaryKind) ?? new Map<string, number>();
      verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
      kindMatrix.set(primaryKind, verdicts);
      symbols.push({
        module: path,
        name: entry.name,
        kinds: entry.kinds,
        summary: entry.summary,
        present: value !== undefined,
        runtimeTypeof: typeof value,
        verdict,
      });
    }

    const unmatched: string[] = [];
    let matchedBadges = 0;
    for (const badge of badges) {
      const kinds = kindsOf.get(badge.name);
      if (kinds === undefined) {
        unmatched.push(badge.symbol);
        continue;
      }
      matchedBadges += 1;
      joinedBadges.push({ ...badge, kinds });
    }
    allBadges.push(...badges);
    badgeCoverage.push({
      module: path,
      rows: merged.entries.length,
      badges: matchedBadges,
      unmatched,
    });
    duplicates.push(
      ...merged.duplicates.map((entry) => ({ module: path, ...entry })),
    );
    moduleStatus.push({
      module: path,
      how,
      failure: failure ?? "ok",
      parsed: index.rows.length,
      distinct: merged.entries.length,
    });
  }

  const count = (verdict: Verdict) =>
    symbols.filter((row) => row.verdict === verdict).length;
  const missing = symbols
    .filter((row) => row.verdict === "documented-value-missing")
    .map((row) => ({
      ...row,
      explain: explainMissing(row, moduleNamespaces.get(row.module) ?? null),
    }));
  const distinctNames = new Set(symbols.map((row) => row.name)).size;
  const kindColours = colourContract(joinedBadges, allBadges);

  const report: ReferenceReport = {
    generatedAt: new Date().toISOString(),
    runtime: bunRevisionComposite(),
    modules: moduleSource.landing.length,
    distinctPairs: symbols.length,
    distinctNames,
    moduleSource: { ...moduleSource, generatedFrom },
    moduleGroups,
    counts: {
      ok: count("ok"),
      "ok-erased": count("ok-erased"),
      "ok-types-only": count("ok-types-only"),
      "doc-contradicted": count("doc-contradicted"),
      "documented-value-missing": count("documented-value-missing"),
      "type-also-value": count("type-also-value"),
      "module-unresolvable": count("module-unresolvable"),
      "module-unsupported": count("module-unsupported"),
      "module-compile-time-only": count("module-compile-time-only"),
    },
    contradicted: symbols.filter((row) => row.verdict === "doc-contradicted"),
    missing,
    typeAlsoValue: symbols.filter((row) => row.verdict === "type-also-value"),
    duplicates,
    otherSectionLinks,
    kindMatrix: Object.fromEntries(
      [...kindMatrix].map(([kind, verdicts]) => [
        kind,
        Object.fromEntries(verdicts),
      ]),
    ),
    kindColours,
    badgeCoverage,
    badges: {
      total: allBadges.length,
      matched: badgeCoverage.reduce((total, mod) => total + mod.badges, 0),
      unmatched: badgeCoverage.reduce(
        (total, mod) => total + mod.unmatched.length,
        0,
      ),
    },
    kindModules: Object.fromEntries(
      [...kindModules].map(([kind, modules]) => [kind, [...modules].sort()]),
    ),
    unknownKinds: [...unknownKinds],
    unavailableModules: moduleStatus.filter(
      (status) => status.failure !== "ok",
    ),
    moduleStatus,
    compileTimeProbe: options.probe === false ? null : probeCompileTimeModule(),
  };

  const sourceDigest = new Bun.CryptoHasher("sha256")
    .update([...hashes].sort().join(""))
    .digest("hex");

  const manifest = {
    $schema: "./reference-contract.schema.json",
    manifestVersion: 1 as const,
    generatedAt: report.generatedAt,
    runtime: report.runtime,
    source: { landing: REFERENCE_INDEX_URL, digest: sourceDigest },
    modules: report.modules,
    distinctPairs: report.distinctPairs,
    distinctNames: report.distinctNames,
    moduleSource: report.moduleSource,
    moduleGroups: report.moduleGroups,
    counts: report.counts,
    kindMatrix: report.kindMatrix,
    kindColours: report.kindColours,
    badgeCoverage: report.badgeCoverage,
    badges: report.badges,
    unavailableModules: report.unavailableModules,
    unknownKinds: report.unknownKinds,
  };
  const validated = validateContractManifest(manifest);
  const validation = validated.ok
    ? { ok: true, errors: [] as string[] }
    : { ok: false, errors: validated.errors };
  const schemaSelfTest = validated.ok
    ? negativeSelfTest(validated.manifest)
    : false;

  return {
    report,
    manifest: validated.ok
      ? validated.manifest
      : (manifest as unknown as ContractManifest),
    schema: contractSchema(),
    validation,
    schemaSelfTest,
    sourceDigest,
  };
}

/** Markdown rendering (kept beside the report so CLI and Scratch emit identical artifacts). */
export function renderReferenceMarkdown(
  result: Pick<
    ReferenceAuditResult,
    "report" | "sourceDigest" | "validation" | "schemaSelfTest"
  >,
  state: { manifestState: string },
): string {
  const { report } = result;
  const {
    moduleSource,
    moduleGroups,
    duplicates,
    otherSectionLinks,
    kindColours,
  } = report;
  const lines: string[] = [
    "# Bun reference tree vs runtime (whole tree)",
    "",
    `Runtime: \`${report.runtime}\` · modules: ${report.modules} · distinct (module, symbol) pairs: ${report.distinctPairs} · unique names: ${report.distinctNames} · generated ${report.generatedAt}`,
    "",
    `Module index: \`${REFERENCE_INDEX_URL}\` (${moduleSource.landing.length}) · cross-checked against the bun module sidebar (${moduleSource.sidebar.length}) → **${moduleSource.match ? "identical" : "MISMATCH"}**`,
    "",
    ...(moduleSource.generatedFrom === null
      ? []
      : [`Generation claim: "${moduleSource.generatedFrom}"`, ""]),
    ...(moduleSource.match
      ? []
      : [
          "| only on /reference | only in sidebar |",
          "|---|---|",
          ...Array.from(
            {
              length: Math.max(
                moduleSource.onlyLanding.length,
                moduleSource.onlySidebar.length,
              ),
            },
            (_, i) =>
              `| ${moduleSource.onlyLanding[i] ?? ""} | ${moduleSource.onlySidebar[i] ?? ""} |`,
          ),
          "",
        ]),
    "| verdict | count | meaning |",
    "|---|---|---|",
    `| ok | ${report.counts.ok} | value, present |`,
    `| ok-erased | ${report.counts["ok-erased"]} | type/interface, correctly absent |`,
    `| ok-types-only | ${report.counts["ok-types-only"]} | says types-only, and is |`,
    `| doc-contradicted | ${report.counts["doc-contradicted"]} | **says types-only, runtime has it** |`,
    `| documented-value-missing | ${report.counts["documented-value-missing"]} | **value documented, runtime lacks it** |`,
    `| type-also-value | ${report.counts["type-also-value"]} | type that is also a value |`,
    `| module-unresolvable | ${report.counts["module-unresolvable"]} | probe failure — our bug, not evidence of absence |`,
    `| module-unsupported | ${report.counts["module-unsupported"]} | module documented but not implemented by this Bun |`,
    `| module-compile-time-only | ${report.counts["module-compile-time-only"]} | compile-time virtual module (static named import only) |`,
    "",
    "## Doc contradicted by the runtime",
    "",
    report.contradicted.length === 0
      ? "_(none)_"
      : "| module | symbol | kinds | summary | runtime |",
    ...(report.contradicted.length === 0 ? [] : ["|---|---|---|---|---|"]),
    ...report.contradicted.map(
      (row) =>
        `| \`${row.module}\` | \`${row.name}\` | ${row.kinds.join(", ")} | ${row.summary} | ${row.runtimeTypeof} |`,
    ),
    "",
    `## Documented value absent from the runtime (top ${Math.min(report.missing.length, 60)} of ${report.missing.length})`,
    "",
    report.missing.length === 0
      ? "_(none)_"
      : "| module | symbol | kinds | why | summary |",
    ...(report.missing.length === 0 ? [] : ["|---|---|---|---|---|"]),
    ...report.missing
      .slice(0, 60)
      .map(
        (row) =>
          `| \`${row.module}\` | \`${row.name}\` | ${row.kinds.join(", ")} | ${row.explain} | ${row.summary.slice(0, 50)} |`,
      ),
    "",
    `## Merged names (same name in several sections, ${duplicates.length})`,
    "",
    duplicates.length === 0
      ? "_(none)_"
      : duplicates
          .map(
            (entry) =>
              `- \`${entry.module}\` · \`${entry.name}\` (${entry.kinds.join(", ")})`,
          )
          .join("\n"),
    "",
    `## Other-section rows (module re-export links, excluded from symbol counts, ${otherSectionLinks.length})`,
    "",
    otherSectionLinks.length === 0
      ? "_(none)_"
      : otherSectionLinks
          .map((link) => `- \`${link.module}\` → \`${link.href}\``)
          .join("\n"),
    "",
    `## Documented modules not importable (${report.unavailableModules.length})`,
    "",
    "| module | class | reason |",
    "|---|---|---|",
    ...report.unavailableModules.map(
      (mod) =>
        `| \`${mod.module}\` | ${mod.failure} | ${mod.how.replaceAll("|", "\\|")} |`,
    ),
    "",
    `## Landing module groups (${Object.values(moduleGroups.counts).reduce((a, b) => a + b, 0)})`,
    "",
    "| group | modules |",
    "|---|---|",
    ...Object.entries(moduleGroups.counts).map(
      ([group, n]) => `| ${group} | ${n} |`,
    ),
    "",
    moduleGroups.mismatches.length === 0
      ? "Grouping matches the path-implied expectation."
      : [
          "| module | expected | listed under |",
          "|---|---|---|",
          ...moduleGroups.mismatches.map(
            (m) => `| \`${m.path}\` | ${m.expected} | ${m.actual} |`,
          ),
        ].join("\n"),
    "",
    "## Kind matrix (module-qualified pairs)",
    "",
    `| kind | documented | ${Object.keys(report.counts).join(" | ")} |`,
    `|---${"|---".repeat(Object.keys(report.counts).length + 1)}|`,
    ...Object.entries(report.kindMatrix).map(
      ([kind, verdicts]) =>
        `| ${kind} | ${Object.values(verdicts).reduce((a, b) => a + b, 0)} | ${Object.keys(
          report.counts,
        )
          .map((verdict) => verdicts[verdict] ?? 0)
          .join(" | ")} |`,
    ),
    "",
    report.unknownKinds.length === 0
      ? "Every section kind is known."
      : `**Unknown section kinds:** ${report.unknownKinds.join(", ")}`,
    "",
    "Kinds by module surface:",
    "",
    ...Object.entries(report.kindModules).map(
      ([kind, modules]) =>
        `- **${kind}** — ${modules.length} module(s): ${modules.slice(0, 6).join(", ")}${modules.length > 6 ? ", …" : ""}`,
    ),
    "",
    "## Kind colour contract",
    "",
    "The docs claim symbols are colour-coded by kind; badges are joined to the documented kind.",
    "",
    "| kind (name) | alias | colour | count |",
    "|---|---|---|---|",
    ...kindColours.contract.map(
      (row) => `| ${row.name} | ${row.alias} | ${row.colour} | ${row.count} |`,
    ),
    "",
    "Badge aliases observed:",
    "",
    "| alias | colour | badges |",
    "|---|---|---|",
    ...kindColours.observed.map(
      (row) => `| ${row.alias} | ${row.colour} | ${row.count} |`,
    ),
    "",
    `Alias conflicts (one alias, several colours): ${kindColours.conflicts.length}`,
    ...kindColours.conflicts.map(
      (c) => `- ${c.alias}: ${c.colours.join(", ")}`,
    ),
    "",
    `Colour conflicts (one colour, several aliases): ${kindColours.colourConflicts.length}`,
    ...kindColours.colourConflicts.map(
      (c) => `- ${c.colour}: ${c.aliases.join(", ")}`,
    ),
    "",
    `Badge coverage: ${report.badges.total} badges · ${report.badges.matched} matched to a documented kind · ${report.badges.unmatched} unmatched (members of a default-export namespace)`,
    "",
    `Kind/badge mismatches (${kindColours.mismatches.length})`,
    "",
    kindColours.mismatches.length === 0
      ? "Every badge matches its member's kind (merged symbols may use either kind's alias)."
      : [
          "| symbol | kinds | alias | colour | allowed |",
          "|---|---|---|---|---|",
          ...kindColours.mismatches
            .slice(0, 30)
            .map(
              (m) =>
                `| \`${m.symbol}\` | ${m.kinds.join(", ")} | ${m.alias} | ${m.colour} | ${m.allowed.join("/")} |`,
            ),
        ].join("\n"),
    "",
    "## Machine-readable contract",
    "",
    "Format: **JSON manifest + JSON Schema**, not JSON5 — every gate parses JSON, no JSON5 parser is a",
    "dependency, and comments in a hand-edited contract would drift silently. The schema is generated",
    "from the same zod definition that validates the manifest, so the two cannot diverge.",
    "",
    `- manifest: \`reference-contract.json\` (validated: ${result.validation.ok ? "yes" : "**no**"}; state: ${state.manifestState}; schema self-test: ${result.schemaSelfTest ? "passed" : "**failed**"})`,
    "- schema: `reference-contract.schema.json` (draft 2020-12, generated via `z.toJSONSchema`)",
    `- source digest: \`${result.sourceDigest}\` — sha256 over \`path + contentHtml + sidebarHtml\` for every module, sorted by path`,
    "",
    "## Compile-time module evidence",
    "",
    "`bun:bundle` is a compile-time virtual module: only a static named import is substituted.",
    "The plain and `--feature` runs are compared, so the substitution claim is falsifiable.",
    "",
    "```json",
    JSON.stringify(
      report.compileTimeProbe ?? { skipped: "probe disabled" },
      null,
      2,
    ),
    "```",
    "",
    "## Per module",
    "",
    "| module | resolved via | rows | distinct |",
    "|---|---|---|---|",
    ...report.moduleStatus.map(
      (mod) =>
        `| \`${mod.module}\` | ${mod.how} | ${mod.parsed} | ${mod.distinct} |`,
    ),
    "",
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Single-module audit (`bun` only), preserved for the Scratch report artifacts.
// ---------------------------------------------------------------------------------------------

export interface ModuleAuditReport {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly moduleIndex: string;
  readonly sections: Record<string, number>;
  readonly rowsParsed: number;
  readonly documentedSymbols: number;
  readonly multiSectionNames: { name: string; kinds: string[] }[];
  readonly counts: Record<string, number>;
  readonly docContradicted: (SymbolRow & { kinds: string[] })[];
  readonly documentedButMissing: (SymbolRow & { explain: string })[];
  readonly undocumentedAtRuntime: { name: string; type: string }[];
}

export async function runReferenceModuleAudit(
  options: { fetchJson?: FetchJson | undefined } = {},
): Promise<{ report: ModuleAuditReport; markdown: string }> {
  const fetchJson: FetchJson = options.fetchJson ?? defaultFetchJson;
  const payload = (await fetchJson(REFERENCE_INDEX_URL)) as {
    props?: { contentHtml?: string };
  };
  const html = payload.props?.contentHtml ?? "";
  if (html.length === 0) throw new Error("module index: empty contentHtml");
  const parsed = parseIndex(html, "bun");
  const merged = mergeIndexRows(parsed.rows);
  const module = "/reference/bun";

  const rows = merged.entries
    .map((entry) => {
      let value: unknown;
      try {
        value = (Bun as Record<string, unknown>)[entry.name];
      } catch {
        value = undefined;
      }
      const present = value !== undefined;
      return {
        module,
        name: entry.name,
        kinds: entry.kinds,
        summary: entry.summary,
        present,
        runtimeTypeof: typeof value,
        verdict: verdictOf({
          kinds: entry.kinds,
          summary: entry.summary,
          present,
          resolvable: true,
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const count = (verdict: Verdict) =>
    rows.filter((row) => row.verdict === verdict).length;
  const documented = new Set(rows.map((row) => row.name));
  const undocumented: { name: string; type: string }[] = [];
  for (const name of Object.getOwnPropertyNames(Bun)) {
    if (documented.has(name) || name.startsWith("_")) continue;
    if (["constructor", "prototype", "length", "name"].includes(name)) continue;
    let type = "unreadable";
    try {
      type = typeof (Bun as Record<string, unknown>)[name];
    } catch {
      // keep "unreadable"
    }
    if (["function", "object", "number", "string", "boolean"].includes(type)) {
      undocumented.push({ name, type });
    }
  }
  undocumented.sort((a, b) => a.name.localeCompare(b.name));

  const rowsParsed = Object.values(parsed.sectionCounts).reduce(
    (total, n) => total + n,
    0,
  );
  const report: ModuleAuditReport = {
    generatedAt: new Date().toISOString(),
    runtime: bunRevisionComposite(),
    moduleIndex: REFERENCE_INDEX_URL,
    sections: parsed.sectionCounts,
    rowsParsed,
    documentedSymbols: rows.length,
    multiSectionNames: merged.duplicates,
    counts: {
      ok: count("ok"),
      "ok-erased": count("ok-erased"),
      "ok-types-only": count("ok-types-only"),
      "doc-contradicted": count("doc-contradicted"),
      "documented-value-missing": count("documented-value-missing"),
      "type-also-value": count("type-also-value"),
    },
    docContradicted: rows.filter((row) => row.verdict === "doc-contradicted"),
    documentedButMissing: rows
      .filter((row) => row.verdict === "documented-value-missing")
      .map((row) => ({
        ...row,
        explain: explainMissing(row, Bun as unknown as Record<string, unknown>),
      })),
    undocumentedAtRuntime: undocumented,
  };

  const lines: string[] = [
    "# Bun reference vs runtime audit",
    "",
    `Runtime: \`${report.runtime}\` · source: \`${report.moduleIndex}\` · generated ${report.generatedAt}`,
    "",
    `Documented symbols: **${rows.length}** unique (${rowsParsed} section rows — the module index carries every row)`,
    "",
    "| verdict | count | meaning |",
    "|---|---|---|",
    `| ok | ${report.counts.ok} | value symbol, present at runtime |`,
    `| ok-erased | ${report.counts["ok-erased"]} | type/interface, correctly absent at runtime |`,
    `| ok-types-only | ${report.counts["ok-types-only"]} | says types-only, and is |`,
    `| doc-contradicted | ${report.counts["doc-contradicted"]} | **says types-only, runtime has it** |`,
    `| documented-value-missing | ${report.counts["documented-value-missing"]} | **value documented, absent at runtime** |`,
    `| type-also-value | ${report.counts["type-also-value"]} | type that also exists as a value |`,
    "",
    "## Doc contradicted (docs claim types-only, runtime exposes it)",
    "",
    "| symbol | kinds | summary | runtime |",
    "|---|---|---|---|",
    ...report.docContradicted.map(
      (row) =>
        `| \`Bun.${row.name}\` | ${row.kinds.join(", ")} | ${row.summary} | ${row.runtimeTypeof} |`,
    ),
    "",
    "## Documented value absent from the runtime",
    "",
    "| symbol | kinds | explanation | summary |",
    "|---|---|---|---|",
    ...(report.documentedButMissing.length === 0
      ? ["| _(none)_ | | | |"]
      : report.documentedButMissing.map(
          (row) =>
            `| \`Bun.${row.name}\` | ${row.kinds.join(", ")} | ${row.explain} | ${row.summary} |`,
        )),
    "",
    `## Names listed in several sections (${merged.duplicates.length})`,
    "",
    merged.duplicates.length === 0
      ? "_(none)_"
      : merged.duplicates
          .map((d) => `- \`Bun.${d.name}\` (${d.kinds.join(", ")})`)
          .join("\n"),
    "",
    `## Runtime members not in the docs (${undocumented.length})`,
    "",
    "The reverse defect: real, callable properties the reference index never lists.",
    "",
    "| runtime member | typeof |",
    "|---|---|",
    ...(undocumented.length === 0
      ? ["| _(none)_ | |"]
      : undocumented.map(
          (entry) => `| \`Bun.${entry.name}\` | ${entry.type} |`,
        )),
    "",
  ];
  return { report, markdown: lines.join("\n") };
}
