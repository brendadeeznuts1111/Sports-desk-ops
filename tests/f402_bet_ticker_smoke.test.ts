import { afterEach, describe, expect, test } from "bun:test";

import {
  F402_BET_TICKER_LIVE_CHANNEL,
  projectF402TickerDelta,
} from "../lib/f402_bet_ticker_delta.ts";
import { createF402BetTickerSink } from "../lib/f402_bet_ticker_sink.ts";
import type { F402TickerRow } from "../lib/f402_ingest.ts";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";

const API_TOKEN = "smoke-api-token";
const TICKET_SECRET = "smoke-ticket-secret";
const TIMEOUT_MS = 3_000;

const servers: (() => void)[] = [];
afterEach(() => {
  for (const stop of servers.splice(0)) stop();
});

function start(): { readonly url: string; readonly wsUrl: string } {
  const { server, close } = createBlobLiveBetsServer({
    blobs: new MemoryBlobStore(),
    apiToken: API_TOKEN,
    ticketSecret: TICKET_SECRET,
    port: 0,
    hostname: "127.0.0.1",
  });
  servers.push(() => close(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/ws/live-bets`,
  };
}

async function ticket(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/ws-tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { ticket: string }).ticket;
}

function openSocket(wsUrl: string, wsTicket: string): Promise<WebSocket> {
  const ws = new WebSocket(`${wsUrl}?ticket=${wsTicket}`);
  const opened = new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ws open timeout")),
      TIMEOUT_MS,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws open failed"));
    };
  });
  return opened;
}

function nextJsonMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ws message timeout")),
      TIMEOUT_MS,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

const ROW: F402TickerRow = {
  login: "TESTLOGIN",
  customerId: "TESTCUST",
  agentId: "TESTAGENT",
  agentLogin: "TESTAGENTLOGIN",
  ticketWriter: "GSLIVE",
  wagerNumber: "9001",
  ticketNumber: "",
  wagerType: "S",
  shortDesc: "Basketball - Team C vs Team D / Game / Spread / Team C -2.5 -110",
  insertedAt: "2026-11-03T18:00:00.000Z",
  vip: "0",
  amountWagered: 100,
  toWinAmount: 90,
  volumeAmount: 100,
};

describe("bridge 3a local smoke", () => {
  test("the sink publishes to a subscribed gateway client over real HTTP + WS", async () => {
    const h = start();
    const ws = await openSocket(h.wsUrl, await ticket(h.url));
    try {
      const subscribed = nextJsonMessage(ws);
      ws.send(
        JSON.stringify({
          type: "SUBSCRIBE",
          channel: F402_BET_TICKER_LIVE_CHANNEL,
        }),
      );
      const ack = await subscribed;
      expect(ack).toMatchObject({
        type: "SUBSCRIBED",
        channel: F402_BET_TICKER_LIVE_CHANNEL,
      });
      expect(Array.isArray((ack as { channels?: unknown }).channels)).toBe(
        true,
      );

      const received = nextJsonMessage(ws);
      const sink = createF402BetTickerSink({
        liveBets: true,
        r2: false,
        gatewayUrl: h.url,
        apiToken: API_TOKEN,
      });
      const event = projectF402TickerDelta(
        [],
        [ROW],
        "2026-11-03T18:00:00.000Z",
      );
      const result = await sink.publishLiveBets(event);
      expect(result.ok).toBe(true);
      expect(result.published).toBeGreaterThanOrEqual(1);

      const payload = await received;
      expect(payload.kind).toBe("f402-bet-ticker");
      expect(payload.schemaVersion).toBe(1);
      expect(payload.watermark).toBe("9001");
      expect(JSON.stringify(payload)).not.toContain("TESTLOGIN");
      expect(JSON.stringify(payload)).not.toContain("Team C");
    } finally {
      ws.close();
    }
  });

  test("an unauthenticated publish is rejected by the local gateway", async () => {
    const h = start();
    const response = await fetch(`${h.url}/api/v1/live-bets`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({
        channel: F402_BET_TICKER_LIVE_CHANNEL,
        event: {},
      }),
    });
    expect(response.status).toBe(401);
  });
});
