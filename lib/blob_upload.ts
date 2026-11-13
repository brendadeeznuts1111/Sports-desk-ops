/**
 * @file blob_upload.ts
 * @description Client for the hardened blob gateway: upload a screenshot through
 * `PUT /api/v1/blobs/{key}` (the gateway transcodes to WebP, capped at 1280px with no
 * upscaling) and verify the stored object via `GET ?download=1`.
 */

import { z } from "zod";

import { R2_SECRETS_SERVICE } from "./r2_s3_client.ts";
import { getSecretBounded } from "./secrets.ts";

export const DEFAULT_BLOB_GATEWAY_URL = "http://127.0.0.1:4021";
const IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
] as const;
const BLOB_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const uploadResponseSchema = z.object({
  key: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  placeholder: z.string().startsWith("data:image/png;base64,"),
});

export interface ScreenshotBlobUploadOptions {
  readonly gatewayUrl?: string;
  readonly apiToken?: string;
  readonly key?: string;
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface ScreenshotBlobUploadResult {
  readonly key: string;
  readonly objectKey: string;
  readonly bytesWritten: number;
  readonly width: number;
  readonly height: number;
  /** ThumbHash LQIP data URL returned by the gateway. */
  readonly placeholder: string;
  readonly url: string;
}

export async function resolveBlobApiToken(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<string> {
  const configured = env.BLOB_API_TOKEN?.trim();
  if (configured !== undefined && configured !== "") return configured;
  try {
    const stored = await getSecretBounded(Bun.secrets, {
      service: R2_SECRETS_SERVICE,
      name: "BLOB_API_TOKEN",
    });
    return stored?.trim() ?? "";
  } catch {
    // Locked or timed-out keychain falls back to empty token.
    return "";
  }
}

export function resolveBlobGatewayUrl(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const configured = env.BLOB_GATEWAY_URL?.trim();
  if (configured !== undefined && configured !== "") {
    return configured.replace(/\/+$/, "");
  }
  const port = env.BLOB_PORT?.trim();
  return port === undefined || port === ""
    ? DEFAULT_BLOB_GATEWAY_URL
    : `http://127.0.0.1:${port}`;
}

/** A gateway-valid key derived from a screenshot filename, with a timestamp fallback. */
export function blobKeyFromPath(
  path: string,
  fallback = `screenshot-${Date.now()}`,
): string {
  const stem = path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return stem === "" || !BLOB_KEY_RE.test(stem) ? fallback : stem;
}

function errorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function uploadScreenshotToGateway(
  bytes: Uint8Array,
  contentType: string,
  options: ScreenshotBlobUploadOptions = {},
): Promise<ScreenshotBlobUploadResult> {
  const base = (options.gatewayUrl ?? resolveBlobGatewayUrl()).replace(
    /\/+$/,
    "",
  );
  const token = (options.apiToken ?? (await resolveBlobApiToken())).trim();
  if (token === "") throw new Error("BLOB_API_TOKEN is not set");
  if (
    !IMAGE_CONTENT_TYPES.includes(
      contentType as (typeof IMAGE_CONTENT_TYPES)[number],
    )
  ) {
    throw new Error(`unsupported screenshot content type: ${contentType}`);
  }
  const key = options.key ?? `screenshot-${Date.now()}`;
  if (!BLOB_KEY_RE.test(key)) throw new Error("invalid blob key");
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(`${base}/api/v1/blobs/${key}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
    },
    body: bytes,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = errorCode(body);
    throw new Error(
      `blob upload failed (HTTP ${response.status}${code === undefined ? "" : ` ${code}`})`,
    );
  }
  const parsed = uploadResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("blob gateway returned an invalid upload response");
  }

  const verify = await fetchImpl(`${base}/api/v1/blobs/${key}?download=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!verify.ok) {
    throw new Error(`blob verification failed (HTTP ${verify.status})`);
  }
  const verifiedType = verify.headers.get("content-type") ?? "";
  if (!verifiedType.startsWith("image/webp")) {
    throw new Error(`blob verification returned ${verifiedType || "no type"}`);
  }
  const verifiedBytes = new Uint8Array(await verify.arrayBuffer());
  if (verifiedBytes.byteLength === 0) {
    throw new Error("blob verification returned an empty body");
  }

  return {
    key,
    objectKey: parsed.data.key,
    bytesWritten: parsed.data.bytesWritten,
    width: parsed.data.width,
    height: parsed.data.height,
    placeholder: parsed.data.placeholder,
    url: `${base}/api/v1/blobs/${key}`,
  };
}
