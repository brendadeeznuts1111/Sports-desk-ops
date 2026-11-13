/**
 * @file packages/api/src/ws.ts
 * @description WebSocket topic pub/sub state machine and status telemetry for the dashboard API.
 */

import {
  DASHBOARD_WS_TOPICS,
  type DashboardWsTopic,
} from "@sportsdesk-ops/contracts";

export { DASHBOARD_WS_TOPICS, type DashboardWsTopic };

export interface WsLike {
  readonly subscriptions?: readonly string[] | undefined;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  send(data: string): unknown;
}

export interface DashboardWsStatusPayload {
  readonly totalConnectedClients: number;
  readonly topicDistribution: Readonly<Record<string, number>>;
  readonly clients: ReadonlyArray<{
    readonly id: number;
    readonly topics: readonly string[];
  }>;
  readonly serverTopics: readonly string[];
  readonly timestamp: string;
}

export function createDashboardWebSocketHandler<TWs extends WsLike>(
  clients: Set<TWs>,
) {
  const websocket = {
    open(ws: TWs) {
      ws.subscribe("dashboard");
      ws.subscribe("live-bets");
      ws.subscribe("syndicate-alerts");
      ws.subscribe("tiers-updated");
      clients.add(ws);
    },
    message(
      ws: TWs,
      message:
        | string
        | Buffer<ArrayBufferLike>
        | ArrayBuffer
        | Uint8Array<ArrayBufferLike>,
    ) {
      try {
        const str =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        if (str.startsWith("{")) {
          const parsed = JSON.parse(str) as {
            action?: "subscribe" | "unsubscribe";
            type?: string;
            topic?: string;
            topics?: string[];
          };
          const kind = parsed.type ?? parsed.action;
          if (kind === "subscribe" && parsed.topic) {
            ws.subscribe(parsed.topic);
            ws.send(
              JSON.stringify({
                type: "subscribed",
                topic: parsed.topic,
                activeTopics: ws.subscriptions ?? [],
              }),
            );
          } else if (
            kind === "subscribe-all" ||
            (kind === "subscribe" && parsed.topics)
          ) {
            const list = parsed.topics ?? [...DASHBOARD_WS_TOPICS];
            for (const t of list) ws.subscribe(t);
            ws.send(
              JSON.stringify({
                type: "subscribed-many",
                topics: list,
                activeTopics: ws.subscriptions ?? [],
              }),
            );
          } else if (kind === "unsubscribe" && parsed.topic) {
            ws.unsubscribe(parsed.topic);
            ws.send(
              JSON.stringify({
                type: "unsubscribed",
                topic: parsed.topic,
                activeTopics: ws.subscriptions ?? [],
              }),
            );
          } else if (kind === "query-subscriptions") {
            ws.send(
              JSON.stringify({
                type: "subscriptions",
                activeTopics: ws.subscriptions ?? [],
              }),
            );
          }
        }
      } catch {
        // signal-honesty: intentional-ignore-nonjson-ws-ping
      }
    },
    close(ws: TWs) {
      clients.delete(ws);
    },
  };

  const buildWsStatusPayload = (): DashboardWsStatusPayload => {
    const topicCounts: Record<string, number> = {};
    const clientSummaries: Array<{ id: number; topics: readonly string[] }> =
      [];
    let clientId = 1;

    for (const ws of clients) {
      const subs = ws.subscriptions ?? [];
      clientSummaries.push({ id: clientId++, topics: [...subs] });
      for (const topic of subs) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }

    return {
      totalConnectedClients: clients.size,
      topicDistribution: topicCounts,
      clients: clientSummaries,
      serverTopics: [...DASHBOARD_WS_TOPICS],
      timestamp: new Date().toISOString(),
    };
  };

  return {
    websocket,
    buildWsStatusPayload,
  };
}

/** Broadcast a topic message once to every connected client subscribed to `topic` (or all if un-scoped). */
export function publishDashboardTopicEvent<TWs extends WsLike>(
  clients: Iterable<TWs>,
  topic: DashboardWsTopic,
  message: string,
): number {
  let delivered = 0;
  for (const ws of clients) {
    const subs = ws.subscriptions;
    if (!subs || subs.length === 0 || subs.includes(topic)) {
      ws.send(message);
      delivered++;
    }
  }
  return delivered;
}
