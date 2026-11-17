/**
 * @file lib/manager_bundle.ts
 * @description Read the manager bundle version from page source and compare it to the pin.
 * The footer renders `<span data-field="version">1.0.287</span>`; the pin stays unchanged until a
 * capture exercises the new bundle, so drift is a measurement, not an auto-bump.
 */

export interface ManagerBundleDrift {
  readonly observed: string;
  readonly pinned: string;
  readonly drift: boolean;
}

const VERSION_FIELD =
  /data-field\s*=\s*["']version["'][^>]*>\s*([0-9]+\.[0-9]+\.[0-9]+)/i;

export function parseManagerBundleVersion(html: string): string | null {
  const match = VERSION_FIELD.exec(html);
  return match?.[1] ?? null;
}

export function managerBundleDrift(
  html: string,
  pinned: string,
): ManagerBundleDrift | null {
  const observed = parseManagerBundleVersion(html);
  if (observed === null) return null;
  return { observed, pinned: pinned.trim(), drift: observed !== pinned.trim() };
}
