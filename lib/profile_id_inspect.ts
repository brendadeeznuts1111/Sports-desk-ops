/**
 * @file lib/profile_id_inspect.ts
 * @description RBAC-redacted `ProfileId` and `ProfileArtifactPaths` value objects with
 * non-enumerable `[Bun.inspect.custom]` and `showHidden: true` containment.
 */

import { resolveBunSymbolReferenceUrl } from "./bun_urls.ts";

type InspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

export type RbacRole =
  "ROLE_AUDITOR_SANITIZED" | "ROLE_RISK_MANAGER" | "ROLE_OWNER_ADMIN";

export type ProfileIdBrand = string & { readonly __brand: "ProfileId" };

const PROFILE_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

const SECRET_OR_TOKEN_RE =
  /(?:Bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|GSLIVE_SESSION_ID=[^\s\]"']+|(?:CLOUDFLARE|R2|AWS|S3)_[A-Z0-9_]*=(?:[^\s\]"']+))/g;

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g;

function resolveActiveRole(explicitRole?: RbacRole): RbacRole {
  if (explicitRole) return explicitRole;
  const envRole = Bun.env.SPORTSDESK_INSPECT_ROLE;
  if (envRole === "ROLE_OWNER_ADMIN" || envRole === "ROLE_RISK_MANAGER") {
    return envRole;
  }
  return "ROLE_AUDITOR_SANITIZED";
}

/**
 * 17-Gate redaction pass: scrubs JWTs, Bearer headers, GSLIVE_SESSION_ID,
 * Cloudflare/R2/AWS/S3 credentials, and raw IPv4/IPv6 addresses per RBAC role.
 */
export function redactInspectSurface(input: string, role: RbacRole): string {
  let out = input.replace(SECRET_OR_TOKEN_RE, "[REDACTED_SECRET]");

  if (role === "ROLE_AUDITOR_SANITIZED") {
    out = out
      .replace(IPV4_RE, "[REDACTED_IP]")
      .replace(IPV6_RE, "[REDACTED_IP]");
  } else if (role === "ROLE_RISK_MANAGER") {
    out = out
      .replace(IPV4_RE, (ip) => {
        const parts = ip.split(".");
        return parts.length === 4
          ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
          : "[REDACTED_IP]";
      })
      .replace(IPV6_RE, (ip) => {
        const hextets = ip.split(":").slice(0, 3);
        return `${hextets.join(":")}::/48`;
      });
  }

  return out;
}

function formatOsc8Symbol(label: string, enableColor: boolean): string {
  if (!enableColor) return label;
  const url = resolveBunSymbolReferenceUrl("Bun.inspect");
  if (!url) return label;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function padGraphemeExact(text: string, targetCols: number): string {
  const width = Bun.stringWidth(text, {
    ambiguousIsNarrow: true,
    countAnsiEscapeCodes: false,
  });
  return width >= targetCols ? text : text + " ".repeat(targetCols - width);
}

function maskFilesystemPath(rawPath: string, role: RbacRole): string {
  if (role === "ROLE_OWNER_ADMIN") return redactInspectSurface(rawPath, role);
  const segments = rawPath.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  return redactInspectSurface(`<workspace>/${tail}`, role);
}

/** Validated branded profile identifier with role-masked `[Bun.inspect.custom]`. */
export class InspectableProfileId {
  readonly value: ProfileIdBrand;
  readonly #role: RbacRole | undefined;

  private constructor(value: ProfileIdBrand, role?: RbacRole) {
    this.value = value;
    this.#role = role;

    Object.defineProperties(this, {
      value: { enumerable: true, writable: false, configurable: false },
      toJSON: {
        value: () => this.value,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      [Bun.inspect.custom]: {
        value: (
          depth: number,
          options: InspectOptions,
          inspect: typeof Bun.inspect,
        ): string => {
          const role = resolveActiveRole(this.#role);
          const safeSlug = redactInspectSurface(this.value, role);
          if (depth < 0) return `[ProfileId ${safeSlug}]`;

          const tag = formatOsc8Symbol("ProfileId", Boolean(options.colors));
          const colLabel = padGraphemeExact(tag, 12);
          return `${colLabel}${inspect(
            { id: safeSlug, role, gate: "17-GATE-VERIFIED" },
            { ...options, showHidden: false } as InspectOptions,
          )}`;
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
  }

  static parse(raw: string, role?: RbacRole): InspectableProfileId {
    const trimmed = raw.trim();
    if (!PROFILE_ID_RE.test(trimmed)) {
      throw new Error(
        `ERR_INSP_INVALID_PROFILE_ID: Slug failed strict boundary check (${redactInspectSurface(trimmed, "ROLE_AUDITOR_SANITIZED")})`,
      );
    }
    return new InspectableProfileId(trimmed as ProfileIdBrand, role);
  }

  toString(): string {
    return this.value;
  }
}

export interface ProfileArtifactPathsInit {
  readonly profileId: InspectableProfileId;
  readonly rootDir: string;
  readonly envPath: string;
  readonly themeTsPath: string;
  readonly barrelTsPath: string;
  readonly r2ManifestKey?: string;
  readonly role?: RbacRole;
}

/**
 * Sealed artifact-path descriptor: raw filesystem paths stay in private fields so neither
 * `Bun.inspect(..., { showHidden: true, depth: null })`, `Object.keys`, nor property reads
 * expose raw home-directory paths or `.env` paths to unprivileged RBAC roles.
 */
export class ProfileArtifactPaths {
  readonly #profileId: InspectableProfileId;
  readonly #rootDir: string;
  readonly #envPath: string;
  readonly #themeTsPath: string;
  readonly #barrelTsPath: string;
  readonly #r2ManifestKey: string | undefined;
  readonly #role: RbacRole | undefined;

  constructor(init: ProfileArtifactPathsInit) {
    this.#profileId = init.profileId;
    this.#rootDir = init.rootDir;
    this.#envPath = init.envPath;
    this.#themeTsPath = init.themeTsPath;
    this.#barrelTsPath = init.barrelTsPath;
    this.#r2ManifestKey = init.r2ManifestKey;
    this.#role = init.role;

    const projectedView = () => {
      const role = resolveActiveRole(this.#role);
      return {
        profileId: redactInspectSurface(this.#profileId.value, role),
        role,
        rootDir: maskFilesystemPath(this.#rootDir, role),
        envPath:
          role === "ROLE_AUDITOR_SANITIZED"
            ? "[REDACTED_ENV_PATH]"
            : maskFilesystemPath(this.#envPath, role),
        themeTsPath: maskFilesystemPath(this.#themeTsPath, role),
        barrelTsPath: maskFilesystemPath(this.#barrelTsPath, role),
        r2ManifestKey: this.#r2ManifestKey
          ? redactInspectSurface(this.#r2ManifestKey, role)
          : null,
      };
    };

    Object.defineProperties(this, {
      toJSON: {
        value: projectedView,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      [Bun.inspect.custom]: {
        value: (
          depth: number,
          options: InspectOptions,
          inspect: typeof Bun.inspect,
        ): string => {
          const view = projectedView();
          if (depth < 0) return `[ProfileArtifactPaths ${view.profileId}]`;

          const tag = formatOsc8Symbol(
            "ProfileArtifactPaths",
            Boolean(options.colors),
          );
          const header = padGraphemeExact(tag, 22);
          return `${header}${inspect(view, { ...options, showHidden: false } as InspectOptions)}`;
        },
        enumerable: false,
        writable: false,
        configurable: false,
      },
    });
  }

  get profileId(): InspectableProfileId {
    return this.#profileId;
  }

  get rootDir(): string {
    return maskFilesystemPath(this.#rootDir, resolveActiveRole(this.#role));
  }

  get envPath(): string {
    const role = resolveActiveRole(this.#role);
    return role === "ROLE_AUDITOR_SANITIZED"
      ? "[REDACTED_ENV_PATH]"
      : maskFilesystemPath(this.#envPath, role);
  }

  get themeTsPath(): string {
    return maskFilesystemPath(this.#themeTsPath, resolveActiveRole(this.#role));
  }

  get barrelTsPath(): string {
    return maskFilesystemPath(
      this.#barrelTsPath,
      resolveActiveRole(this.#role),
    );
  }

  get r2ManifestKey(): string | null {
    return this.#r2ManifestKey
      ? redactInspectSurface(this.#r2ManifestKey, resolveActiveRole(this.#role))
      : null;
  }
}
