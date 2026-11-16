/**
 * @file packages/ui/src/panels/BuildMatrixDrawer.tsx
 * @description Compile-time `bun:bundle` DCE matrix probe and the CSS Houdini token
 * registry rendered beside it.
 *
 * The table rows come from `GET /api/build-matrix`, which runs `Bun.build` once per
 * target (`prod`, `dev`, `test`). The header describes the runtime actually serving this
 * page, which is not always one of those targets: under the Bun HTML dev server the
 * modules are unbundled, so `feature()` resolves `false` and no branch was eliminated.
 * The two states are labelled separately rather than merged into one "DCE" claim.
 */

import { DESCRIPTIONS, FEATURES } from "@sportsdesk-ops/contracts";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatMatrixEvidenceTable,
  formatMatrixRowEvidence,
} from "../build_matrix_evidence.ts";
import { copyText, type CopyFailure } from "../clipboard.ts";
import {
  buildRegistryRootCss,
  HOUDINI_TOKENS,
  TOKEN_ALIAS_SPECS,
  type HoudiniTokenSpec,
  type TokenAliasSpec,
  type TokenAxis,
} from "../token_registry.ts";
import type { BuildMatrixRow } from "../types.ts";

export { HOUDINI_TOKENS } from "../token_registry.ts";
export type { HoudiniTokenSpec, TokenAxis } from "../token_registry.ts";

export interface BuildMatrixDrawerProps {
  readonly dceMarker: string;
  readonly loading: boolean;
  readonly rows: readonly BuildMatrixRow[] | null;
  readonly target?: string | undefined;
  readonly enabledFeatures?: readonly string[] | undefined;
  readonly error?: string | null | undefined;
  /** ISO timestamp of the probe payload (`generatedAt` from `/api/build-matrix`). */
  readonly generatedAt?: string | null | undefined;
  /** Wall-clock time the probe request took, measured by the caller. */
  readonly compiledMs?: number | null | undefined;
  readonly onRefresh?: (() => void) | undefined;
}

/** A probe payload older than this is still shown, but marked stale. */
const STALE_AFTER_MS = 10 * 60 * 1000;

const MUTED_TEXT = "var(--sd-text-muted, #94a3b8)";
const SAVED_COLOR = "var(--sd-state-ok, #4ade80)";
const WARN_COLOR = "var(--sd-state-warn, #f59e0b)";
const DANGER_COLOR = "var(--sd-state-danger, #ff7878)";
const ACCENT_COLOR = "var(--sd-state-accent, #38bdf8)";

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * The three branches whose retention is probed by `has*Sentinel`. Each row states the
 * flags it was built with, so retention is checkable against that same row.
 */
const SENTINEL_PROBES = [
  { feature: "PROD", key: "hasProdSentinel", label: "PROD Branch" },
  { feature: "DEBUG", key: "hasDebugSentinel", label: "DEBUG Branch" },
  {
    feature: "EXPERIMENTAL",
    key: "hasExperimentalSentinel",
    label: "EXPERIMENTAL Branch",
  },
] as const satisfies readonly {
  readonly feature: (typeof FEATURES)[number];
  readonly key: keyof BuildMatrixRow;
  readonly label: string;
}[];

/**
 * Flag → description, keyed by plain string so a probe payload carrying an
 * unregistered flag is detectable without a cast.
 */
const FEATURE_DESCRIPTIONS: ReadonlyMap<string, string> = new Map(
  FEATURES.map((feature) => [feature, DESCRIPTIONS[feature]] as const),
);

type CopyFeedback =
  | {
      readonly ok: true;
      readonly kind: "token" | "alias" | "registry" | "row" | "matrix";
      readonly id: string;
      readonly label: string;
    }
  | { readonly ok: false; readonly reason: CopyFailure };

type DcePayoff =
  | {
      readonly kind: "measured";
      readonly savingsBytes: number;
      readonly percent: number;
      readonly pruned: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly targets: readonly string[] };

const COPY_FAILURE_HINTS: Record<CopyFailure, string> = {
  "runtime-unavailable": "clipboard needs a browser page",
  "clipboard-unavailable":
    "navigator.clipboard is missing — a secure context (https or localhost) is required",
  "permission-denied":
    "the browser denied the write — check clipboard permission for this origin",
};

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatBytesDeltaVsBaseline(
  bytes: number,
  baselineBytes: number | null,
): string {
  if (baselineBytes === null || baselineBytes <= 0) return "—";
  const diff = bytes - baselineBytes;
  if (diff === 0) return "baseline";
  const kb = (diff / 1024).toFixed(1);
  const pct = ((diff / baselineBytes) * 100).toFixed(1);
  return `${diff > 0 ? "+" : ""}${kb} KB (${diff > 0 ? "+" : ""}${pct}%)`;
}

function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sentinelParity(row: BuildMatrixRow): {
  readonly mismatches: readonly string[];
} {
  const mismatches: string[] = [];
  for (const probe of SENTINEL_PROBES) {
    const expected = row.features.includes(probe.feature);
    const observed = row[probe.key];
    if (observed !== expected) {
      mismatches.push(
        `${probe.feature} expected ${expected ? "kept" : "pruned"}`,
      );
    }
  }
  return { mismatches };
}

function deriveDcePayoff(rows: readonly BuildMatrixRow[]): DcePayoff {
  const dev = rows.find((row) => row.target === "dev") ?? null;
  const prod = rows.find((row) => row.target === "prod") ?? null;
  if (dev === null || prod === null) {
    return { kind: "unavailable", targets: rows.map((row) => row.target) };
  }
  const savingsBytes = dev.totalJsBytes - prod.totalJsBytes;
  const percent =
    dev.totalJsBytes > 0 ? (savingsBytes / dev.totalJsBytes) * 100 : 0;
  return {
    kind: "measured",
    savingsBytes,
    percent,
    pruned: FEATURES.filter((feature) => !prod.features.includes(feature)),
  };
}

function describePayoff(payoff: DcePayoff): string {
  if (payoff.kind === "unavailable") {
    const seen =
      payoff.targets.length > 0 ? payoff.targets.join(", ") : "no targets";
    return `DCE payoff unavailable — probe returned ${seen}; need prod and dev rows`;
  }
  if (payoff.savingsBytes <= 0) {
    return `prod is not smaller than dev (${formatKb(
      Math.abs(payoff.savingsBytes),
    )} heavier) — no DCE gain measured`;
  }
  const pruned =
    payoff.pruned.length > 0 ? ` by pruning ${payoff.pruned.join(" + ")}` : "";
  return `prod ships ${formatKb(
    payoff.savingsBytes,
  )} less JS than dev (${payoff.percent.toFixed(1)}% smaller)${pruned}`;
}

function readComputedTokenMap(): Readonly<Record<string, string>> {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof getComputedStyle !== "function"
  ) {
    return {};
  }
  const style = getComputedStyle(document.documentElement);
  const entries: [string, string][] = [];
  for (const spec of HOUDINI_TOKENS) {
    const raw = style.getPropertyValue(spec.token).trim().toLowerCase();
    if (raw) {
      entries.push([spec.token, raw]);
    }
  }
  return Object.fromEntries(entries);
}

export function BuildMatrixDrawer({
  dceMarker,
  loading,
  rows,
  target,
  enabledFeatures,
  error,
  generatedAt,
  compiledMs,
  onRefresh,
}: BuildMatrixDrawerProps): React.ReactElement {
  const [axisFilter, setAxisFilter] = useState<TokenAxis>("all");
  const [tokenQuery, setTokenQuery] = useState<string>("");
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const [computedTokens, setComputedTokens] = useState<
    Readonly<Record<string, string>>
  >(() => ({}));
  const [now, setNow] = useState<number>(() => Date.now());
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setComputedTokens(readComputedTokenMap());
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
  }, []);

  const showCopyFeedback = (feedback: CopyFeedback) => {
    setCopyFeedback(feedback);
    if (feedbackTimer.current !== null) {
      clearTimeout(feedbackTimer.current);
    }
    feedbackTimer.current = setTimeout(
      () => {
        setCopyFeedback(null);
        feedbackTimer.current = null;
      },
      feedback.ok ? 2500 : 6000,
    );
  };

  const isUnbundled = target === "unbundled-hmr";

  const computedCount = useMemo(
    () => HOUDINI_TOKENS.filter((t) => Boolean(computedTokens[t.token])).length,
    [computedTokens],
  );

  const visibleTokens = useMemo(() => {
    const query = tokenQuery.trim().toLowerCase();
    return HOUDINI_TOKENS.filter((token) => {
      if (axisFilter !== "all" && token.axis !== axisFilter) return false;
      if (query === "") return true;
      return `${token.token} ${token.label} ${token.hex} ${token.detail}`
        .toLowerCase()
        .includes(query);
    });
  }, [axisFilter, tokenQuery]);

  const visibleAliases = useMemo(() => {
    const query = tokenQuery.trim().toLowerCase();
    return TOKEN_ALIAS_SPECS.filter((alias) => {
      if (axisFilter !== "all" && alias.axis !== axisFilter) return false;
      if (query === "") return true;
      return `${alias.alias} ${alias.target} ${alias.scope}`
        .toLowerCase()
        .includes(query);
    });
  }, [axisFilter, tokenQuery]);

  const devBaselineBytes = useMemo(() => {
    const devRow = rows?.find((r) => r.target === "dev");
    return devRow ? devRow.totalJsBytes : null;
  }, [rows]);

  const maxJsBytes = useMemo(
    () => rows?.reduce((max, r) => Math.max(max, r.totalJsBytes), 0) ?? 0,
    [rows],
  );

  const activeFeatureSet = useMemo(() => {
    if (enabledFeatures && enabledFeatures.length > 0) {
      return new Set(enabledFeatures);
    }
    // Derive from target or marker prefix without embedding literal DCE sentinel strings
    // outside `runtime_flags.ts` `feature()` branches.
    const set = new Set<string>();
    if (target === "prod" || dceMarker.includes("_PROD_")) set.add("PROD");
    if (target === "dev" || dceMarker.includes("_DEBUG_")) set.add("DEBUG");
    if (target === "test") set.add("TEST");
    if (target === "dev" || dceMarker.includes("_EXPERIMENTAL_")) {
      set.add("EXPERIMENTAL");
    }
    return set;
  }, [enabledFeatures, target, dceMarker]);

  const payoff = useMemo(
    () => (rows !== null ? deriveDcePayoff(rows) : null),
    [rows],
  );

  const parity = useMemo(
    () =>
      rows === null
        ? null
        : rows.map((row) => ({
            target: row.target,
            mismatches: sentinelParity(row).mismatches,
          })),
    [rows],
  );

  const parityChecks = rows === null ? 0 : rows.length * SENTINEL_PROBES.length;
  const parityMismatches =
    parity === null
      ? 0
      : parity.reduce((count, row) => count + row.mismatches.length, 0);
  const parityDetail =
    parity === null
      ? ""
      : parity
          .filter((row) => row.mismatches.length > 0)
          .map((row) => `${row.target}: ${row.mismatches.join("; ")}`)
          .join(" · ");

  const generatedAtMs =
    generatedAt !== null && generatedAt !== undefined
      ? Date.parse(generatedAt)
      : Number.NaN;
  const probeAgeMs = Number.isFinite(generatedAtMs)
    ? Math.max(0, now - generatedAtMs)
    : null;
  const isStale = probeAgeMs !== null && probeAgeMs > STALE_AFTER_MS;

  const copiedToken =
    copyFeedback?.ok === true && copyFeedback.kind === "token"
      ? copyFeedback.id
      : null;
  const copiedAlias =
    copyFeedback?.ok === true && copyFeedback.kind === "alias"
      ? copyFeedback.id
      : null;

  const copyTokenVar = (spec: HoudiniTokenSpec) => {
    void copyText(`var(${spec.token}) /* ${spec.hex} */`).then((result) => {
      if (result.ok) {
        showCopyFeedback({
          ok: true,
          kind: "token",
          id: spec.token,
          label: spec.token,
        });
      } else {
        showCopyFeedback({ ok: false, reason: result.reason });
      }
    });
  };

  const copyAliasVar = (spec: TokenAliasSpec) => {
    void copyText(`var(${spec.alias}) /* -> var(${spec.target}) */`).then(
      (result) => {
        if (result.ok) {
          showCopyFeedback({
            ok: true,
            kind: "alias",
            id: spec.alias,
            label: `var(${spec.alias})`,
          });
        } else {
          showCopyFeedback({ ok: false, reason: result.reason });
        }
      },
    );
  };

  const copyRegistry = () => {
    void copyText(buildRegistryRootCss()).then((result) => {
      if (result.ok) {
        showCopyFeedback({
          ok: true,
          kind: "registry",
          id: "root",
          label: `:root (${HOUDINI_TOKENS.length + TOKEN_ALIAS_SPECS.length} properties)`,
        });
      } else {
        showCopyFeedback({ ok: false, reason: result.reason });
      }
    });
  };

  const copyMatrixRow = (row: BuildMatrixRow) => {
    void copyText(formatMatrixRowEvidence(row, devBaselineBytes)).then(
      (result) => {
        if (result.ok) {
          showCopyFeedback({
            ok: true,
            kind: "row",
            id: row.target,
            label: `${row.target} matrix row`,
          });
        } else {
          showCopyFeedback({ ok: false, reason: result.reason });
        }
      },
    );
  };

  const copyMatrixTable = () => {
    if (rows === null || rows.length === 0) return;
    void copyText(
      formatMatrixEvidenceTable(rows, devBaselineBytes, {
        target,
        generatedAt,
        compiledMs,
      }),
    ).then((result) => {
      if (result.ok) {
        showCopyFeedback({
          ok: true,
          kind: "matrix",
          id: "matrix",
          label: `DCE matrix (${rows.length} targets)`,
        });
      } else {
        showCopyFeedback({ ok: false, reason: result.reason });
      }
    });
  };

  return (
    <section
      aria-labelledby="build-matrix-heading"
      style={{
        padding: "14px 24px",
        backgroundColor: "var(--sd-surface-cli, #04070e)",
        borderBottom: "1px solid var(--sd-surface-border, #1e293b)",
      }}
    >
      <div
        style={{
          maxWidth: "1600px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              minWidth: 0,
            }}
          >
            <h2
              id="build-matrix-heading"
              style={{ margin: 0, fontSize: "13px", fontWeight: 700 }}
            >
              🧬 Compile-Time <code>bun:bundle</code> DCE Matrix &amp;{" "}
              <code>design/tokens.toml</code> Houdini Palette
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "6px",
              }}
            >
              {target && (
                <span className="sd-pill sd-pill-live sd-mono">
                  Active Target: {target}
                </span>
              )}
              {isUnbundled && (
                <span
                  className="sd-pill sd-pill-fixture sd-mono"
                  title="The dev server serves modules unbundled, so feature() has no build-time substitution on this page."
                >
                  unbundled · nothing pruned
                </span>
              )}
              <span className="sd-pill sd-mono">
                @property{" "}
                {computedCount > 0
                  ? `${computedCount}/${HOUDINI_TOKENS.length} live`
                  : `${HOUDINI_TOKENS.length} registered`}
              </span>
              {probeAgeMs !== null && (
                <span
                  className={`sd-pill sd-mono ${isStale ? "sd-pill-fixture" : ""}`}
                  title={`The three-target Bun.build probe finished at ${generatedAt ?? "an unreported time"}; ${
                    compiledMs !== null && compiledMs !== undefined
                      ? `this request round-trip took ${Math.round(compiledMs)} ms`
                      : "no round-trip time was measured"
                  }. A plain probe request re-serves the cached result, so age is the probe's, not the page's.`}
                >
                  {isStale ? "⚠ Stale probe" : "🕒 Probe"} ·{" "}
                  {formatAge(probeAgeMs)}
                  {compiledMs !== null && compiledMs !== undefined
                    ? ` · ${Math.round(compiledMs)} ms`
                    : ""}
                </span>
              )}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <span
              className="sd-mono"
              style={{ fontSize: "11px", color: MUTED_TEXT }}
              title="The marker the page's own runtime reports. The build probes below are separate Bun.build runs and do not change it."
            >
              Runtime marker: {dceMarker}
            </span>
            {onRefresh && (
              <button
                type="button"
                className="sd-pill sd-mono"
                onClick={onRefresh}
                disabled={loading}
                aria-busy={loading}
                style={{
                  cursor: loading ? "wait" : "pointer",
                  color: ACCENT_COLOR,
                }}
              >
                {loading ? "⏳ Compiling..." : "↻ Re-compile Matrix"}
              </button>
            )}
            {rows !== null && rows.length > 0 && (
              <button
                type="button"
                className="sd-pill sd-mono"
                data-matrix-copy-table="true"
                onClick={copyMatrixTable}
                title="Copy the whole DCE matrix — probe metadata, byte totals, deltas and retained branches — as a Markdown table"
                style={{ cursor: "pointer", color: SAVED_COLOR }}
              >
                ⧉ Copy matrix
              </button>
            )}
            <a
              href="#build-matrix-table"
              data-matrix-jump="table"
              className="sd-mono"
              title="Jump past the token registry to the DCE matrix table"
              style={{
                fontSize: "10px",
                color: MUTED_TEXT,
                textDecoration: "none",
              }}
            >
              ⤓ Skip to matrix
            </a>
          </div>
        </div>

        {isUnbundled && (
          <p
            role="note"
            style={{
              margin: 0,
              fontSize: "11px",
              lineHeight: 1.55,
              color: MUTED_TEXT,
            }}
          >
            Served unbundled by the Bun HTML dev server: <code>feature()</code>{" "}
            resolves <code>false</code> at request time, so{" "}
            <strong>no branch is eliminated</strong> in this page. The matrix
            below probes <code>prod</code>, <code>dev</code> and{" "}
            <code>test</code> through <code>Bun.build</code> — it describes
            those bundles, not the one being served.
          </p>
        )}

        {/* Compile-time bun:bundle Feature Flag Strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <span
            className="sd-mono"
            style={{
              fontSize: "11px",
              color: MUTED_TEXT,
              marginRight: "4px",
            }}
          >
            Flags ({activeFeatureSet.size}/{FEATURES.length} enabled):
          </span>
          {FEATURES.map((feat) => {
            const active = activeFeatureSet.has(feat);
            const stateLabel = active ? "ON" : isUnbundled ? "OFF" : "DCE";
            const glyph = active ? "✅" : isUnbundled ? "○" : "✂️";
            const stateReason = active
              ? "enabled in this runtime"
              : isUnbundled
                ? "resolves false at request time; nothing was eliminated in this unbundled page"
                : "pruned by dead-code elimination in this target";
            return (
              <span
                key={feat}
                title={`${DESCRIPTIONS[feat]} · ${stateReason}`}
                className={`sd-pill sd-mono ${active ? "sd-pill-live" : ""}`}
                style={active ? undefined : { opacity: 0.72 }}
              >
                {glyph} {feat}{" "}
                <span style={{ opacity: 0.8 }}>{stateLabel}</span>
              </span>
            );
          })}
        </div>

        {/* Axis Filter Tabs + Houdini Swatch Strip */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {(
              [
                ["all", `All Tokens (${HOUDINI_TOKENS.length})`],
                [
                  "surfaces",
                  `Surfaces & Chrome (${HOUDINI_TOKENS.filter((t) => t.axis === "surfaces").length})`,
                ],
                [
                  "sla",
                  `SLA Fresh→Poison (${HOUDINI_TOKENS.filter((t) => t.axis === "sla").length})`,
                ],
                [
                  "ingestion",
                  `Ingestion L17–L24D (${HOUDINI_TOKENS.filter((t) => t.axis === "ingestion").length})`,
                ],
                [
                  "routes",
                  `Risk Routes R01–R04 (${HOUDINI_TOKENS.filter((t) => t.axis === "routes").length})`,
                ],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="sd-preset-btn sd-mono"
                data-active={axisFilter === id ? "true" : "false"}
                aria-pressed={axisFilter === id}
                onClick={() => setAxisFilter(id)}
                style={{ padding: "3px 9px", fontSize: "11px" }}
              >
                {label}
              </button>
            ))}
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                marginLeft: "auto",
              }}
            >
              <span
                className="sd-mono"
                style={{ fontSize: "10px", color: MUTED_TEXT }}
              >
                Filter
              </span>
              <input
                type="search"
                className="sd-mono"
                aria-label={`Filter the ${HOUDINI_TOKENS.length} design tokens`}
                placeholder="name, var or hex"
                value={tokenQuery}
                onChange={(event) => setTokenQuery(event.target.value)}
                style={{
                  width: "170px",
                  fontSize: "11px",
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid var(--sd-surface-border, #243247)",
                  backgroundColor: "var(--sd-surface-cli, #04070e)",
                  color: "var(--sd-text-primary, #f1f5f9)",
                }}
              />
            </label>
            <button
              type="button"
              className="sd-preset-btn sd-mono"
              onClick={copyRegistry}
              title={`Copy the served :root — ${HOUDINI_TOKENS.length} canonical tokens + ${TOKEN_ALIAS_SPECS.length} aliases`}
              style={{ padding: "3px 9px", fontSize: "11px" }}
            >
              ⧉ Copy registry
            </button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
              fontSize: "10px",
            }}
          >
            <span className="sd-mono" style={{ color: MUTED_TEXT }}>
              {visibleTokens.length}/{HOUDINI_TOKENS.length} tokens ·{" "}
              {visibleAliases.length}/{TOKEN_ALIAS_SPECS.length} aliases · click
              to copy <code>var()</code>
            </span>
            {copyFeedback !== null ? (
              copyFeedback.ok ? (
                <span
                  role="status"
                  className="sd-mono"
                  style={{ color: SAVED_COLOR }}
                >
                  ✓ Copied {copyFeedback.label}
                </span>
              ) : (
                <span
                  role="alert"
                  className="sd-mono"
                  style={{ color: DANGER_COLOR }}
                >
                  ✗ Copy blocked ({copyFeedback.reason}):{" "}
                  {COPY_FAILURE_HINTS[copyFeedback.reason]}
                </span>
              )
            ) : null}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {visibleTokens.length === 0 ? (
              <span
                className="sd-mono"
                style={{ fontSize: "11px", color: MUTED_TEXT }}
              >
                No token matches “{tokenQuery}” on this axis.
              </span>
            ) : (
              visibleTokens.map((spec) => {
                const liveHex = computedTokens[spec.token];
                const isCopied = copiedToken === spec.token;
                return (
                  <button
                    key={spec.token}
                    type="button"
                    onClick={() => copyTokenVar(spec)}
                    className="sd-pill sd-mono"
                    title={`${spec.detail} · canonical ${spec.hex}${liveHex ? ` · computed ${liveHex}` : ""} · Click to copy var(${spec.token})`}
                    aria-label={`Copy var(${spec.token}) — ${spec.label}, canonical ${spec.hex}`}
                    style={{ cursor: "pointer" }}
                  >
                    <span
                      className="sd-token-swatch"
                      style={{
                        backgroundColor: `var(${spec.token}, ${spec.hex})`,
                      }}
                    />
                    <span>
                      {spec.label}: {spec.token}
                    </span>
                    <span
                      style={{
                        color:
                          isCopied || (liveHex && liveHex !== spec.hex)
                            ? SAVED_COLOR
                            : MUTED_TEXT,
                        fontSize: "10px",
                      }}
                    >
                      {isCopied ? "Copied!" : spec.hex}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "6px",
              fontSize: "10px",
            }}
          >
            <span className="sd-mono" style={{ color: MUTED_TEXT }}>
              Aliases ({visibleAliases.length}/{TOKEN_ALIAS_SPECS.length}) ·{" "}
              <code>:root</code> var() layer
            </span>
            {visibleAliases.length === 0 ? (
              <span className="sd-mono" style={{ color: MUTED_TEXT }}>
                No alias matches “{tokenQuery}” on this axis.
              </span>
            ) : (
              visibleAliases.map((spec) => {
                const isCopied = copiedAlias === spec.alias;
                return (
                  <button
                    key={`${spec.scope}:${spec.alias}`}
                    type="button"
                    onClick={() => copyAliasVar(spec)}
                    className="sd-pill sd-mono"
                    title={`${spec.scope} alias · var(${spec.alias}) resolves to var(${spec.target}) · Click to copy`}
                    aria-label={`Copy var(${spec.alias}) — ${spec.scope} alias of ${spec.target}`}
                    style={{
                      cursor: "pointer",
                      fontSize: "10px",
                      padding: "2px 8px",
                      color: isCopied ? SAVED_COLOR : undefined,
                    }}
                  >
                    {isCopied ? "Copied!" : `${spec.alias} ← ${spec.target}`}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="sd-mono"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "8px",
              fontSize: "11px",
              color: DANGER_COLOR,
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              backgroundColor: "rgba(239, 68, 68, 0.08)",
            }}
          >
            <span>⚠️ DCE Matrix probe error: {error}</span>
            {onRefresh && (
              <button
                type="button"
                className="sd-pill sd-mono"
                onClick={onRefresh}
                disabled={loading}
                style={{
                  cursor: loading ? "wait" : "pointer",
                  color: DANGER_COLOR,
                }}
              >
                ↻ Retry probe
              </button>
            )}
          </div>
        )}

        {loading ? (
          <div
            role="status"
            aria-live="polite"
            className="sd-mono"
            style={{
              fontSize: "12px",
              color: MUTED_TEXT,
            }}
          >
            ⏳ Probing <code>prod</code> / <code>dev</code> / <code>test</code>{" "}
            through <code>Bun.build</code> — three builds, a few seconds…
          </div>
        ) : rows !== null && rows.length > 0 ? (
          <>
            <div
              role="status"
              aria-live="polite"
              className="sd-mono"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "4px 12px",
                fontSize: "11px",
                color: "var(--sd-text-secondary, #cbd5e1)",
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid var(--sd-surface-border, #1e293b)",
                backgroundColor: "rgba(16, 185, 129, 0.06)",
              }}
            >
              <span>
                {payoff !== null ? describePayoff(payoff) : "DCE payoff —"}
              </span>
              <span aria-hidden="true" style={{ color: MUTED_TEXT }}>
                ·
              </span>
              <span
                style={{
                  color: parityMismatches > 0 ? DANGER_COLOR : MUTED_TEXT,
                }}
              >
                {parityMismatches > 0
                  ? `⚠ sentinels ${parityChecks - parityMismatches}/${parityChecks} — ${parityDetail}`
                  : `sentinels ${parityChecks}/${parityChecks} match the flags each target enables`}
              </span>
            </div>
            <table
              id="build-matrix-table"
              data-matrix-table="true"
              style={{ margin: 0 }}
            >
              <caption style={VISUALLY_HIDDEN}>
                DCE matrix: per-target JS and CSS bytes, retained bun:bundle
                branches, and the JS delta against the dev baseline.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Enabled bun:bundle Flags</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    JS Bundle
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    JS Delta vs dev
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    CSS Tokens + Chrome
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Total
                  </th>
                  {SENTINEL_PROBES.map((probe) => (
                    <th key={probe.feature} scope="col">
                      {probe.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isActiveTarget = target === r.target;
                  const rowParity = sentinelParity(r);
                  const barPercent =
                    maxJsBytes > 0 ? (r.totalJsBytes / maxJsBytes) * 100 : 0;
                  const delta = formatBytesDeltaVsBaseline(
                    r.totalJsBytes,
                    devBaselineBytes,
                  );
                  const isSaving =
                    devBaselineBytes !== null &&
                    r.totalJsBytes < devBaselineBytes;
                  const deltaColor = isSaving
                    ? SAVED_COLOR
                    : delta === "baseline"
                      ? MUTED_TEXT
                      : WARN_COLOR;
                  return (
                    <tr
                      key={r.target}
                      style={
                        isActiveTarget
                          ? { backgroundColor: "rgba(16, 185, 129, 0.08)" }
                          : undefined
                      }
                    >
                      <th
                        scope="row"
                        className="sd-mono"
                        style={{
                          textAlign: "left",
                          fontSize: "13px",
                          fontWeight: 400,
                          textTransform: "none",
                          letterSpacing: 0,
                          backgroundColor: "transparent",
                          color: "var(--sd-text-primary, #f1f5f9)",
                        }}
                      >
                        <strong>{r.target}</strong>{" "}
                        {isActiveTarget && (
                          <span
                            style={{
                              marginLeft: "6px",
                              fontSize: "10px",
                              color: "#10b981",
                              fontWeight: 700,
                            }}
                          >
                            ACTIVE
                          </span>
                        )}
                        {rowParity.mismatches.length > 0 && (
                          <span
                            title={`This row's flags contradict its retained branches: ${rowParity.mismatches.join("; ")}`}
                            style={{
                              marginLeft: "6px",
                              fontSize: "10px",
                              color: DANGER_COLOR,
                              fontWeight: 700,
                            }}
                          >
                            ⚠ {rowParity.mismatches.length} sentinel mismatch
                          </span>
                        )}
                        <button
                          type="button"
                          data-matrix-copy-row={r.target}
                          aria-label={`Copy the evidence line for ${r.target}`}
                          title="Copy this row as a plain-text evidence line — exact bytes, delta vs dev, and retained branches"
                          onClick={() => copyMatrixRow(r)}
                          style={{
                            marginLeft: "6px",
                            background: "none",
                            border: "none",
                            padding: "0 2px",
                            color: MUTED_TEXT,
                            cursor: "pointer",
                            fontSize: "11px",
                          }}
                        >
                          ⧉
                        </button>
                      </th>
                      <td className="sd-mono">
                        {r.features.length === 0 ? (
                          <span style={{ color: MUTED_TEXT }}>none</span>
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              flexWrap: "wrap",
                              gap: "4px",
                            }}
                          >
                            {r.features.map((feature) => {
                              const description =
                                FEATURE_DESCRIPTIONS.get(feature) ?? null;
                              const probe = SENTINEL_PROBES.find(
                                (entry) => entry.feature === feature,
                              );
                              return (
                                <span
                                  key={feature}
                                  className="sd-pill sd-mono"
                                  data-matrix-flag={feature}
                                  data-matrix-flag-unknown={
                                    description === null ? "true" : undefined
                                  }
                                  title={
                                    description === null
                                      ? "Not a registered bun:bundle feature — check the probe payload."
                                      : `${description}${probe === undefined ? " · compile-time only; no retained-branch probe." : ` · gates the ${probe.label} probe.`}`
                                  }
                                  style={{
                                    fontSize: "10px",
                                    padding: "1px 6px",
                                    ...(description === null
                                      ? { color: DANGER_COLOR }
                                      : {}),
                                  }}
                                >
                                  {description === null
                                    ? `⚠ ${feature}`
                                    : feature}
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </td>
                      <td className="sd-mono" style={{ textAlign: "right" }}>
                        <span>{formatKb(r.totalJsBytes)}</span>
                        <span
                          aria-hidden="true"
                          style={{
                            display: "block",
                            height: "3px",
                            marginTop: "4px",
                            borderRadius: "2px",
                            backgroundColor: "rgba(148, 163, 184, 0.18)",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              height: "3px",
                              width: `${barPercent.toFixed(1)}%`,
                              borderRadius: "2px",
                              backgroundColor: ACCENT_COLOR,
                            }}
                          />
                        </span>
                      </td>
                      <td
                        className="sd-mono"
                        style={{ textAlign: "right", color: deltaColor }}
                      >
                        {delta}
                      </td>
                      <td className="sd-mono" style={{ textAlign: "right" }}>
                        {formatKb(r.totalCssBytes)}
                      </td>
                      <td className="sd-mono" style={{ textAlign: "right" }}>
                        {formatKb(r.totalJsBytes + r.totalCssBytes)}
                      </td>
                      {SENTINEL_PROBES.map((probe) => (
                        <td key={probe.feature} className="sd-mono">
                          {r[probe.key] ? "✅ Kept" : "✂️ Pruned (DCE)"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : rows !== null ? (
          <div
            className="sd-mono"
            style={{ fontSize: "11px", color: WARN_COLOR }}
          >
            ⚠️ The probe returned no target rows — nothing to compare.
          </div>
        ) : error ? null : (
          <div
            className="sd-mono"
            style={{ fontSize: "11px", color: MUTED_TEXT }}
          >
            No probe rows yet — press “Re-compile Matrix” to run the
            three-target <code>Bun.build</code> probe.
          </div>
        )}
      </div>
    </section>
  );
}
