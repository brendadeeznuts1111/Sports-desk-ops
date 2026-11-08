/**
 * @file lib/doc_template_hydrator.ts
 * @description Secure template hydration and sentinel safety utilities for Google Docs templates.
 * Enforces zero CLI parameter leakage (process table / history safety), secret redaction,
 * deterministic key sorting, collision-free delimiter selection, and strict sentinel verification.
 */

export interface SentinelCheckResult {
  /** True if the content satisfies all policy constraints under the provided options. */
  valid: boolean;
  /** True if there is at least one unresolved placeholder or sentinel, regardless of allowUnresolved. */
  hasUnresolved: boolean;
  unresolvedPlaceholders: string[];
  sentinelsFound: string[];
  errors: string[];
}

export interface HydrationOptions {
  allowUnresolved?: boolean;
  strictSentinels?: boolean;
  sensitivePatterns?: RegExp[];
  /** Opt-in flag to strip fenced code blocks (```...```) before evaluating placeholders/sentinels. */
  ignoreCodeFences?: boolean;
}

/** Non-global regex matching single {{KEY}} or {{KEY:MODIFIER}} placeholder. */
export const PLACEHOLDER_REGEX = /\{\{([A-Za-z0-9_:-]+)\}\}/;

/** Non-global regex matching noisy sentinel constants like SENTINEL_PLAYER_ID or ACCT-0000-MOCK. */
export const SENTINEL_REGEX =
  /\b(SENTINEL_[A-Za-z0-9_]+|ACCT-0000-[A-Za-z0-9_]+|AGENT-0000-[A-Za-z0-9_]+)\b/;

/** Strict alphanumeric key validation pattern. */
export const KEY_REGEX = /^[A-Za-z0-9_:-]+$/;

/** Comprehensive sensitive secret patterns to block leakage in documents and templates. */
export const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /Bearer\s+ey[A-Za-z0-9_.-]+/i, // JWT with Bearer prefix
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT without Bearer
  /ghp_[A-Za-z0-9]{36}/, // Classic GitHub Personal Access Token
  /github_pat_[A-Za-z0-9_]{82}/, // Fine-grained GitHub PAT
  /gh[osru]_[A-Za-z0-9]{36}/, // Other GitHub token prefixes
  /AKIA[0-9A-Z]{16}/, // AWS Access Key ID
  /AIza[0-9A-Za-z_-]{35}/, // Google API Key
  /xox[baprs]-[0-9A-Za-z_-]{10,}/, // Slack Tokens
  /sk_live_[0-9a-zA-Z]{24,}/, // Stripe Live Secret Key
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // PEM Private Key Header
];

/**
 * Strict explicit whitelist of environment variables forwarded to gdocs/gdrive subprocesses (P2/P8).
 * Enforces LANG=C and LC_ALL=C for stable output parsing; excludes unneeded OS user vars.
 */
export const SUBPROCESS_ENV_WHITELIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_LS_ADDRESS",
  "AGY_ACCOUNT",
  "GCLI_ACCESS_TOKEN",
];

/**
 * Redacts a sensitive match string for safe printing in logs.
 * e.g. "Bearer eyJhbGci..." -> "Bearer eyJhb... (len=142)"
 */
export function redactSecretMatch(match: string): string {
  if (match.length <= 12) {
    return `${match.slice(0, 4)}*** (len=${match.length})`;
  }
  const prefix = match.slice(0, 8);
  return `${prefix}... (len=${match.length})`;
}

/**
 * Builds the subprocess environment dictionary using the strict explicit whitelist and pinned locale.
 */
export function buildSubprocessEnv(
  agyAccount: string,
  sourceEnv: NodeJS.ProcessEnv = Bun.env,
): Record<string, string> {
  const result: Record<string, string> = {
    AGY_ACCOUNT: agyAccount,
  };

  for (const key of SUBPROCESS_ENV_WHITELIST) {
    const val = sourceEnv[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  // P2: Force pinned POSIX locale for stable command output parsing
  result.LANG = "C";
  result.LC_ALL = "C";

  return result;
}

/**
 * Validates text or markdown content for unhydrated placeholders, sentinels, and secrets.
 * Uses DEFAULT_SENSITIVE_PATTERNS by default so all callers inherit full secret detection.
 */
export function checkUnresolvedSentinels(
  content: string,
  options: HydrationOptions = {},
): SentinelCheckResult {
  // P7: Opt-in stripping of multi-level fenced code blocks (``` or ```` or more)
  let scanTarget = content;
  if (options.ignoreCodeFences) {
    scanTarget = content.replace(
      /^([`~]{3,})[^\n]*\r?\n[\s\S]*?\r?\n\1[`~]*/gm,
      "",
    );
  }

  const globalPlaceholderRegex = new RegExp(PLACEHOLDER_REGEX.source, "g");
  const globalSentinelRegex = new RegExp(SENTINEL_REGEX.source, "g");

  const unresolvedPlaceholders = Array.from(
    new Set([...scanTarget.matchAll(globalPlaceholderRegex)].map((m) => m[0])),
  );

  const sentinelsFound = Array.from(
    new Set([...scanTarget.matchAll(globalSentinelRegex)].map((m) => m[0])),
  );

  const hasUnresolved =
    unresolvedPlaceholders.length > 0 || sentinelsFound.length > 0;
  const errors: string[] = [];

  if (!options.allowUnresolved) {
    if (unresolvedPlaceholders.length > 0) {
      errors.push(
        `Found ${unresolvedPlaceholders.length} unresolved placeholder(s): ${unresolvedPlaceholders.join(
          ", ",
        )}`,
      );
    }
    if (options.strictSentinels !== false && sentinelsFound.length > 0) {
      errors.push(
        `Found ${sentinelsFound.length} unreplaced sentinel(s): ${sentinelsFound.join(
          ", ",
        )}`,
      );
    }
  }

  // R2: Inherit DEFAULT_SENSITIVE_PATTERNS by default
  const patterns = options.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  for (const pattern of patterns) {
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    const matches = Array.from(scanTarget.matchAll(globalPattern)).map(
      (m) => m[0],
    );
    if (matches.length > 0) {
      const redactedSamples = matches.slice(0, 3).map(redactSecretMatch);
      errors.push(
        `Found prohibited pattern match '${pattern.source}': ${redactedSamples.join(", ")}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    hasUnresolved,
    unresolvedPlaceholders,
    sentinelsFound,
    errors,
  };
}

/**
 * Chooses a delimiter character not present in either the find key or replacement value.
 * Fails closed if all candidate delimiters are exhausted (P6).
 */
export function chooseDelimiter(key: string, value: string): string {
  const candidates = ["|", "/", "~", "@", "#", "%", "!"];
  for (const c of candidates) {
    if (!key.includes(c) && !value.includes(c)) {
      return c;
    }
  }
  throw new Error(
    `Cannot safely delimit sed operation for key "${key}": value contains all candidate delimiters (${candidates.join(
      " ",
    )})`,
  );
}

/**
 * Generates lines for a gdocs sed script file from a key-value mapping.
 * Sorts keys by length descending to prevent prefix collisions (e.g. PLAYER vs PLAYER_HANDLE).
 * Uses collision-free delimiter selection per expression.
 * NOTE (V1): gdocs mutate sed treats replacement literally; & and \ are literal strings, not regex tokens.
 */
export function buildSedScript(substitutions: Record<string, string>): string {
  const lines: string[] = [
    "# Auto-generated secure gdocs hydration sed script",
    "# File contains sensitive substitutions; mode must be 0600",
  ];

  // M5: Sort keys descending by length to prevent prefix collisions
  const sortedKeys = Object.keys(substitutions).sort(
    (a, b) => b.length - a.length,
  );

  for (const key of sortedKeys) {
    if (!KEY_REGEX.test(key)) {
      throw new Error(
        `Invalid substitution key "${key}". Keys must strictly match ^[A-Za-z0-9_:-]+$`,
      );
    }

    const rawValue = substitutions[key] ?? "";
    const placeholder = `{{${key}}}`;
    const delim = chooseDelimiter(placeholder, rawValue);

    // gdocs mutate sed replaces all occurrences by default. Delimiter is dynamically isolated.
    lines.push(`s${delim}${placeholder}${delim}${rawValue}${delim}`);

    // Also replace raw KEY if key itself is a designated sentinel prefix
    if (
      key.startsWith("SENTINEL_") ||
      key.startsWith("ACCT-0000-") ||
      key.startsWith("AGENT-0000-")
    ) {
      const sentinelDelim = chooseDelimiter(key, rawValue);
      lines.push(
        `s${sentinelDelim}${key}${sentinelDelim}${rawValue}${sentinelDelim}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Parses variable inputs from JSON string or key=value environment format.
 * Validates all keys against KEY_REGEX, rejects embedded \n and \r, and enforces strict types.
 */
export function parseSubstitutionInput(input: string): Record<string, string> {
  const trimmed = input.trim();
  const result: Record<string, string> = {};

  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse substitution JSON: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Substitution JSON must be an object map of key-value pairs",
      );
    }

    for (const [k, v] of Object.entries(parsed)) {
      if (!KEY_REGEX.test(k)) {
        throw new Error(
          `Invalid substitution key "${k}". Keys must strictly match ^[A-Za-z0-9_:-]+$`,
        );
      }
      if (
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      ) {
        throw new Error(
          `Invalid value type for key "${k}": expected string, number, or boolean; received ${typeof v}`,
        );
      }
      const valStr = String(v);
      if (valStr.includes("\n") || valStr.includes("\r")) {
        throw new Error(
          `Substitution value for key "${k}" contains an embedded newline or carriage return. Multi-line replacements are not supported in sed scripts.`,
        );
      }
      result[k] = valStr;
    }
    return result;
  }

  // Parse KEY=VALUE lines
  for (const line of trimmed.split("\n")) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith("#")) continue;

    const normalized = cleaned.startsWith("export ")
      ? cleaned.slice(7).trim()
      : cleaned;

    const eqIdx = normalized.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        `Invalid variable line format (expected KEY=VALUE): "${cleaned}"`,
      );
    }

    const key = normalized.slice(0, eqIdx).trim();
    if (!KEY_REGEX.test(key)) {
      throw new Error(
        `Invalid substitution key "${key}". Keys must strictly match ^[A-Za-z0-9_:-]+$`,
      );
    }

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`Duplicate substitution key detected: "${key}"`);
    }

    let val = normalized.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (val.includes("\n") || val.includes("\r")) {
      throw new Error(
        `Substitution value for key "${key}" contains an embedded newline or carriage return. Multi-line replacements are not supported in sed scripts.`,
      );
    }

    result[key] = val;
  }

  return result;
}

// ============================================================================
// TEMPLATE KIND REGISTRY
// ============================================================================

export type DocTemplateKind =
  "spec" | "partner-review" | "risk-audit" | "wager-dispute" | "settlement";

export interface DocTemplateDefinition {
  readonly kind: DocTemplateKind;
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
  readonly requiredKeys: readonly string[];
  readonly optionalKeys?: readonly string[];
}

export const DOC_TEMPLATE_REGISTRY: Record<
  DocTemplateKind,
  DocTemplateDefinition
> = {
  spec: {
    kind: "spec",
    templateId: "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
    name: "Canonical Architecture & Specification Template",
    description:
      "Multi-loader specification, architecture decision record (ADR), and runtime contract",
    requiredKeys: ["DOC_TITLE", "AUTHOR", "STATUS"],
    optionalKeys: ["VERSION", "EVIDENCE_ID"],
  },
  "partner-review": {
    kind: "partner-review",
    templateId: "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
    name: "Partner Review & Surveillance Report",
    description:
      "Account holder review, wager volume analysis, risk profiling, and credit tier evaluation",
    requiredKeys: ["PLAYER_HANDLE", "AGENT_ID", "REVIEW_PERIOD"],
    optionalKeys: ["CURRENT_BALANCE", "RISK_TIER", "ALERT_SUMMARY"],
  },
  "risk-audit": {
    kind: "risk-audit",
    templateId: "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
    name: "Risk & Fraud Audit Dossier",
    description:
      "Forensic betting syndicate analysis, correlation matrix, and anomaly evidence",
    requiredKeys: ["AUDIT_RUN_ID", "CLUSTER_ID", "DETECTION_RULE"],
    optionalKeys: ["CORRELATION_SCORE", "EVIDENCE_PATH"],
  },
  "wager-dispute": {
    kind: "wager-dispute",
    templateId: "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
    name: "Wager & Graded Settlement Dispute",
    description:
      "Official settlement dispute dossier with ticker timestamps and official league box scores",
    requiredKeys: ["TICKET_NUMBER", "WAGER_CODE", "DISPUTE_REASON"],
    optionalKeys: ["EVENT_DATE", "SETTLED_AMOUNT", "REQUESTED_ADJUSTMENT"],
  },
  settlement: {
    kind: "settlement",
    templateId: "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
    name: "EOD / Weekly Settlement Reconciliation",
    description:
      "End-of-cycle ledger reconciliation between GSLive, Fantasy402, and bank settlements",
    requiredKeys: ["CYCLE_DATE", "SETTLEMENT_TOTAL", "DESK_AGENT"],
    optionalKeys: ["VARIANCE_AMOUNT", "APPROVAL_HASH"],
  },
};

export function resolveTemplateKind(kind: string): DocTemplateDefinition {
  const normalized = kind.trim().toLowerCase() as DocTemplateKind;
  const def = DOC_TEMPLATE_REGISTRY[normalized];
  if (!def) {
    const validKinds = Object.keys(DOC_TEMPLATE_REGISTRY).join(", ");
    throw new Error(
      `Unknown template kind "${kind}". Available kinds: ${validKinds}`,
    );
  }
  return def;
}

export function listTemplateKinds(): readonly DocTemplateDefinition[] {
  return Object.values(DOC_TEMPLATE_REGISTRY);
}

export function validateKindSubstitutions(
  kind: DocTemplateKind,
  substitutions: Record<string, string>,
): { valid: boolean; missing: string[] } {
  const def = resolveTemplateKind(kind);
  const presentKeys = new Set(Object.keys(substitutions));
  const missing = def.requiredKeys.filter((k) => !presentKeys.has(k));
  return {
    valid: missing.length === 0,
    missing,
  };
}
