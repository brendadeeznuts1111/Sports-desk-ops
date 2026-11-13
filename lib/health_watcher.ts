/**
 * Operational health transition watcher for Telegram push alerts.
 * Pulls the live `/health` JSON; ignores `data`-only reasons for paging.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { resolveSportsdeskDaemonPort } from "./bun_serve_port.ts";
import type {
  DegradedReason,
  DeskEnhancedHealthPayload,
  DeskOperationalStatus,
} from "./desk_enhanced_health.ts";
import { resolveTelegramCredentials } from "./telegram_alert_sender.ts";
import { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";

export const HEALTH_WATCHER_STATE_REL =
  "scratch/health-watcher-state.json" as const;

export interface HealthWatcherState {
  readonly schemaVersion: 1;
  readonly lastOperationalStatus: DeskOperationalStatus | null;
  readonly updatedAt: string;
}

export interface HealthWatcherSnapshot {
  readonly operationalStatus: DeskOperationalStatus;
  readonly degradedReasons: readonly Pick<
    DegradedReason,
    "kind" | "message" | "action" | "severity"
  >[];
}

export interface HealthWatcherTickResult {
  readonly previous: DeskOperationalStatus | null;
  readonly current: DeskOperationalStatus;
  readonly transitioned: boolean;
  readonly alerted: boolean;
  readonly skippedReason?: string;
}

export interface HealthWatcherTickOptions {
  readonly statePath?: string;
  readonly healthUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
  readonly loadState?: () => Promise<HealthWatcherState>;
  readonly saveState?: (state: HealthWatcherState) => Promise<void>;
  readonly fetchSnapshot?: () => Promise<HealthWatcherSnapshot>;
  readonly sendHtml?: (
    chatId: string,
    html: string,
  ) => Promise<{ ok: boolean; description?: string }>;
}

function defaultStatePath(): string {
  const fromEnv = (Bun.env.HEALTH_WATCHER_STATE_PATH ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return resolve(import.meta.dirname, "../scratch/health-watcher-state.json");
}

function defaultHealthUrl(): string {
  const explicit = (Bun.env.DESK_HEALTH_URL ?? "").trim();
  if (explicit !== "") return explicit;
  const port = resolveSportsdeskDaemonPort(Bun.env);
  return `http://127.0.0.1:${port}/health`;
}

export function healthWatcherStatePath(): string {
  return defaultStatePath();
}

export function healthWatcherDeskUrl(): string {
  return defaultHealthUrl();
}

export async function loadHealthWatcherState(
  path = defaultStatePath(),
): Promise<HealthWatcherState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as HealthWatcherState;
    if (parsed?.schemaVersion === 1) return parsed;
  } catch {
    /* first run */
  }
  return {
    schemaVersion: 1,
    lastOperationalStatus: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function saveHealthWatcherState(
  state: HealthWatcherState,
  path = defaultStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function snapshotFromHealthPayload(
  health: DeskEnhancedHealthPayload,
): HealthWatcherSnapshot {
  return {
    operationalStatus: health.operationalStatus,
    degradedReasons: health.degradedReasons.map((r) => ({
      kind: r.kind,
      message: r.message,
      severity: r.severity,
      ...(r.action === undefined ? {} : { action: r.action }),
    })),
  };
}

export async function fetchHealthWatcherSnapshot(options?: {
  readonly healthUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<HealthWatcherSnapshot> {
  const url = options?.healthUrl ?? defaultHealthUrl();
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        operationalStatus: "down",
        degradedReasons: [
          {
            kind: "auth",
            message: `Desk /health returned HTTP ${res.status}`,
            action: "Restart the desk daemon (bun run serve)",
            severity: "error",
          },
        ],
      };
    }
    const parsed = JSON.parse(text) as DeskEnhancedHealthPayload;
    return snapshotFromHealthPayload(parsed);
  } catch (error) {
    return {
      operationalStatus: "down",
      degradedReasons: [
        {
          kind: "auth",
          message:
            error instanceof Error
              ? `Desk /health unreachable: ${error.message}`
              : "Desk /health unreachable",
          action: "Start PORT=4020 bun run serve",
          severity: "error",
        },
      ],
    };
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatHealthWatcherMessage(
  snapshot: HealthWatcherSnapshot,
  previous: DeskOperationalStatus | null,
): string | null {
  if (previous !== null && snapshot.operationalStatus === previous) {
    return null;
  }
  if (snapshot.operationalStatus === "ok") {
    return "✅ <b>System recovered</b>\nAll operational pipelines are healthy.";
  }
  const reasons = snapshot.degradedReasons
    .filter((r) => r.kind !== "data")
    .map(
      (r) =>
        `• ${escapeHtml(r.message)}\n  → ${escapeHtml(r.action ?? "Check dashboard")}`,
    )
    .join("\n\n");
  const headline =
    snapshot.operationalStatus === "down"
      ? "🔴 <b>System down</b>"
      : "🚨 <b>System degraded</b>";
  return reasons === ""
    ? `${headline}\n(no operational reasons reported)`
    : `${headline}\n\n${reasons}`;
}

export async function runHealthWatcherTick(
  options: HealthWatcherTickOptions = {},
): Promise<HealthWatcherTickResult> {
  const now = options.now ?? (() => new Date());
  const statePath = options.statePath ?? defaultStatePath();
  const state =
    options.loadState === undefined
      ? await loadHealthWatcherState(statePath)
      : await options.loadState();
  const snapshot =
    options.fetchSnapshot === undefined
      ? await fetchHealthWatcherSnapshot({
          ...(options.healthUrl === undefined
            ? {}
            : { healthUrl: options.healthUrl }),
          ...(options.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.fetchImpl }),
        })
      : await options.fetchSnapshot();

  const previous = state.lastOperationalStatus;
  const current = snapshot.operationalStatus;
  const transitioned = previous === null || previous !== current;
  if (!transitioned) {
    return {
      previous,
      current,
      transitioned: false,
      alerted: false,
    };
  }

  const html = formatHealthWatcherMessage(snapshot, previous);
  if (html === null) {
    return {
      previous,
      current,
      transitioned: false,
      alerted: false,
    };
  }

  if (options.dryRun === true) {
    console.error(`[health-watcher] dry-run:\n${html}`);
    const nextState: HealthWatcherState = {
      schemaVersion: 1,
      lastOperationalStatus: current,
      updatedAt: now().toISOString(),
    };
    const save =
      options.saveState ?? ((s) => saveHealthWatcherState(s, statePath));
    await save(nextState);
    return {
      previous,
      current,
      transitioned: true,
      alerted: false,
      skippedReason: "dry-run",
    };
  }

  const creds = await resolveTelegramCredentials();
  const send =
    options.sendHtml ??
    (async (chatId, messageHtml) => {
      const bot = new SportsDeskTelegramService({
        botToken: creds.botToken,
        chatId: creds.chatId,
        activityLogPath: null,
        warmOnInit: false,
      });
      return bot.sendMessage(chatId, messageHtml, { parse_mode: "HTML" });
    });

  if (options.sendHtml === undefined && creds.source === "none") {
    console.error(
      "[health-watcher] Telegram not configured; transition recorded without send",
    );
    const nextState: HealthWatcherState = {
      schemaVersion: 1,
      lastOperationalStatus: current,
      updatedAt: now().toISOString(),
    };
    const save =
      options.saveState ?? ((s) => saveHealthWatcherState(s, statePath));
    await save(nextState);
    return {
      previous,
      current,
      transitioned: true,
      alerted: false,
      skippedReason: "telegram-unconfigured",
    };
  }

  const chatId = creds.chatId !== "" ? creds.chatId : "injected";
  const sent = await send(chatId, html);
  const nextState: HealthWatcherState = {
    schemaVersion: 1,
    lastOperationalStatus: current,
    updatedAt: now().toISOString(),
  };
  const save =
    options.saveState ?? ((s) => saveHealthWatcherState(s, statePath));
  await save(nextState);

  const result: HealthWatcherTickResult = {
    previous,
    current,
    transitioned: true,
    alerted: sent.ok === true,
  };
  if (sent.ok !== true) {
    return { ...result, skippedReason: "send-failed" };
  }
  return result;
}
