import React from "react";
import { DASHBOARD_TAB_SPECS } from "./types.ts";

export interface ErrorBoundaryProps {
  readonly children: React.ReactNode;
  readonly resetKey?: string | number | undefined;
  readonly panelName?: string | undefined;
  readonly onReset?: (() => void) | undefined;
  readonly onNavigateSafe?: (() => void) | undefined;
  readonly fallback?:
    | ((info: {
        readonly error: Error;
        readonly componentStack: string | null;
        readonly reset: () => void;
      }) => React.ReactNode)
    | undefined;
}

export interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly componentStack: string | null;
}

/**
 * Isolates panel render and state-hydration crashes inside the main workspace
 * so the sticky navigation bar, telemetry strip, and tab switcher remain
 * responsive for recovery.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = {
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("[SportsDesk ErrorBoundary]", error, info.componentStack);
  }

  override componentDidUpdate(prevProps: Readonly<ErrorBoundaryProps>): void {
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null, componentStack: null });
    }
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null, componentStack: null });
    this.props.onReset?.();
  };

  private readonly handleNavigateSafe = (): void => {
    this.setState({ error: null, componentStack: null });
    this.props.onNavigateSafe?.();
  };

  private readonly handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback({
        error,
        componentStack,
        reset: this.handleReset,
      });
    }

    const { panelName, onNavigateSafe } = this.props;
    const errorTitle = error.name
      ? `${error.name}: ${error.message || "Unexpected runtime error"}`
      : error.message || "Unexpected runtime error";
    const diagnosticText = [
      error.stack ?? `${error.name || "Error"}: ${error.message}`,
      componentStack ? `Component stack:${componentStack}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    return (
      <section
        role="alert"
        data-error-boundary="true"
        style={{
          backgroundColor: "#0f172a",
          border: "1px solid rgba(248, 113, 113, 0.45)",
          borderRadius: "10px",
          padding: "20px 24px",
          color: "#f1f5f9",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          boxShadow: "0 10px 28px rgba(2, 6, 23, 0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <span
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: "#fca5a5",
              }}
            >
              ⚠️ Panel Render Error
            </span>
            {panelName && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                  backgroundColor: "rgba(56, 189, 248, 0.12)",
                  color: "#7dd3fc",
                  fontSize: "11px",
                  fontWeight: 600,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              >
                panel: {panelName}
              </span>
            )}
          </div>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "999px",
              border: "1px solid rgba(245, 158, 11, 0.35)",
              backgroundColor: "rgba(245, 158, 11, 0.12)",
              color: "#fbbf24",
              fontSize: "11px",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            🛡️ autoExecute: false
          </span>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "13px",
            lineHeight: "1.5",
            color: "#e2e8f0",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {errorTitle}
        </p>

        {diagnosticText && (
          <details
            style={{
              border: "1px solid #1e293b",
              borderRadius: "8px",
              backgroundColor: "#060913",
              padding: "8px 12px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                color: "#94a3b8",
                userSelect: "none",
              }}
            >
              Stack & component trace
            </summary>
            <pre
              style={{
                margin: "10px 0 0",
                fontSize: "11.5px",
                lineHeight: "1.45",
                color: "#cbd5e1",
                overflowX: "auto",
                whiteSpace: "pre",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {diagnosticText}
            </pre>
          </details>
        )}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <button
            type="button"
            data-error-boundary-retry="true"
            onClick={this.handleReset}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #38bdf8",
              backgroundColor: "rgba(56, 189, 248, 0.16)",
              color: "#e0f2fe",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ↻ Retry Panel
          </button>
          {onNavigateSafe && (
            <button
              type="button"
              data-error-boundary-safe="true"
              onClick={this.handleNavigateSafe}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #334155",
                backgroundColor: "#1e293b",
                color: "#cbd5e1",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ← Return to {DASHBOARD_TAB_SPECS.surveillance.label}
            </button>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #334155",
              backgroundColor: "transparent",
              color: "#94a3b8",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ⟳ Reload Dashboard
          </button>
        </div>
      </section>
    );
  }
}
