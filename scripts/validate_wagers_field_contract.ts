#!/usr/bin/env bun
/**
 * @file scripts/validate_wagers_field_contract.ts
 * @description Validator for `schema/wagers_field_contract.json`.
 *
 * Ownership split (the point of this file):
 *  - Wire shape (type/nullable/enum) is owned by the captures. The registry
 *    cites a capture set + sha256 and never restates the values; this validator
 *    resolves the citation and fails on drift.
 *  - Semantics (origin, consumer obligation, lifecycle, liveness) are owned by
 *    the registry. Each axis must carry a status and a citation. The validator
 *    checks the citation exists, not that it is true.
 *
 * Three outcomes:
 *  - fail: capture citation drifted, or a semantic axis is absent/statusless.
 *  - warn: two captures disagree on nullable/enum for the same field.
 *  - warn: an `unverified`/`conflicting` axis is past its review_by (TTL).
 *
 *   bun scripts/validate_wagers_field_contract.ts
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type IssueLevel = "fail" | "warn";

export interface ContractIssue {
  readonly level: IssueLevel;
  readonly path: string;
  readonly message: string;
}

export type SemanticStatus = "evidenced" | "unverified" | "conflicting";

export const SEMANTIC_AXES = [
  "lifecycle_mutability",
  "consumer_obligation",
  "origin",
  "liveness",
] as const;

const ENUM_SOURCES = new Set(["declared", "observed"]);

interface RegistryField {
  capture?: unknown;
  enum_source?: { value?: unknown; citation?: unknown } | undefined;
  semantics?: Record<string, unknown> | undefined;
}

interface Registry {
  captureSets?: Record<
    string,
    { path?: unknown; sha256?: unknown; skeletonPath?: unknown }
  >;
  fields?: Record<string, RegistryField>;
  statuses?: Record<string, unknown>;
}

/** Resolve a dotted path inside a parsed JSON value. */
export function resolveJsonPath(root: unknown, dotted: string): unknown {
  let cursor: unknown = root;
  for (const key of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim() !== "")
  );
}

/**
 * Pure checks: registry shape + semantic axes + TTL. Capture bytes and sha are
 * verified by the fs wrapper, which passes the resolved skeleton in.
 */
export function checkRegistryShape(
  registry: Registry,
  options: {
    readonly now?: Date | undefined;
    /** captureId -> parsed capture JSON (undefined = capture not resolved). */
    readonly skeletons?: ReadonlyMap<string, unknown> | undefined;
  } = {},
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const now = options.now ?? new Date();
  const statuses = registry.statuses ?? {};
  const allowed = new Set(Object.keys(statuses));
  if (allowed.size === 0) {
    issues.push({
      level: "fail",
      path: "$.statuses",
      message: "registry must declare its status vocabulary",
    });
  }

  const fields = registry.fields ?? {};
  const fieldNames = Object.keys(fields);
  if (fieldNames.length === 0) {
    issues.push({
      level: "fail",
      path: "$.fields",
      message: "no fields declared",
    });
  }

  for (const name of fieldNames) {
    const field = fields[name]!;
    const base = `$.fields.${name}`;
    const skeleton = options.skeletons?.get(String(field.capture ?? ""));

    // Wire ownership: the cited field must exist in the cited capture.
    if (typeof field.capture !== "string") {
      issues.push({
        level: "fail",
        path: base,
        message: "capture citation is required",
      });
    } else if (skeleton !== undefined) {
      const captureDef = registry.captureSets?.[field.capture];
      const skeletonPath =
        typeof captureDef?.skeletonPath === "string"
          ? captureDef.skeletonPath
          : "";
      const container = resolveJsonPath(skeleton, skeletonPath);
      const node =
        container && typeof container === "object"
          ? (container as Record<string, unknown>)[name]
          : undefined;
      if (node === undefined) {
        issues.push({
          level: "fail",
          path: `${base}.capture`,
          message: `${field.capture} has no ${skeletonPath}.${name} — capture drifted`,
        });
      }
    }

    // enum_source is required exactly when the capture declares enum candidates.
    const enumNode =
      typeof field.capture === "string" && skeleton !== undefined
        ? (resolveJsonPath(
            skeleton,
            `${registry.captureSets?.[field.capture]?.skeletonPath ?? ""}.${name}`,
          ) as { enumCandidates?: unknown } | undefined)
        : undefined;
    const hasEnumCandidates =
      enumNode !== null &&
      typeof enumNode === "object" &&
      Array.isArray((enumNode as { enumCandidates?: unknown }).enumCandidates);

    if (hasEnumCandidates || field.enum_source !== undefined) {
      const source = field.enum_source;
      if (
        !source ||
        typeof source.value !== "string" ||
        !ENUM_SOURCES.has(source.value)
      ) {
        issues.push({
          level: "fail",
          path: `${base}.enum_source`,
          message: "enum_source.value must be declared or observed",
        });
      }
      if (
        typeof source?.citation !== "string" ||
        source.citation.trim() === ""
      ) {
        issues.push({
          level: "fail",
          path: `${base}.enum_source`,
          message: "enum_source requires a citation",
        });
      }
    }

    // Semantics: four axes, each with a status and a citation.
    const semantics = field.semantics;
    if (!semantics || typeof semantics !== "object") {
      issues.push({
        level: "fail",
        path: base,
        message: "semantics table is required",
      });
      continue;
    }
    for (const axis of SEMANTIC_AXES) {
      const entry = semantics[axis] as
        | { status?: unknown; citations?: unknown; review_by?: unknown }
        | undefined;
      const path = `${base}.semantics.${axis}`;
      if (!entry || typeof entry !== "object") {
        issues.push({ level: "fail", path, message: "axis is absent" });
        continue;
      }
      if (typeof entry.status !== "string" || !allowed.has(entry.status)) {
        issues.push({
          level: "fail",
          path,
          message: `status must be one of ${[...allowed].join(", ")}`,
        });
        continue;
      }
      if (!isStringArray(entry.citations)) {
        issues.push({
          level: "fail",
          path,
          message: "at least one citation is required",
        });
      }
      if (entry.status === "unverified" || entry.status === "conflicting") {
        if (
          typeof entry.review_by !== "string" ||
          Number.isNaN(Date.parse(entry.review_by))
        ) {
          issues.push({
            level: "fail",
            path,
            message: `${entry.status} requires a valid review_by date (TTL)`,
          });
        } else if (Date.parse(entry.review_by) < now.getTime()) {
          issues.push({
            level: "warn",
            path,
            message: `${entry.status} past review_by ${entry.review_by} — re-review or the registry decays`,
          });
        }
      }
    }
  }
  return issues;
}

/**
 * Cross-capture disagreement: two captures for the same field that differ on
 * nullable or enum candidates is a real question, not a validator bug.
 */
export function checkCrossCaptureAgreement(
  registry: Registry,
  skeletons: ReadonlyMap<string, unknown>,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const name of Object.keys(registry.fields ?? {})) {
    const observed: Array<{
      capture: string;
      nullable: unknown;
      enum: string[];
    }> = [];
    for (const skeleton of skeletons.values()) {
      for (const [captureId, def] of Object.entries(
        registry.captureSets ?? {},
      )) {
        if (skeletons.get(captureId) !== skeleton) continue;
        const skeletonPath =
          typeof def.skeletonPath === "string" ? def.skeletonPath : "";
        const node = resolveJsonPath(skeleton, `${skeletonPath}.${name}`) as
          { nullable?: unknown; enumCandidates?: unknown } | undefined;
        if (node && typeof node === "object") {
          observed.push({
            capture: captureId,
            nullable: node.nullable,
            enum: Array.isArray(node.enumCandidates)
              ? [...node.enumCandidates].map(String).sort()
              : [],
          });
        }
      }
    }
    if (observed.length < 2) continue;
    const first = observed[0]!;
    for (const other of observed.slice(1)) {
      if (
        other.nullable !== first.nullable ||
        other.enum.join(",") !== first.enum.join(",")
      ) {
        issues.push({
          level: "warn",
          path: `$.fields.${name}`,
          message: `captures disagree (${first.capture} vs ${other.capture}) on nullable/enum — surface, do not pick a winner`,
        });
      }
    }
  }
  return issues;
}

export interface ValidationResult {
  readonly fails: readonly ContractIssue[];
  readonly warns: readonly ContractIssue[];
}

/** Filesystem wrapper: verify the citation (path + sha256), then shape-check. */
export async function validateWagersFieldContract(
  registryPath = "schema/wagers_field_contract.json",
  options: { readonly now?: Date | undefined } = {},
): Promise<ValidationResult> {
  const issues: ContractIssue[] = [];
  let registry: Registry;
  try {
    registry = (await Bun.file(registryPath).json()) as Registry;
  } catch (e) {
    return {
      fails: [
        {
          level: "fail",
          path: registryPath,
          message: `cannot read registry: ${(e as Error).message}`,
        },
      ],
      warns: [],
    };
  }

  const skeletons = new Map<string, unknown>();
  for (const [captureId, def] of Object.entries(registry.captureSets ?? {})) {
    const capturePath = typeof def.path === "string" ? def.path : "";
    const file = Bun.file(resolve(capturePath));
    if (!(await file.exists())) {
      issues.push({
        level: "fail",
        path: `$.captureSets.${captureId}.path`,
        message: `cited capture missing: ${capturePath}`,
      });
      continue;
    }
    const bytes = await file.bytes();
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (typeof def.sha256 !== "string" || sha !== def.sha256) {
      issues.push({
        level: "fail",
        path: `$.captureSets.${captureId}.sha256`,
        message: `capture sha256 drifted (registry ${String(def.sha256)}, actual ${sha})`,
      });
      continue;
    }
    skeletons.set(captureId, JSON.parse(new TextDecoder().decode(bytes)));
  }

  issues.push(...checkRegistryShape(registry, { now: options.now, skeletons }));
  issues.push(...checkCrossCaptureAgreement(registry, skeletons));

  return {
    fails: issues.filter((i) => i.level === "fail"),
    warns: issues.filter((i) => i.level === "warn"),
  };
}

if (import.meta.main) {
  const { fails, warns } = await validateWagersFieldContract();
  for (const issue of warns) console.warn(`… ${issue.path}: ${issue.message}`);
  for (const issue of fails) console.error(`✗ ${issue.path}: ${issue.message}`);
  if (fails.length > 0) {
    console.error(
      `✗ ${fails.length} contract failure(s), ${warns.length} warning(s)`,
    );
    process.exit(1);
  }
  console.log(`✓ wagers field contract valid (${warns.length} warning(s))`);
}
