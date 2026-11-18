import { connect, createServer, type Server, type Socket } from "node:net";

/** A loopback CONNECT proxy that records each request head; `mode: "407"` refuses every tunnel. */
export interface ConnectProxy {
  readonly url: string;
  readonly heads: string[];
  /** Local port of each upstream socket, as the target sees it. */
  readonly tunnelPorts: number[];
  mode: "tunnel" | "407";
  close(): void;
}

export async function startConnectProxy(): Promise<ConnectProxy> {
  const sockets = new Set<Socket>();
  const heads: string[] = [];
  const tunnelPorts: number[] = [];
  const state: { mode: "tunnel" | "407" } = { mode: "tunnel" };
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    sock.once("data", (buf) => {
      const head = buf.toString("latin1");
      heads.push(head);
      if (state.mode === "407") {
        sock.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm="desk"\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      const match = /^CONNECT ([^:\s]+):(\d+) /.exec(head);
      if (match === null) {
        sock.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(Number(match[2]), match[1], () => {
        if (upstream.localPort !== undefined) {
          tunnelPorts.push(upstream.localPort);
        }
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(sock);
        sock.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => sock.destroy());
    });
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("proxy has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    heads,
    tunnelPorts,
    get mode() {
      return state.mode;
    },
    set mode(value) {
      state.mode = value;
    },
    close() {
      for (const sock of sockets) sock.destroy();
      server.close();
    },
  };
}
