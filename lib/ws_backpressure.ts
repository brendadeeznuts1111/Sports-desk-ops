/**
 * @file ws_backpressure.ts
 * @description One backpressure policy for the `Bun.serve` websocket servers (live-bets gateway,
 * webview bridge hub).
 *
 * Measured on Bun 1.4.4 with a client that never reads: `ws.send` returns `-1` once the buffer is
 * building up, then `0` (message dropped, connection left open) past `backpressureLimit`. The same
 * holds for `server.publish`, and `closeOnBackpressureLimit` defaults to `false`, so a lagging
 * subscriber silently misses frames and the page desyncs without any signal. A closed socket is
 * recoverable (the client reconnects and resubscribes); a silent gap is not.
 */

/** Per-connection buffer cap. Frames are small JSON, so 1 MiB is many seconds of a stalled reader. */
export const WS_BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

/** RFC 6455 "unexpected condition"; the close reason clients can log and reconnect on. */
export const WS_CLOSE_BACKPRESSURE = 1011;

/**
 * `Bun.serve` websocket options that close a connection at the cap instead of dropping its
 * `server.publish` frames. Spread into the `websocket` handler object.
 */
export const WS_BACKPRESSURE_OPTIONS = {
  backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
  closeOnBackpressureLimit: true,
} as const;

/** The slice of `ServerWebSocket` the writer needs. */
export type WsFrameSocket = {
  send: (frame: string) => number;
  close: (code?: number, reason?: string) => void;
};

/**
 * Send one frame and close the socket when it was not delivered cleanly.
 *
 * `send` returns bytes sent (`> 0`), `-1` for backpressure and `0` for a dropped message; `0` is
 * also the result of an empty payload, which is a delivery, so it is excluded. Returns whether the
 * frame went out without backpressure.
 */
export function sendFrameOrClose(
  socket: WsFrameSocket,
  frame: string,
): boolean {
  const status = socket.send(frame);
  if (status > 0 || (status === 0 && frame === "")) return true;
  socket.close(WS_CLOSE_BACKPRESSURE, "backpressure");
  return false;
}
