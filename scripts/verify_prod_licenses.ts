#!/usr/bin/env bun
/**
 * @file scripts/verify_prod_licenses.ts
 * @description Fail-closed CI gate for `bun pm licenses --json --prod`.
 *
 * Run: bun run scripts/verify_prod_licenses.ts
 */

export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
]);

// Pin non-permissive / custom licenses to specific audited packages
// rather than globally allowlisting copyleft or custom license strings.
export const PACKAGE_LICENSE_EXCEPTIONS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["elkjs", new Set(["EPL-2.0", "EPL-2.0 OR GPL-3.0-or-later"])],
  ["diffusion", new Set(["LGPL-3.0+"])],
  ["@ganchrowsci/gs-sdk", new Set(["SEE LICENSE IN LICENSE"])],
]);

export interface LicenseEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface StaleException {
  readonly name: string;
  readonly license: string;
}

export interface AuditResult {
  readonly ok: boolean;
  readonly errorCode:
    | null
    | "ERR_OPS_LICENSE_EMPTY_RESULT"
    | "ERR_OPS_LICENSE_DISALLOWED"
    | "ERR_OPS_LICENSE_STALE_EXCEPTION";
  readonly totalPackages: number;
  readonly activeExceptionPackages: number;
  readonly violations: LicenseEntry[];
  readonly staleExceptions: StaleException[];
}

export function normalizeEntries(raw: unknown): LicenseEntry[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const rec = (item && typeof item === "object" ? item : {}) as Record<
        string,
        unknown
      >;
      const version = Array.isArray(rec.versions)
        ? rec.versions.map(String).join(",")
        : String(rec.version ?? "");
      return {
        name: String(rec.name ?? ""),
        version,
        license: String(rec.license ?? "UNKNOWN").trim(),
      };
    });
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.packages)) {
      return normalizeEntries(obj.packages);
    }

    const entries: LicenseEntry[] = [];
    for (const [key, value] of Object.entries(obj)) {
      // `bun pm licenses --json` groups packages by license key: { "MIT": [{ name, versions, license }] }.
      if (Array.isArray(value)) {
        for (const item of value) {
          const rec = (item && typeof item === "object" ? item : {}) as Record<
            string,
            unknown
          >;
          const version = Array.isArray(rec.versions)
            ? rec.versions.map(String).join(",")
            : String(rec.version ?? "");
          entries.push({
            name: String(rec.name ?? ""),
            version,
            license: String(rec.license ?? key).trim(),
          });
        }
        continue;
      }

      const rec = (value && typeof value === "object" ? value : {}) as Record<
        string,
        unknown
      >;
      const atIdx = key.lastIndexOf("@");
      const name = String(rec.name ?? (atIdx > 0 ? key.slice(0, atIdx) : key));
      const version = String(
        rec.version ?? (atIdx > 0 ? key.slice(atIdx + 1) : ""),
      );
      const license = String(
        typeof value === "string" ? value : (rec.license ?? "UNKNOWN"),
      ).trim();
      entries.push({ name, version, license });
    }
    return entries;
  }

  return [];
}

export function auditLicenses(
  raw: unknown,
  allowedLicenses: ReadonlySet<string> = ALLOWED_LICENSES,
  exceptions: ReadonlyMap<
    string,
    ReadonlySet<string>
  > = PACKAGE_LICENSE_EXCEPTIONS,
): AuditResult {
  const entries = normalizeEntries(raw);
  if (entries.length === 0) {
    return {
      ok: false,
      errorCode: "ERR_OPS_LICENSE_EMPTY_RESULT",
      totalPackages: 0,
      activeExceptionPackages: 0,
      violations: [],
      staleExceptions: [],
    };
  }

  const violations: LicenseEntry[] = [];
  // Track matched (package, license) exception pairs so unused pins are flagged.
  const usedExceptions = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (allowedLicenses.has(entry.license)) continue;

    const pkgAllowed = exceptions.get(entry.name);
    if (pkgAllowed?.has(entry.license)) {
      let matched = usedExceptions.get(entry.name);
      if (!matched) {
        matched = new Set<string>();
        usedExceptions.set(entry.name, matched);
      }
      matched.add(entry.license);
      continue;
    }

    violations.push(entry);
  }

  const staleExceptions: StaleException[] = [];
  for (const [pkgName, allowedSet] of exceptions) {
    const matched = usedExceptions.get(pkgName);
    for (const license of allowedSet) {
      if (!matched?.has(license)) {
        staleExceptions.push({ name: pkgName, license });
      }
    }
  }

  const ok = violations.length === 0 && staleExceptions.length === 0;
  const errorCode =
    violations.length > 0
      ? "ERR_OPS_LICENSE_DISALLOWED"
      : staleExceptions.length > 0
        ? "ERR_OPS_LICENSE_STALE_EXCEPTION"
        : null;

  return {
    ok,
    errorCode,
    totalPackages: entries.length,
    activeExceptionPackages: usedExceptions.size,
    violations,
    staleExceptions,
  };
}

export function runCli(spawnFn: typeof Bun.spawnSync = Bun.spawnSync): number {
  const proc = spawnFn({
    cmd: [process.execPath, "pm", "licenses", "--json", "--prod"],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    console.error(
      `ERR_OPS_LICENSE_CMD_FAILED: bun pm licenses exited with code ${proc.exitCode}`,
    );
    const stderr = proc.stderr.toString().trim();
    if (stderr) console.error(stderr);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout.toString());
  } catch (err) {
    console.error(`ERR_OPS_LICENSE_JSON_INVALID: ${(err as Error).message}`);
    return 1;
  }

  const result = auditLicenses(parsed);

  if (result.errorCode === "ERR_OPS_LICENSE_EMPTY_RESULT") {
    console.error(
      "ERR_OPS_LICENSE_EMPTY_RESULT: 0 production packages parsed (fail-closed).",
    );
    return 1;
  }

  if (result.violations.length > 0) {
    console.error(
      `ERR_OPS_LICENSE_DISALLOWED: ${result.violations.length} production package(s) outside allowlist:`,
    );
    for (const v of result.violations) {
      console.error(`  - ${v.name}@${v.version}: ${v.license}`);
    }
  }

  if (result.staleExceptions.length > 0) {
    console.error(
      `ERR_OPS_LICENSE_STALE_EXCEPTION: ${result.staleExceptions.length} pinned exception(s) no longer present in --prod:`,
    );
    for (const s of result.staleExceptions) {
      console.error(`  - ${s.name}: ${s.license}`);
    }
  }

  if (!result.ok) return 1;

  console.log(
    `OK: ${result.totalPackages} production package(s) verified against license allowlist (${result.activeExceptionPackages} active package exception(s), 0 stale).`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(runCli());
}
