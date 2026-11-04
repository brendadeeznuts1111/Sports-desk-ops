/**
 * Zod-backed JSON guards.
 *
 * The fleet policy (`zod-not-guard-calls` / `zod-not-guard-helpers`) asks for Zod at the boundary
 * instead of ad-hoc `typeof` chains. These are the small primitives the desk modules and their
 * tests parse captured JSON with: the schema owns the check, and a failed `parse` throws a Zod
 * issue instead of a bespoke message. `isRecordValue` keeps the type-predicate shape so existing
 * `if (!isRecordValue(value))` narrowing stays readable.
 */
import { z } from "zod";

/** A JSON object: arrays, null and primitives are rejected. */
export const JsonRecord = z.record(z.string(), z.unknown());
export const JsonArray = z.array(z.unknown());

export function isRecordValue(
  value: unknown,
): value is Record<string, unknown> {
  return JsonRecord.safeParse(value).success;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return JsonRecord.parse(value);
}

export function arrayValue(value: unknown): readonly unknown[] {
  return JsonArray.parse(value);
}

export function stringValue(value: unknown): string {
  return z.string().parse(value);
}

export function numberValue(value: unknown): number {
  return z.number().parse(value);
}

export function booleanValue(value: unknown): boolean {
  return z.boolean().parse(value);
}
