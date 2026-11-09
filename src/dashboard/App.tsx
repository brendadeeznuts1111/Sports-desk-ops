import React, { useEffect, useState } from "react";

export interface DashboardData {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: string;
}

export function App(): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [viewMode, setViewMode] = useState<"interactive" | "raw">(
    "interactive",
  );
  const [connected, setConnected] = useState(false);

  const fetchDashboard = async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (res.ok) {
        const json = (await res.json()) as DashboardData;
        setData(json);
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    }
  };

  useEffect(() => {
    fetchDashboard();

    // Hot-reload WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      if (event.data === "reload" || event.data === "dashboard-updated") {
        fetchDashboard();
      }
    };

    return () => ws.close();
  }, []);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>⚡ SportsDesk & Fantasy402 Dashboard</h1>
          <span style={styles.badge(connected)}>
            {connected ? "● Live Hot-Reload Connected" : "○ Disconnected"}
          </span>
        </div>
        <div style={styles.headerRight}>
          <button
            style={styles.toggleBtn(viewMode === "interactive")}
            onClick={() => setViewMode("interactive")}
          >
            Interactive View
          </button>
          <button
            style={styles.toggleBtn(viewMode === "raw")}
            onClick={() => setViewMode("raw")}
          >
            Raw GFM Markdown
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {data ? (
          viewMode === "interactive" ? (
            <div
              style={styles.renderedHtml}
              dangerouslySetInnerHTML={{ __html: data.html }}
            />
          ) : (
            <pre style={styles.rawMarkdown}>{data.markdown}</pre>
          )
        ) : (
          <div style={styles.loading}>
            Loading real-time dashboard telemetry...
          </div>
        )}
      </main>

      <footer style={styles.footer}>
        <span>Updated: {data?.updatedAt ?? "—"}</span>
        <span>
          Native Bun.serve + Bun.markdown + Bun.build (Zero Webpack / Vite)
        </span>
      </footer>
    </div>
  );
}

const styles = {
  container: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: "#070b14",
    color: "#f1f5f9",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "16px 24px",
    backgroundColor: "#0d1527",
    borderBottom: "1px solid #1e293b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  title: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  badge: (active: boolean) => ({
    fontSize: "12px",
    padding: "4px 10px",
    borderRadius: "12px",
    backgroundColor: active
      ? "rgba(34, 197, 94, 0.15)"
      : "rgba(239, 68, 68, 0.15)",
    color: active ? "#22c55e" : "#ef4444",
    border: `1px solid ${active ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
    fontWeight: 600,
  }),
  headerRight: {
    display: "flex",
    gap: "8px",
  },
  toggleBtn: (active: boolean) => ({
    padding: "8px 14px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    border: "1px solid #334155",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#cbd5e1",
    cursor: "pointer",
  }),
  main: {
    flex: 1,
    padding: "24px",
    maxWidth: "1280px",
    width: "100%",
    margin: "0 auto",
    boxSizing: "border-box" as const,
  },
  loading: {
    padding: "40px",
    textAlign: "center" as const,
    color: "#94a3b8",
    fontSize: "16px",
  },
  renderedHtml: {
    lineHeight: 1.6,
  },
  rawMarkdown: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
    backgroundColor: "#0d1527",
    padding: "20px",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
  },
  footer: {
    padding: "12px 24px",
    borderTop: "1px solid #1e293b",
    backgroundColor: "#090d19",
    display: "flex",
    justifyContent: "space-between",
    color: "#64748b",
    fontSize: "12px",
  },
};
