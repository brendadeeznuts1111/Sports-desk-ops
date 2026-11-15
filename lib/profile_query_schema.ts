/**
 * @file lib/profile_query_schema.ts
 * @description The frozen argument contract for the profile Code Mode tools.
 *
 * This is the repository's `schema.ts`: the constants and Zod schemas the tool, the Code Mode
 * registration and the tests share. The oracle intentionally does **not** import it — it freezes
 * its own copy of `MAX_LIMIT` so an accidental schema edit cannot silently move the specification.
 */

import { z } from "zod";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = MAX_LIMIT;

export const PROFILE_FIELDS = ["clv", "vol", "sharp"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const queryProfilesArgsSchema = z.object({
  field: z.enum(PROFILE_FIELDS),
  limit: z.number().int().positive().optional(),
  includeSentinels: z.literal(true).optional(),
});

export const getProfileArgsSchema = z.object({
  id: z.string().min(1),
});

export const getSummaryArgsSchema = z.object({});
