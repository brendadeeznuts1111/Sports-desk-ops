/**
 * Clipboard writes that cannot produce an unhandled rejection, and that say why they failed.
 *
 * `void navigator.clipboard.writeText(x)` silences the lint rule, not the promise: when the browser
 * denies the write the rejection surfaces as an unhandled runtime error.
 *
 * As of Bun 1.4.4 — the version pinned in `.bun-version` — Bun documents no text-clipboard API
 * (`writeText` and `readText` both return no results in the docs index; `Bun.Image.fromClipboard`
 * is read-only and image-only). That snapshot is not load-bearing: the failing context is a
 * browser page, where `navigator.clipboard` is the standard, permission-policed API, so a future
 * `Bun.clipboard` would not change this guard.
 *
 * Failure is a typed result rather than a boolean because the reasons need different words — a page
 * served over plain HTTP cannot copy at all, while a permission denial is a transient browser
 * decision. A boolean forces every caller to show the same generic message.
 */

export type CopyFailure =
  /** No `navigator` at all — a Bun/test context, or a very old runtime. */
  | "runtime-unavailable"
  /** `navigator` exists but `clipboard` does not: non-secure context, or Bun's reduced shim. */
  | "clipboard-unavailable"
  /** The write was refused: no permission, no user activation, or an unfocused document. */
  | "permission-denied";

export type CopyResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: CopyFailure };

export async function copyText(text: string): Promise<CopyResult> {
  if (typeof navigator === "undefined") {
    console.warn(
      "copyText: no navigator — copy is unavailable outside a browser page",
    );
    return { ok: false, reason: "runtime-unavailable" };
  }
  if (navigator.clipboard === undefined) {
    console.warn(
      "copyText: navigator.clipboard is missing — a secure context (https or localhost) is required",
    );
    return { ok: false, reason: "clipboard-unavailable" };
  }
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    console.warn("copyText: the browser blocked the write", error);
    return { ok: false, reason: "permission-denied" };
  }
}
