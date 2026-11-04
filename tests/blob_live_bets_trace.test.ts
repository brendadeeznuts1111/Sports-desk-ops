import { describe, expect, test } from "bun:test";

interface TraceStep {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string>;
  };
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
  readonly websocket?: readonly {
    readonly direction: string;
    readonly data: string;
  }[];
}

interface Trace {
  readonly kind: string;
  readonly note: string;
  readonly gateway: string;
  readonly steps: readonly TraceStep[];
}

const raw = await Bun.file(
  "tests/fixtures/captures/blob-live-bets/loopback-trace.json",
).text();
const trace = JSON.parse(raw) as Trace;

describe("blob/live-bets loopback trace fixture", () => {
  test("is labelled a fixture and covers every gateway operation", () => {
    expect(trace.kind).toBe("loopback-fixture");
    expect(trace.note).toContain("cannot upgrade a ledger tier");
    expect(trace.gateway).toBe("surface.blob-live-bets");
    expect(trace.steps.map((step) => step.name)).toEqual([
      "get-health",
      "post-ws-ticket",
      "get-presigned-blob",
      "put-blob",
      "post-publish",
      "ws-live-bets",
    ]);
  });

  test("carries no bearer token, ticket secret or raw presigned URL", () => {
    expect(raw).not.toContain("trace-api-token-not-a-secret");
    expect(raw).not.toContain("trace-ticket-secret-not-a-secret");
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("r2.example.invalid");
    for (const step of trace.steps) {
      if ("authorization" in step.request.headers) {
        expect(step.request.headers.authorization).toBe("<redacted>");
      }
    }
    expect(
      JSON.stringify(
        trace.steps.find((s) => s.name === "get-presigned-blob")?.response.body,
      ),
    ).toContain("<presigned-url-redacted>");
  });

  test("records auth, bounds and WebSocket negotiation", () => {
    const byName = new Map(trace.steps.map((step) => [step.name, step]));
    expect(byName.get("get-presigned-blob")?.response.status).toBe(302);
    expect(byName.get("put-blob")?.response.status).toBe(200);
    expect(byName.get("put-blob")?.response.body).toMatchObject({
      width: 1,
      height: 1,
    });
    expect(byName.get("post-publish")?.response.body).toMatchObject({
      channel: "alerts",
    });
    const ws = byName.get("ws-live-bets")?.websocket ?? [];
    expect(ws.some((frame) => frame.data.includes("PONG"))).toBe(true);
    expect(ws.some((frame) => frame.data.includes("SUBSCRIBED"))).toBe(true);
    expect(ws.some((frame) => frame.data.includes("UNSUBSCRIBED"))).toBe(true);
  });
});
