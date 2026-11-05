/**
 * @fileoverview Evaluate the `if:` guard of a GitHub Actions step for a locally simulated event.
 *
 * `ci:local` replays the workflow's `run:` steps, but a step guarded by
 * `if: github.event_name == 'schedule'` must not run on a push-like replay: the CDN pin is the
 * live-origin example. This module keeps that decision pure so it can be tested without running
 * the workflow.
 *
 * Only the shapes this repository uses are interpreted: `always()`, an event equality/inequality
 * comparison, and a `${{ … }}` wrapper. An unknown expression returns `true`; skipping a step the
 * workflow would run would silently weaken the local gate.
 */

/** Events a local replay can simulate; GitHub has more, but these are the ones the workflow names. */
export const WORKFLOW_EVENTS = [
  "push",
  "pull_request",
  "schedule",
  "workflow_dispatch",
] as const;

export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

const EVENT_NAME = /github\.event_name\s*(==|!=)\s*['"]([^'"]+)['"]/g;

/**
 * Should a step with this `if:` run for `event`?
 *
 * - absent/empty or `always()` → yes
 * - `event_name == 'a' || event_name == 'b'` → yes for `a`/`b`
 * - `event_name != 'a'` → yes for everything except `a`
 * - no `github.event_name` reference → yes (for example `if: runner.os == 'Linux'`)
 */
export function stepMatchesEvent(
  condition: string | undefined,
  event: string,
): boolean {
  if (condition === undefined || condition.trim() === "") return true;
  if (/\balways\s*\(\s*\)/.test(condition)) return true;

  const equalities = new Set<string>();
  const inequalities = new Set<string>();
  for (const match of condition.matchAll(EVENT_NAME)) {
    const [, operator, name] = match;
    if (operator === "==") equalities.add(name as string);
    else inequalities.add(name as string);
  }

  if (equalities.size === 0 && inequalities.size === 0) return true;
  if (inequalities.has(event)) return false;
  if (equalities.size === 0) return true;
  return equalities.has(event);
}
