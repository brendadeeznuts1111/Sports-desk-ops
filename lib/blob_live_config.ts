/**
 * @file lib/blob_live_config.ts
 * @description Loads `config/blob-live.yaml` via Bun's yaml import loader and validates it.
 */

import { z } from "zod";

import raw from "../config/blob-live.yaml";
import { liveStreamIdSchema } from "./r2_chunk_manifest.ts";

export const BLOB_LIVE_CONFIG_PATH = "config/blob-live.yaml";

export class BlobLiveConfigInvalid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobLiveConfigInvalid";
  }
}

export const blobLiveConfigSchema = z
  .object({
    port: z.number().int().min(0).max(65535),
    hostname: z.string().min(1),
    streams: z
      .array(liveStreamIdSchema)
      .min(1)
      .refine((streams) => new Set(streams).size === streams.length, {
        message: "duplicate stream_id",
      }),
  })
  .strict();

export type BlobLiveConfig = z.infer<typeof blobLiveConfigSchema>;

function validateBlobLiveConfig(
  value: unknown,
  source = BLOB_LIVE_CONFIG_PATH,
): BlobLiveConfig {
  const parsed = blobLiveConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new BlobLiveConfigInvalid(`${source}: ${issues}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function parseBlobLiveConfig(
  text: string,
  source = BLOB_LIVE_CONFIG_PATH,
): BlobLiveConfig {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (cause) {
    throw new BlobLiveConfigInvalid(`${source}: not valid YAML`, { cause });
  }
  return validateBlobLiveConfig(parsed, source);
}

export function loadBlobLiveConfig(): BlobLiveConfig {
  return validateBlobLiveConfig(raw, BLOB_LIVE_CONFIG_PATH);
}
