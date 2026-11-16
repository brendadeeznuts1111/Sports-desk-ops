/**
 * Clipboard writes that cannot produce an unhandled rejection.
 *
 * `void navigator.clipboard.writeText(x)` silences the lint rule, not the promise: when the browser
 * denies the write — no permission, no user gesture, unfocused document, insecure context — the
 * rejection surfaces as an unhandled runtime error in the console and, in the harness, as a
 * runtime-error panel. A copy button failing is a non-event; a copy button failing loudly is a bug.
 *
 * Returns whether the copy succeeded so a caller MAY show feedback, but no caller has to: failure is
 * silent by default, which is the correct prominence for a failed copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined)
      return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
