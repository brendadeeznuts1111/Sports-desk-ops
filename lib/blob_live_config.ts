/**
 * @file lib/blob_live_config.ts
 * @description Loads `config/blob-live.yaml` with `Bun.YAML.parse` and validates it.
 */

import { z } from "zod";

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
    channels: z
      .array(z.string().regex(/^[a-z0-9-]{1,32}$/, "invalid channel"))
      .min(1)
      .refine((channels) => new Set(channels).size === channels.length, {
        message: "duplicate channel",
      }),
    bucket: z.string().min(3),
    manifest_prefix: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/,
        "invalid manifest_prefix",
      ),
  })
  .strict();

export type BlobLiveConfig = z.infer<typeof blobLiveConfigSchema>;

export function parseBlobLiveConfig(
  text: string,
  source = BLOB_LIVE_CONFIG_PATH,
): BlobLiveConfig {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (cause) {
    throw new BlobLiveConfigInvalid(`${source}: not valid YAML`, { cause });
  }
  const parsed = blobLiveConfigSchema.safeParse(raw);
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

export async function loadBlobLiveConfig(
  path = BLOB_LIVE_CONFIG_PATH,
): Promise<BlobLiveConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new BlobLiveConfigInvalid(`${path}: not found`);
  }
  return parseBlobLiveConfig(await file.text(), path);
}
