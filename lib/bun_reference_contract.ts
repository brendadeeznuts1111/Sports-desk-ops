/**
 * @file lib/bun_reference_contract.ts
 * @description Machine-readable form of the reference audit's derived contract, with a JSON Schema
 * generated from the same zod definition (one source of truth, no hand-maintained schema drift).
 *
 * Format decision (2026-11-18): **JSON manifest + JSON Schema**, not JSON5.
 * - every repo gate and consumer parses JSON (`JSON.parse`, `Bun.file().json()`, `artifacts.lock`);
 * - JSON5 needs a parser (`json5` is not a dependency; `Bun.JSON5` exists on the pin but nothing in
 *   CI reads it) and comments would let a hand edit drift silently;
 * - the schema is what makes the manifest a contract: zod validates at generation time, and
 *   `z.toJSONSchema` publishes the same shape for external consumers.
 */
import { z } from "zod";

const CountMap = z.record(z.string(), z.number().int().nonnegative());
const VerdictCounts = z.record(z.string(), z.number().int().nonnegative());

const ModuleSource = z.object({
  landing: z.array(z.string()),
  sidebar: z.array(z.string()),
  match: z.boolean(),
  onlyLanding: z.array(z.string()),
  onlySidebar: z.array(z.string()),
  generatedFrom: z.string().nullable(),
});

const ModuleGroupCheck = z.object({
  counts: CountMap,
  mismatches: z.array(
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  ),
});

const ColourContractRow = z.object({
  name: z.string(),
  alias: z.string(),
  colour: z.string(),
  count: z.number().int().nonnegative(),
});

const ObservedBadgeRow = z.object({
  alias: z.string(),
  colour: z.string(),
  count: z.number().int().nonnegative(),
});

// Badge identity is three separate fields — name (kind), alias (letter), colour — never a packed
// "F/emerald" string, so a consumer never has to split it.
const ColourContract = z.object({
  contract: z.array(ColourContractRow),
  observed: z.array(ObservedBadgeRow),
  conflicts: z.array(
    z.object({ alias: z.string(), colours: z.array(z.string()) }),
  ),
  colourConflicts: z.array(
    z.object({ colour: z.string(), aliases: z.array(z.string()) }),
  ),
  mismatches: z.array(
    z.object({
      symbol: z.string(),
      kinds: z.array(z.string()),
      alias: z.string(),
      colour: z.string(),
      allowed: z.array(z.string()),
    }),
  ),
});

const BadgeCoverage = z.object({
  module: z.string(),
  rows: z.number().int().nonnegative(),
  badges: z.number().int().nonnegative(),
  unmatched: z.array(z.string()),
});

const UnavailableModule = z.object({
  module: z.string(),
  how: z.string(),
  failure: z.string(),
});

export const ContractManifestSchema = z.object({
  $schema: z.string().optional(),
  manifestVersion: z.literal(1),
  generatedAt: z.string().min(1),
  runtime: z.string().min(1),
  source: z.object({
    landing: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  modules: z.number().int().positive(),
  distinctPairs: z.number().int().positive(),
  distinctNames: z.number().int().positive(),
  moduleSource: ModuleSource,
  moduleGroups: ModuleGroupCheck,
  counts: VerdictCounts,
  kindMatrix: z.record(z.string(), CountMap),
  kindColours: ColourContract,
  badgeCoverage: z.array(BadgeCoverage),
  badges: z.object({
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
  }),
  unavailableModules: z.array(UnavailableModule),
  unknownKinds: z.array(z.string()),
});

export type ContractManifest = z.infer<typeof ContractManifestSchema>;

/** Validate an arbitrary value and return the typed manifest or the zod issues. */
export function validateContractManifest(
  value: unknown,
): { ok: true; manifest: ContractManifest } | { ok: false; errors: string[] } {
  const result = ContractManifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

/** JSON Schema (draft 2020-12) for external consumers, generated from the same zod schema. */
export function contractSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ContractManifestSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return {
    $id: "https://sportsdesk-ops.local/schema/reference-contract.schema.json",
    title: "Bun reference audit contract",
    description:
      "Machine-readable contract derived by Scratch/bun-reference-audit/full-tree.ts: module source agreement, verdict counts, kind matrix and the kind→badge colour contract.",
    ...schema,
  };
}

/**
 * Falsification for the schema itself: a manifest with a negative count must be rejected, so a
 * schema that validates everything cannot report `schemaValid: true`.
 */
export function negativeSelfTest(manifest: ContractManifest): boolean {
  const broken = { ...manifest, modules: -1 };
  return !ContractManifestSchema.safeParse(broken).success;
}
