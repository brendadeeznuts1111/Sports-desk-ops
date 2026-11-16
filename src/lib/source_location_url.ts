/**
 * @file src/lib/source_location_url.ts
 * @description Local source deep-link builders and editor openers using `Bun.pathToFileURL`, `Bun.fileURLToPath`, and `Bun.openInEditor`.
 */

const FORBIDDEN_DATA_EXT = /\.(?:json|jsonl|sqlite|dodbin)$/i;

function parsePositiveIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Convert an absolute source path + line/column metadata into a `file://` URL, blocking data snapshot extensions. */
export function createSourceLocationUrl(
  absPath: string,
  line = 1,
  column = 1,
): URL {
  if (FORBIDDEN_DATA_EXT.test(absPath)) {
    throw new Error("ERR_OPS_LOCAL_JSON_FORBIDDEN");
  }
  const fileUrl = Bun.pathToFileURL(absPath);
  fileUrl.searchParams.set("line", String(line));
  fileUrl.searchParams.set("column", String(column));
  return fileUrl;
}

/** Open a `file://` location URL in the editor after stripping query metadata for `Bun.fileURLToPath`. */
export function openSourceLocationUrl(
  locationUrl: URL,
  openInEditor: (
    path: string,
    opts?: { readonly line?: number; readonly column?: number },
  ) => void = Bun.openInEditor,
): void {
  if (locationUrl.protocol !== "file:") {
    throw new Error(`Expected file: URL, got ${locationUrl.protocol}`);
  }
  const line = parsePositiveIntParam(locationUrl.searchParams.get("line"), 1);
  const column = parsePositiveIntParam(
    locationUrl.searchParams.get("column"),
    1,
  );

  const cleanUrl = new URL(locationUrl.href);
  cleanUrl.search = "";
  const filePath = Bun.fileURLToPath(cleanUrl);

  openInEditor(filePath, { line, column });
}
