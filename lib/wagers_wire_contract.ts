/**
 * @file lib/wagers_wire_contract.ts
 * @description Executable form of `schema/wagers_field_contract.json`.
 *
 * The registry owns semantics; the captures own wire shape. This module reads
 * both and checks raw `getBetTicker` rows against the capture's `type` and
 * `nullable` for each registered field:
 *
 *  - a type mismatch or a null where `nullable: false` is a violation;
 *  - an enum difference is **not** a violation: `enum_source` is `observed`
 *    (see scripts/capture/schema.ts:191), so an unobserved code is a sample
 *    boundary, not a contract break.
 *
 * The host wires this into the live-wagers payload as `wire_contract`, which is
 * the same pattern as `policy_version`: a stable probe instead of a build hash.
 */

import type {
  WagersWireContractSummary,
  WagersWireViolation,
} from "@sportsdesk-ops/contracts";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { assertRelativePath, SLAB_SERVER } from "./slab_config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_REGISTRY_PATH = resolve(
  REPO_ROOT,
  SLAB_SERVER.paths.wire_contract,
);

interface SkeletonScalar {
  readonly type?: unknown;
  readonly nullable?: unknown;
  readonly enumCandidates?: unknown;
}

interface RegistryField {
  readonly capture?: unknown;
  readonly enum_source?: { readonly value?: unknown } | undefined;
}

interface RegistryDoc {
  readonly captureSets?: Record<
    string,
    {
      readonly path?: unknown;
      readonly sha256?: unknown;
      readonly skeletonPath?: unknown;
    }
  >;
  readonly fields?: Record<string, RegistryField>;
}

interface LoadedContract {
  readonly registryPath: string;
  readonly captureId: string;
  readonly captureSha: string;
  readonly skeletonPath: string;
  readonly enumSource: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
  }[];
}

let cache: {
  readonly key: string;
  readonly contract: LoadedContract | null;
} | null = null;

/**
 * `WAGERS_WIRE_CONTRACT_PATH` overrides the checkout-relative registry path.
 *
 * The env value goes through `assertRelativePath`: the adapter is the chokepoint
 * for user-supplied paths, so an absolute path cannot enter the filesystem read
 * (or the payload's `registry` label) even though the label itself is only a
 * basename.
 */
export function wagersWireContractPath(): string {
  const override = process.env.WAGERS_WIRE_CONTRACT_PATH?.trim();
  if (!override) return DEFAULT_REGISTRY_PATH;
  return resolve(
    REPO_ROOT,
    assertRelativePath(override, "WAGERS_WIRE_CONTRACT_PATH"),
  );
}

async function loadContract(
  registryPath: string,
): Promise<LoadedContract | null> {
  const registryStat = await stat(registryPath).catch(() => null);
  if (registryStat === null) return null;

  const registry = (await Bun.file(registryPath).json()) as RegistryDoc;
  const fields = Object.entries(registry.fields ?? {});

  // One capture per registry: a mixed set would silently check only the first
  // field's capture, so reject it instead of guessing.
  const captureIds = [
    ...new Set(
      fields
        .map(([, entry]) => entry?.capture)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  if (captureIds.length !== 1) {
    throw new Error(
      `registry must cite exactly one capture for all fields; found ${captureIds.length}` +
        (captureIds.length > 0 ? ` (${captureIds.join(", ")})` : ""),
    );
  }
  const captureId = captureIds[0]!;
  const captureDef = registry.captureSets?.[captureId];
  if (!captureDef || typeof captureDef.path !== "string") return null;

  // The registry lives at `<root>/schema/<file>.json`; cited capture paths are
  // root-relative. dirname twice, rather than treating the file as a directory.
  const capturePath = resolve(dirname(dirname(registryPath)), captureDef.path);
  const captureStat = await stat(capturePath).catch(() => null);
  if (captureStat === null) return null;

  const key = `${registryPath}:${registryStat.mtimeMs}:${captureStat.mtimeMs}`;
  if (cache?.key === key) return cache.contract;

  const capture = (await Bun.file(capturePath).json()) as unknown;
  const skeletonPath =
    typeof captureDef.skeletonPath === "string" ? captureDef.skeletonPath : "";
  const container = resolveDotted(capture, skeletonPath) as
    Record<string, Record<string, unknown>> | undefined;

  const loadedFields: Array<{
    name: string;
    type: string;
    nullable: boolean;
  }> = [];
  for (const [name] of fields) {
    const node = container?.[name] as SkeletonScalar | undefined;
    if (!node || typeof node.type !== "string") continue;
    // `unknown`/truncated nodes are honest placeholders: do not judge them.
    if (node.type === "unknown") continue;
    loadedFields.push({
      name,
      type: node.type,
      nullable: node.nullable === true,
    });
  }

  const enumSource =
    typeof fields[0]?.[1]?.enum_source?.value === "string"
      ? fields[0][1].enum_source.value
      : "unknown";

  const contract: LoadedContract = {
    registryPath,
    captureId,
    captureSha: typeof captureDef.sha256 === "string" ? captureDef.sha256 : "",
    skeletonPath,
    enumSource,
    fields: loadedFields,
  };
  cache = { key, contract };
  return contract;
}

function resolveDotted(root: unknown, dotted: string): unknown {
  let cursor: unknown = root;
  for (const key of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    default:
      return true;
  }
}

function render(value: unknown): string {
  if (value === undefined) return "(absent)";
  const text =
    typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * One summary per (row array, contract).
 *
 * The loader hands back a frozen row array until the source file changes, and
 * `loadContract` returns a new contract object whenever the registry or the cited
 * capture changes (its own stat cache). Keying on both means a `bun --hot` config
 * reload cannot serve a scan computed against the previous contract, and the
 * frozen rows mean an in-place edit cannot outlive its scan.
 */
const scanCache = new WeakMap<
  readonly Record<string, unknown>[],
  WeakMap<LoadedContract, WagersWireContractSummary>
>();

/** Check raw rows against the registry's wired fields; never throws. */
export async function inspectWagersWireContract(
  rows: readonly Record<string, unknown>[],
  registryPath: string = wagersWireContractPath(),
  options: {
    readonly skipRow?: ((row: Record<string, unknown>) => boolean) | undefined;
  } = {},
): Promise<WagersWireContractSummary> {
  let contract: LoadedContract | null;
  try {
    contract = await loadContract(registryPath);
  } catch (err) {
    return unavailableSummary(rows, registryPath, err);
  }
  if (contract === null) {
    return unavailableSummary(
      rows,
      registryPath,
      "wire contract registry or capture unavailable",
    );
  }

  // Predicate runs are never memoized: the predicate is part of the call.
  if (options.skipRow) return scanRows(rows, contract, options);

  const perRows =
    scanCache.get(rows) ??
    new WeakMap<LoadedContract, WagersWireContractSummary>();
  const cached = perRows.get(contract);
  if (cached) return cached;
  const summary = await scanRows(rows, contract, {});
  perRows.set(contract, summary);
  scanCache.set(rows, perRows);
  return summary;
}

/** Never echo an absolute path into the payload/tooltip. */
function registryLabel(registryPath: string): string {
  return registryPath.includes(`${sep}schema${sep}`)
    ? `schema/${basename(registryPath)}`
    : basename(registryPath);
}

function unavailableSummary(
  rows: readonly Record<string, unknown>[],
  registryPath: string,
  error: unknown,
): WagersWireContractSummary {
  return {
    ok: false,
    registry: registryLabel(registryPath),
    capture: "",
    capture_sha256: "",
    enum_source: "unknown",
    fields_checked: [],
    // When the contract cannot be read, still report how many rows were offered.
    rows: rows.length,
    skipped_rows: 0,
    violations: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

async function scanRows(
  rows: readonly Record<string, unknown>[],
  contract: LoadedContract,
  options: {
    readonly skipRow?: ((row: Record<string, unknown>) => boolean) | undefined;
  },
): Promise<WagersWireContractSummary> {
  const checked = options.skipRow
    ? rows.filter((row) => !options.skipRow!(row))
    : rows;
  const counts = new Map<
    string,
    { type: number; nullable: number; examples: string[] }
  >();
  for (const row of checked) {
    for (const field of contract.fields) {
      const value = row[field.name];
      const bucket = counts.get(field.name) ?? {
        type: 0,
        nullable: 0,
        examples: [],
      };
      const push = (kind: "type" | "nullable") => {
        bucket[kind] += 1;
        if (bucket.examples.length < 3) bucket.examples.push(render(value));
      };
      if (value === undefined || value === null) {
        if (!field.nullable) push("nullable");
      } else if (!matchesType(value, field.type)) {
        push("type");
      }
      counts.set(field.name, bucket);
    }
  }

  const violations: WagersWireViolation[] = [];
  for (const [field, bucket] of counts) {
    if (bucket.type > 0) {
      violations.push({
        field,
        kind: "type",
        count: bucket.type,
        examples: bucket.examples,
      });
    }
    if (bucket.nullable > 0) {
      violations.push({
        field,
        kind: "nullable",
        count: bucket.nullable,
        examples: bucket.examples,
      });
    }
  }

  return {
    ok: violations.length === 0,
    registry: registryLabel(contract.registryPath),
    capture: contract.captureId,
    capture_sha256: contract.captureSha,
    enum_source: contract.enumSource,
    fields_checked: contract.fields.map((f) => f.name),
    rows: checked.length,
    skipped_rows: rows.length - checked.length,
    violations,
  };
}
