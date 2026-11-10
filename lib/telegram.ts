/**
 * @file lib/telegram.ts
 * @description Hardened Telegram alert delivery client using HTML mode formatting,
 * rate limit handling (429 retry-after), and strict credential guards.
 */

import type { AlertDeliveryResult, QueuedAlert } from "./alerts.ts";

export const escapeHtml = Bun.escapeHTML;

/**
 * Formats a surveillance wager alert into an operational Telegram HTML card.
 * Uses native Bun.escapeHTML (SIMD-accelerated C++/Zig character escaping).
 */
export function formatWagerAlertHtml(alert: QueuedAlert): string {
  const p = alert.payload;
  const icon =
    alert.tier === "CRITICAL"
      ? "🚨"
      : alert.tier === "STEAM"
        ? "⚡"
        : alert.tier === "LATENCY"
          ? "⚠️"
          : "ℹ️";

  const lines: string[] = [
    `<b>${icon} SPORTSDESK ALERT: ${Bun.escapeHTML(alert.tier)}</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Customer:</b> <code>${Bun.escapeHTML(p.customerId)}</code>`,
    `<b>Ticket ID:</b> <code>${Bun.escapeHTML(alert.wagerId)}</code>`,
  ];

  if (p.event) {
    lines.push(`<b>Event:</b> ${Bun.escapeHTML(p.event)}`);
  }
  if (p.selection) {
    lines.push(`<b>Selection:</b> ${Bun.escapeHTML(p.selection)}`);
  }
  if (p.oddsAmerican) {
    lines.push(`<b>Odds:</b> <code>${Bun.escapeHTML(p.oddsAmerican)}</code>`);
  }
  if (p.amountUsd !== undefined) {
    lines.push(
      `<b>Stake:</b> $${p.amountUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
  }
  if (p.clvCents !== undefined) {
    lines.push(
      `<b>CLV:</b> ${p.clvCents > 0 ? "+" : ""}${p.clvCents.toFixed(1)}¢`,
    );
  }
  if (p.directive) {
    lines.push(`<b>Directive:</b> <u>${Bun.escapeHTML(p.directive)}</u>`);
  }
  if (p.notes) {
    lines.push(`<b>Notes:</b> ${Bun.escapeHTML(p.notes)}`);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(
    `<i>Delivery ID: <code>${Bun.escapeHTML(alert.deliveryId)}</code></i>`,
  );

  return lines.join("\n");
}

export interface TelegramSenderOptions {
  botToken?: string | undefined;
  chatId?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

/**
 * Delivers an alert message to Telegram via the Bot API sendMessage endpoint.
 * Respects 429 rate limiting with retry_after header parsing.
 */
export async function sendTelegramAlert(
  alert: QueuedAlert,
  opts?: TelegramSenderOptions,
): Promise<AlertDeliveryResult> {
  const botToken =
    opts?.botToken ??
    process.env.TELEGRAM_BOT_TOKEN ??
    Bun.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    opts?.chatId ?? process.env.TELEGRAM_CHAT_ID ?? Bun.env.TELEGRAM_CHAT_ID;
  const fetcher = opts?.fetchFn ?? fetch;

  if (!botToken || !chatId) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in production for alert delivery",
      );
    }
    return {
      ok: false,
      error: "telegram_not_configured",
    };
  }

  const html = formatWagerAlertHtml(alert);
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (res.status === 429) {
      let retryAfterSec = 5;
      try {
        const body = (await res.json()) as {
          parameters?: { retry_after?: number };
        };
        if (body.parameters?.retry_after) {
          retryAfterSec = Math.min(3600, body.parameters.retry_after);
        }
      } catch {
        // Fall back to default 5s retry
      }
      return {
        ok: false,
        error: "rate_limited",
        retryAfterSec,
      };
    }

    if (!res.ok) {
      let desc = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { description?: string };
        if (body.description) desc = body.description;
      } catch {
        // Fall back to HTTP status
      }
      return {
        ok: false,
        error: desc,
      };
    }

    const body = (await res.json()) as {
      ok: boolean;
      result?: { message_id?: number };
      description?: string;
    };

    if (!body.ok) {
      return {
        ok: false,
        error: body.description ?? "unknown_telegram_error",
      };
    }

    return {
      ok: true,
      messageId: body.result?.message_id,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
