/**
 * `Bun.Image` rejection codes, per https://bun.com/reference/globals/bun/Image/ErrorCode.
 *
 * `Bun.Image.ErrorCode` plus `ERR_OUT_OF_MEMORY`: the reference lists seven codes, the bun-types
 * 1.4.4 declarations six (tests/bun_capabilities.test.ts trips when they catch up).
 */
export type ImageErrorCode = Bun.Image.ErrorCode | "ERR_OUT_OF_MEMORY";

const IMAGE_ERROR_CODES: ReadonlySet<string> = new Set<ImageErrorCode>([
  "ERR_IMAGE_FORMAT_UNSUPPORTED",
  "ERR_IMAGE_TOO_MANY_PIXELS",
  "ERR_IMAGE_DECODE_FAILED",
  "ERR_IMAGE_ENCODE_FAILED",
  "ERR_IMAGE_UNKNOWN_FORMAT",
  "ERR_OUT_OF_MEMORY",
  "ERR_INVALID_STATE",
]);

function isImageErrorCode(code: unknown): code is ImageErrorCode {
  return typeof code === "string" && IMAGE_ERROR_CODES.has(code);
}

/**
 * The `Bun.Image` code on a terminal's rejection, or on the `cause` of an error that wrapped one;
 * `undefined` for anything else, syscall codes (`ENOENT`, `EACCES`) included.
 */
export function imageErrorCode(error: unknown): ImageErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  if ("code" in error && isImageErrorCode(error.code)) return error.code;
  return error.cause === undefined ? undefined : imageErrorCode(error.cause);
}
