/**
 * @file src/lib/bun_doc_linker.ts
 * @description Construct 40-char commit-SHA-pinned Bun documentation URLs using `Bun.revision`.
 */

import { osc8Link } from "./terminal_links.ts";

export const BUN_UTILS_DOC_PATH = "docs/runtime/utils.mdx" as const;

/** Build a GitHub blob URL pinned to a verified 40-char commit SHA (defaulting to `Bun.revision`). */
export function buildRuntimePinnedDocUrl(
  docPath: string,
  sectionTextFragment?: string,
  commitSha: string = Bun.revision,
): URL {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("ERR_SPEC_INVALID_BLOB_SHA");
  }
  const url = new URL(
    `https://github.com/oven-sh/bun/blob/${commitSha}/${docPath.replace(/^\/+/, "")}`,
  );
  if (sectionTextFragment) {
    url.hash = `:~:text=${encodeURIComponent(sectionTextFragment)}`;
  }
  return url;
}

/** Format a clickable terminal reference to a `Bun` utility symbol pinned to the active runtime revision. */
export function formatBunUtilReference(
  symbolName: string,
  docPath: string = BUN_UTILS_DOC_PATH,
): string {
  const url = buildRuntimePinnedDocUrl(docPath, symbolName);
  return osc8Link(url, `${symbolName} (${Bun.version})`);
}
