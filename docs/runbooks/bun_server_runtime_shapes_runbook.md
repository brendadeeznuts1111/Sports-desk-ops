# Bun HTTP Server, WebSocket Handler & TLS Runtime Shapes Specification

This runbook defines the runtime contracts, TypeScript interface shapes, lifecycle mechanics, and architectural trade-offs for the native **Bun (v1.4+) HTTP Server**, **WebSocket Handler**, and **TLS Options** within the SportsDesk and Fantasy402 operational suite.

---

## 1. Architectural Overview & Design Rationales

SportsDesk leverages Bun's native C++ HTTP and WebSocket engine (built on top of `uWebSockets` and `BoringSSL`) rather than Node.js `http` or third-party frameworks. To build robust, high-frequency surveillance tools, live ticker streaming pipelines, and secure Telegram Mini App gateways, all server components adhere to three canonical runtime interfaces:

1. **`interface Server extends Disposable`**: The running server instance managing socket lifecycles, hot reloads, client IP resolution, in-memory routing, and kernel-level WebSocket pub/sub.
2. **`interface WebSocketHandler<T = undefined>`**: The bidirectional streaming contract handling per-socket state, backpressure relief, automated ping/pong frames, and topic multiplexing.
3. **`interface TLSOptions`**: The transport encryption specification configuring certificate chains, private keys, ALPN negotiation, and memory tuning.

---

## 2. Interface Shape 1: `Server extends Disposable`

The `Server` interface represents a running HTTP and WebSocket listener spawned via `Bun.serve()`. It extends the ECMAScript Explicit Resource Management `Disposable` contract (`Symbol.dispose`).

### 2.1 Complete TypeScript Declaration

```typescript
export interface Server extends Disposable {
  /**
   * Stop the server from accepting new connections.
   * @param closeActiveConnections If true, immediately terminates all connections (WebSockets close with code 1001)
   * @returns Promise that resolves when the server has stopped
   */
  stop(closeActiveConnections?: boolean): Promise<void>;

  /**
   * Close idle keep-alive connections without stopping the server.
   * @returns The number of connections closed
   */
  closeIdleConnections(): number;

  /**
   * Update handlers without restarting the server.
   * Only fetch, error, routes, and websocket can be updated.
   */
  reload(options: Serve.Options<undefined>): Server;

  /**
   * Make a request to the running server in-memory.
   * Evaluates the fetch handler directly without binding network ports or making TCP syscalls.
   */
  fetch(request: Request | string): Response | Promise<Response>;

  /**
   * Upgrade an HTTP request to a WebSocket connection.
   * @returns true if upgrade successful, false if failed
   */
  upgrade<T = undefined>(
    request: Request,
    options?: {
      headers?: Bun.HeadersInit;
      data?: T;
    },
  ): boolean;

  /**
   * Publish a message to all WebSocket clients subscribed to a topic.
   * @param compress Defaults to true, unlike ws.send() and ws.publish(). Only applies to clients that negotiated perMessageDeflate
   * @returns Bytes sent, 0 if dropped, -1 if backpressure applied
   */
  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob,
    compress?: boolean,
  ): ServerWebSocketSendStatus;

  /**
   * Get count of WebSocket clients subscribed to a topic.
   */
  subscriberCount(topic: string): number;

  /**
   * Get client IP address and port from the underlying socket.
   * @returns null for closed requests or Unix domain sockets
   */
  requestIP(request: Request): SocketAddress | null;

  /**
   * Set custom idle timeout for a request.
   * @param seconds Timeout in seconds, 0 to disable
   */
  timeout(request: Request, seconds: number): void;

  /**
   * Keep process alive while server is running.
   */
  ref(): void;

  /**
   * Allow process to exit if server is the only thing running on the event loop.
   */
  unref(): void;

  /** Number of in-flight HTTP requests */
  readonly pendingRequests: number;

  /** Number of active WebSocket connections */
  readonly pendingWebSockets: number;

  /** Server URL including protocol, hostname, and port */
  readonly url: URL;

  /** Listening port number */
  readonly port: number;

  /** Bound hostname or IP address */
  readonly hostname: string;

  /** Whether development mode is active */
  readonly development: boolean;

  /** Unique server instance identifier */
  readonly id: string;
}
```

### 2.2 Operational Mechanics & Method Invariants

#### 1. In-Memory Request Dispatching (`server.fetch`)

- **Direct Evaluation**: `server.fetch(request)` runs the server's registered routing pipeline directly in memory without initiating TCP handshakes or binding OS network ports.
- **CI / Testing Advantage**: In sandboxed environments or automated test runners where port binding (`listen(2)`) is restricted or prone to `EADDRINUSE` conflicts, test suites invoke `server.fetch(new Request("http://localhost/health"))` with zero socket allocation overhead.
- **Microsecond Latency**: Bypasses loopback IP stack encapsulation, evaluating responses in sub-microsecond intervals.

#### 2. Resource Management & Explicit Scope Disposal (`Disposable`)

- Implements `[Symbol.dispose]()`. In modern TypeScript/Bun runtimes using ECMAScript Explicit Resource Management:
  ```typescript
  {
    using server = Bun.serve({ fetch: handler });
    // Server is automatically stopped when scope exits via Symbol.dispose
  }
  ```
- `server.stop(true)` sends WebSocket close code `1001` (`Going Away`) across all active sockets and drains outstanding requests.

#### 3. Zero-Downtime Hot Handler Reloading (`server.reload`)

- Allows dynamic live-updating of `fetch`, `error`, `routes`, and `websocket` configurations without restarting the process or dropping active keep-alive HTTP or WebSocket connections.
- Used in SportsDesk daemons to reconfigure risk route thresholds or refresh Mini App templates on the fly.

#### 4. Socket Address & Syndicate Correlation (`server.requestIP`)

- Resolves `SocketAddress`:
  ```typescript
  export interface SocketAddress {
    readonly address: string;
    readonly port: number;
    readonly family: "IPv4" | "IPv6";
  }
  ```
- **Syndicate Correlation**: When running directly or behind a transparent proxy with `X-Forwarded-For` verification, `requestIP` provides the raw peer socket IP. SportsDesk uses this to correlate sharp sub-accounts wagering from identical `/24` CIDR blocks within sub-second intervals.

#### 5. Event Loop Steering (`ref()` vs `unref()`)

- By default, `Bun.serve()` calls `ref()`, keeping the Bun process alive indefinitely.
- Calling `server.unref()` permits background reporting daemons or CLI commands to serve transient health probes or webhooks while allowing the process to terminate naturally when batch workloads complete.

---

## 3. Interface Shape 2: `WebSocketHandler<T = undefined>`

The `WebSocketHandler<T>` interface defines the hooks and operational policies for full-duplex WebSocket connections upgraded via `server.upgrade(req, { data: sessionContext })`.

### 3.1 Complete TypeScript Declaration

```typescript
export interface WebSocketHandler<T = undefined> {
  /**
   * Called when a connection is opened.
   */
  open?(ws: ServerWebSocket<T>): void | Promise<void>;

  /**
   * Called when a message is received.
   */
  message(
    ws: ServerWebSocket<T>,
    message: string | Buffer,
  ): void | Promise<void>;

  /**
   * Called when a connection is closed.
   */
  close?(
    ws: ServerWebSocket<T>,
    code: number,
    reason: string,
  ): void | Promise<void>;

  /**
   * Called when the write buffer is drained after reaching backpressure limit.
   */
  drain?(ws: ServerWebSocket<T>): void | Promise<void>;

  /**
   * Called when an uncaught error occurs on the WebSocket connection.
   */
  error?(ws: ServerWebSocket<T>, error: Error): void | Promise<void>;

  /**
   * Enable per-message deflate compression.
   * @default false
   */
  perMessageDeflate?:
    | boolean
    | {
        compress?: boolean;
        decompress?: boolean;
      };

  /**
   * Maximum incoming message payload length in bytes.
   * @default 16777216 (16 MB)
   */
  maxPayloadLength?: number;

  /**
   * Inactivity timeout in seconds before closing the connection.
   * @default 120
   */
  idleTimeout?: number;

  /**
   * Maximum backpressure buffer in bytes before ws.send() returns -1 or drops.
   * @default 16777216 (16 MB)
   */
  backpressureLimit?: number;

  /**
   * Automatically send ping frames to client every idleTimeout / 2 seconds.
   * @default true
   */
  sendPings?: boolean;

  /**
   * Whether server.publish() sends messages to the socket that initiated the publish.
   * @default false
   */
  publishToSelf?: boolean;
}
```

### 3.2 Operational Mechanics & Stream Invariants

#### 1. Per-Socket Generic Session Context (`T`)

- When upgrading a connection in HTTP `fetch`:
  ```typescript
  server.upgrade(request, {
    data: {
      accountIdentifier: "MM800",
      agentIdentifier: "CUB22HR",
      subscribedChannels: ["L22.N1402", "L23.N0412"],
      connectedAtMs: Date.now(),
    } satisfies TickerSessionContext,
  });
  ```
- The context object is strongly typed on `ws.data` across all callbacks (`open`, `message`, `drain`, `close`).

#### 2. Kernel Pub/Sub Topic Multiplexing

- Instead of manually iterating through an array of WebSocket client sockets in JavaScript memory:
  ```typescript
  ws.subscribe("ticker:steam");
  ws.subscribe("alerts:syndicate");
  ```
- Broadcasters call `server.publish("ticker:steam", payload)`. The message is broadcasted down in native C++ memory directly to all subscribed sockets with zero intermediate V8/JSC array allocations.

#### 3. Backpressure Protection & The `drain()` Hook

- High-velocity bet streams (e.g., live whale sizing anomalies on `L23.N0412`) can overwhelm slow mobile clients connected via Telegram Mini Apps.
- When the socket's internal write buffer exceeds `backpressureLimit` (default 16 MB), `ws.send()` returns `-1` (backpressure applied) or `0` (dropped).
- The `drain(ws)` hook is triggered once the operating system drains the socket buffer back below safety thresholds, allowing resumption of pending ticket streams without memory exhaustion.

#### 4. Automated Keep-Alives (`sendPings: true`)

- Bun automatically handles RFC 6455 Ping/Pong frame heartbeats without user-space timers. Sockets that fail to respond within `idleTimeout` are cleanly dropped with code `1006` or `1001`.

---

## 4. Interface Shape 3: `TLSOptions`

The `TLSOptions` interface configures TLS termination inside `Bun.serve({ tls: { ... } })`.

### 4.1 Complete TypeScript Declaration

```typescript
export interface TLSOptions {
  /**
   * Path to private key file, or raw Buffer / string containing PEM key.
   * Supports arrays for multiple certificates (SNI).
   */
  key?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Path to certificate file, or raw Buffer / string containing PEM cert chain.
   * Supports arrays for multiple certificates (SNI).
   */
  cert?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Path to CA certificate file, or raw Buffer / string containing PEM CA.
   */
  ca?: string | Buffer | BunFile | Array<string | Buffer | BunFile>;

  /**
   * Passphrase for encrypted private key.
   */
  passphrase?: string;

  /**
   * Path to Diffie-Hellman parameters file.
   */
  dhParamsFile?: string;

  /**
   * Default server name for Server Name Indication (SNI).
   */
  serverName?: string;

  /**
   * Reduce memory usage at the cost of performance.
   * @default false
   */
  lowMemoryMode?: boolean;
}
```

---

## 5. Architectural Evaluation: Standalone Bun TLS vs Edge Nginx Reverse Proxy

A critical design decision in SportsDesk is **where** TLS termination occurs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ OPTION A: Standalone Bun TLS Termination                                    │
│                                                                             │
│ Client (HTTPS 443) ──► [ Bun.serve({ tls }) ]                               │
│                        ├── User-Space OpenSSL / BoringSSL Encryption        │
│                        └── ❌ Zero-Copy sendfile(2) DISABLED                 │
│                            (File bytes copied: Disk -> Kernel -> User -> TLS│
│                             -> Kernel -> NIC)                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ OPTION B: Edge Nginx Reverse Proxy (SportsDesk Production Standard)         │
│                                                                             │
│ Client (HTTPS 443) ──► [ Nginx (Edge TLS 1.3 / Let's Encrypt) ]             │
│                                │                                            │
│                        Unix Domain Socket / Plaintext Loopback              │
│                                ▼                                            │
│                        [ Bun.serve({ unix: "/run/sportsdesk/webview.sock" })│
│                        ├── Local Plaintext Socket (No TLS Overhead)         │
│                        └── ✅ Sub-Microsecond Lazy Handle Allocation         │
│                            (0.38 µs handle creation vs 45 µs readFileSync)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 The Zero-Copy Invariant & Boundary Conditions

- **Client Upload Specification**: In official Bun documentation, kernel zero-copy transfer (`sendfile(2)` on Linux, `copyfile` on macOS) is specified for **outbound client file uploads** (`fetch(url, { method: "POST", body: Bun.file(...) })`). This optimization activates exclusively under four strict conditions:
  1. File payload strictly exceeds 32 KB (under 32 KB, direct in-memory buffer reads outperform kernel syscall overhead).
  2. Unencrypted plain HTTP transport (no TLS encryption).
  3. Direct TCP connection (no intermediate HTTP/HTTPS proxy).
  4. Uncompressed transmission (no transfer compression).
- **Server Response Path Distinction**: On the server response path (`new Response(Bun.file(path))`), Bun constructs a lazy file handle pointer in user space without eagerly buffering disk bytes into memory. Handle construction requires ~0.67 µs, against 196.68 µs for an eager `Bun.file().text()` of a 154.1 KB file (`bun scripts/bench_server.ts`, 2026-11-02, Apple M4, single run). However, whether the subsequent socket write employs `sendfile(2)` or `writev`/`pread` is unproven in Bun's published documentation. SportsDesk avoids conflating outbound upload zero-copy claims with response streaming.
- **Micro-Benchmark Telemetry** (measured in `tests/sendfile_threshold.test.ts` on Bun v1.4.4):
  - **Handle Construction**: 0.49 µs (16 KB), 0.47 µs (64 KB), 0.21 µs (1 MB). Sub-microsecond and independent of payload size.
  - **End-to-End Socket Transfer**: 0.149 ms (16 KB), 0.191 ms (64 KB), 0.489 ms (1 MB).

### 5.2 Why SportsDesk Chooses Option B

1. **Eliminates TLS Encryption Overhead on the Event Loop**: Edge Nginx terminates TLS 1.3, allowing Bun to process requests over a local Unix domain socket (`/run/sportsdesk/webview.sock`) or loopback HTTP (`127.0.0.1:4020`) without CPU-intensive cryptographic framing.
2. **Removes Host TCP Port Exposure**: Using Unix domain sockets eliminates open TCP ports on the loopback interface, removing network attack surface and preventing local port collisions.
3. **Standardized Edge Security**: Nginx manages rate-limiting, DDoS mitigation, and automated Let's Encrypt certificate renewal (`certbot`) without requiring Bun process restarts.
4. **When Standalone Bun TLS is Appropriate**: Standalone `TLSOptions` is reserved for internal microservice-to-microservice mutual TLS (mTLS) across private VPC boundaries where no edge reverse proxy exists.

---

## 6. SportsDesk Production Server Alignment Matrix

| Interface / Feature            | SportsDesk Implementation Module                           | Operational Policy & Configuration                                                                                                                                   |
| :----------------------------- | :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Port Cascade**               | `sportsdesk_webview_server.ts`                             | Resolves via `BUN_PORT` → `PORT` → `NODE_PORT` → `3000`. Production defaults to `PORT=4020` in `.env`.                                                               |
| **Hostname Binding**           | `sportsdesk_webview_server.ts`                             | Default `0.0.0.0` (all interfaces), configurable to `127.0.0.1` for strict loopback.                                                                                 |
| **Unix Domain Socket**         | `sportsdesk_webview_server.ts`, `deploy_to_vps.sh`         | Binds to `BUN_SOCKET=/run/sportsdesk/webview.sock` for zero-TCP-port Nginx upstream proxying.                                                                        |
| **Error Boundary**             | `sportsdesk_webview_server.ts`                             | Implements `error(err)` hook returning structured 500 JSON, suppressing stack traces when `NODE_ENV=production`.                                                     |
| **Security Headers**           | `sportsdesk_webview_server.ts`                             | Omits deprecated `X-Frame-Options: ALLOWALL`; enforces `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;`. |
| **In-Memory Testing**          | `tests/server_error.test.ts`, `tests/bench_server.test.ts` | Evaluates routes via `server.fetch(req)` to eliminate port contention in sandboxes and CI.                                                                           |
| **Loopback Proxy Isolation**   | `.env`, `.env.example`, `deploy_to_vps.sh`                 | Sets `NO_PROXY=127.0.0.1,localhost,::1` to prevent corporate/CI proxy interception of loopback calls.                                                                |
| **Outbound Timeouts**          | `sportsdesk_telegram_bot.ts`, `sportsdesk_r2_sync.ts`      | Enforces `signal: AbortSignal.timeout(...)` across all outbound calls to prevent hanging event loops.                                                                |
| **FetchSession & Preconnect**  | `sportsdesk_telegram_bot.ts`                               | Uses `Bun.FetchSession` with `rejectUnauthorized: true` and boot-time `fetch.preconnect("https://api.telegram.org")`.                                                |
| **Connection Pool Bounds**     | `.env`, `deploy_to_vps.sh`                                 | Sets `BUN_CONFIG_MAX_HTTP_REQUESTS=256` to size the shared connection pool to SportsDesk throughput.                                                                 |
| **WebSocket Ticker (Roadmap)** | `fantasy402-ticker-watch`                                  | Implements `WebSocketHandler<TickerSessionContext>` with `perMessageDeflate: true`, `backpressureLimit: 16MB`, and topic pub/sub (`ticker:steam`, `ticker:whale`).   |
| **TLS Policy**                 | `deploy_to_vps.sh`                                         | Nginx terminates TLS 1.3 at port 443; Bun listens on Unix socket or plaintext loopback.                                                                              |

**Startup wiring (`PORT`, `SPORTSDESK_ALLOWED_ORIGINS`):** both must be in the service's environment,
not only in `.env`. When the `.env` pipe is absent (launchd, a bare shell), the port cascade falls to
`3000` and the server sends no `Access-Control-Allow-Origin` at all. Start it with
`PORT=4020 SPORTSDESK_ALLOWED_ORIGINS=https://dsh.bookdeskops.com bun run serve`; the latter is the
Harness Web UI origin allowed to read `:4020` from a browser.

---

## 7. Outbound Fetch Hardening & Network Isolation Specification

High-frequency surveillance operations dispatch outbound HTTP requests across Telegram Bot APIs, Cloudflare R2 backup endpoints, and Fantasy402 feeds. To ensure resiliency against network latency, proxy traps, and credential leaks, all outbound operations adhere to five strict runtime specifications:

### 7.1 Bounded Execution Windows (`AbortSignal.timeout`)

Every outbound network call must pass an explicit abort signal. Unbounded `await fetch(...)` calls are strictly prohibited:

```typescript
// Bounded Telegram dispatch with 5,000 ms timeout window
const res = await this.fetchSession.fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(timeoutMs),
});
```

If the remote upstream fails to respond within `timeoutMs`, the request aborts with a `TimeoutError`, caught and logged without stalling downstream alert processing.

### 7.2 Proxy Routing, Loopback Isolation & Direct Connect Rules

Bun provides built-in HTTP/HTTPS proxy capabilities with per-request dynamic evaluation and strict isolation semantics:

- **Per-Request Environment Resolution**: Bun reads `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` (upper or lower case) each time `fetch` runs. Any runtime modification to `process.env` immediately applies to the next request. `ALL_PROXY` serves as a fallback for both `http:` and `https:` targets when scheme-specific variables are omitted.
- **Loopback Trapping & `NO_PROXY` Matching**: Without explicit bypasses, requests to loopback addresses (`http://127.0.0.1:4020`) are trapped by ambient corporate or CI VPN proxies. Bun evaluates `NO_PROXY` (or `no_proxy`) separated by commas or whitespace, supporting exact hosts, wildcards (`*.example.com`), CIDR ranges (`10.0.0.0/8`, `fd00::/8`), bracketed IPv6 (`[::1]`), and port specifiers (`127.0.0.1:4020`). SportsDesk enforces `NO_PROXY=127.0.0.1,localhost,::1` across `.env`, `.env.example`, and deployment profiles.
- **Direct Connect Guarantee (`{ proxy: false }`)**: In security-critical or internal channels where proxying must never occur regardless of ambient environment variables, callers pass `{ proxy: false }` to mandate direct socket connection.
- **Explicit Proxy Invariants & `respectNoProxy`**: When an explicit proxy is provided (`fetch(url, { proxy: "http://proxy.com" })`), Bun continues to respect `NO_PROXY` rules by default. Callers can override this behavior using `{ proxy: { url: "...", respectNoProxy: false } }`.
- **Unix Domain Socket Isolation**: Requests using Bun's `unix` socket option (`{ unix: "/path/to.sock" }`) strictly bypass all proxy environment variables by design.
- **Tunnel Error Classification (`ERR_PROXY_TUNNEL`)**: When an upstream proxy answers a `CONNECT` request with a non-2xx status, Bun rejects with `error.code === "ERR_PROXY_TUNNEL"`, attaching `error.status`, `error.statusText`, and `error.headers` for diagnostic inspection. Verified continuously via `tests/fetch_proxy_isolation.test.ts`.

### 7.3 Dedicated `Bun.FetchSession` & Pre-Warming

Rather than using global unpooled `fetch`, `SportsDeskTelegramService` initializes an isolated `Bun.FetchSession`:

```typescript
this.fetchSession = new Bun.FetchSession({
  tls: {
    rejectUnauthorized: true, // Strict certificate validation
  },
});

// Boot-time pre-warming
if (
  typeof fetch !== "undefined" &&
  typeof (fetch as any).preconnect === "function"
) {
  (fetch as any).preconnect("https://api.telegram.org");
}
```

Pre-warming establishes the TCP connection and TLS 1.3 handshake at service startup, ensuring that the first high-urgency syndicate alert dispatches with zero handshake delay.

### 7.4 Zero Embedded Credentials & Strict TLS Policy

- **No Embedded Credentials in URLs**: URLs of the form `http(s)://user:password@hostname` are forbidden across the codebase to prevent credential exposure in access logs and error traces.
- **No `rejectUnauthorized: false`**: Disabling TLS verification creates CVE-vulnerable transport channels. SportsDesk enforces strict certificate validation across all runtime services. Verified continuously via `tests/fetch_url_credentials.test.ts`.

---

## 8. Low-Level Socket Networking & IPC Specification (`Bun.listen`, `Bun.connect`, `Bun.udpSocket`, `Bun.JSONL`)

For high-throughput downline ticker streams, sub-millisecond line surveillance, and local process inter-communication (MCP stdio / Unix domain sockets), SportsDesk standardizes on Bun's low-level C++ socket interfaces rather than Node's `net`/`dgram` abstractions. Verified against **Bun v1.4.4 (revision `1.4.4+38afee6c8`)**.

### 8.1 TCP & Unix Domain Socket Listener (`Bun.listen`)

_Official Documentation: [https://bun.com/docs/api/tcp](https://bun.com/docs/api/tcp)_

The `Bun.listen()` factory provisions raw TCP and Unix domain socket servers:

```typescript
export interface SocketListenerOptions<T = undefined> {
  hostname?: string;
  port?: number;
  unix?: string; // Path to Unix domain socket
  tls?: TLSOptions;
  socket: {
    open?(socket: Socket<T>): void | Promise<void>;
    data(socket: Socket<T>, data: Buffer): void | Promise<void>;
    drain?(socket: Socket<T>): void | Promise<void>;
    close?(socket: Socket<T>): void | Promise<void>;
    error?(socket: Socket<T>, error: Error): void | Promise<void>;
  };
}
```

- **Backpressure Mechanics**: `socket.write(data)` returns the number of bytes written synchronously. When this is less than the input size (or when the OS kernel write buffer is saturated), callers must pause and wait for the `drain(socket)` callback before sending additional chunks. It returns `-1` if the socket is closed or shutting down.
- **Unix Domain Socket IPC (No TCP Port Bound)**: Binds directly to `/run/sportsdesk/webview.sock` or `/tmp/*.sock`, eliminating TCP port exposure, loopback port contention, and corporate proxy interference.

### 8.2 Client Socket Connections (`Bun.connect`)

_Official Documentation: [https://bun.com/docs/api/tcp#bun-connect](https://bun.com/docs/api/tcp#bun-connect)_

`Bun.connect()` establishes outbound TCP, TLS, and Unix domain socket client streams:

```typescript
const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port: 4020,
  socket: {
    data(socket, buffer) {
      // Direct binary frame processing
    },
    open(socket) {
      socket.write("PING\n");
    },
    close(socket) {},
    error(socket, err) {},
  },
});
```

### 8.3 High-Frequency Datagram Telemetry (`Bun.udpSocket`)

_Official Documentation: [https://bun.com/docs/api/udp](https://bun.com/docs/api/udp)_

For loss-tolerant, low-latency odds tick streaming and syndicate volume pings:

```typescript
const socket = await Bun.udpSocket({
  port: 9876,
  socket: {
    data(socket, buf, port, addr, flags) {
      // Buffer passed to callback without intermediate copy
      // Truncation detection: flags.truncated indicates datagram exceeded buffer
      if (flags.truncated) {
        console.warn("Datagram was truncated by kernel receive buffer!");
      }
    },
    error(socket, err) {
      // ICMP Error Handling (ECONNREFUSED, host unreachable, TTL expired)
      // On modern Bun, ICMP errors surface here without silently closing the socket
      console.error("UDP socket error:", err.code);
    },
    drain(socket) {
      // Resume sending when buffer empties
    },
  },
});
// Dispatch datagram: returns false if packet does not fit OS buffer
const sent = socket.send("TICK:L23.N0412:RF2003:+$20000", 9876, "127.0.0.1");
if (!sent) {
  // Wait for drain(socket) before re-trying
}
```

- **Backpressure Contract**: `socket.send()` returns `false` when the datagram cannot fit in the OS socket buffer. `socket.sendMany()` returns a count smaller than the input packet array when saturated. In both conditions, `drain(socket)` fires when the kernel buffer is ready for more packets.
- **ICMP Error Resilience**: Unlike legacy runtimes where sending a datagram to an unreachable port caused the kernel to silently close the socket, Bun surfaces ICMP errors (`ECONNREFUSED`, host unreachable, TTL exceeded) through the `error` callback while keeping the socket open for subsequent sends.
- **Truncated Datagram Detection**: The `data` callback receives a fifth `flags` argument containing `{ truncated: boolean }`. This allows telemetry engines to differentiate partial packet reads from intact payloads when datagrams exceed the socket receive buffer.

### 8.4 Zero-Copy ASCII JSONL Stream Parsing (`Bun.JSONL`)

_Official Documentation: [https://bun.com/docs/runtime/jsonl](https://bun.com/docs/runtime/jsonl)_

For stdio and socket-based JSON-RPC transports (such as Model Context Protocol bridges in `opencode/mcp/stdio.ts`):

- **Native Streaming (`parseChunk`)**: Bun's C++ JSC parser decodes newline-delimited JSON chunks incrementally from `Uint8Array` binary streams without intermediate `TextDecoder` allocations or manual regex scanning. ASCII content is parsed directly without copying.
- **Zero-Copy Byte Slices**: `result.read` provides the exact byte offset consumed, enabling zero-copy buffer slicing via `buf.subarray(result.read)`.
- **FIFO Dispatch Ordering**: Writes to stdout/socket maintain strict dispatch sequence via queued slot promises, preventing race conditions between asynchronous handlers and immediate JSON-RPC 2.0 `-32700` parse error frames.

**SportsDesk Plane 3 implementation** (`sportsdesk_ingestion_replay.ts` → dotfiles `lib/cli/plane3-historical-log-replay.ts`):

- Append-only **`reports/ingestion-audit.jsonl`** (and **`reports/telegram-activity.jsonl`** for Telegram) — replay with **`bun run replay -- --path FILE [--markdown] [--bitemporal]`** or **`bun sportsdesk_cli.ts replay`**.
- ASCII **`channel_id`**, **`link_id`**, **`status`** fields stay on the JSONL fast path; resume with **`buf.subarray(result.read)`** (UTF-8 byte offset, not `String.slice`).
- Poison lines / crash tails: **`skipPoisonJsonlLine`** + **`corruptedLineSkips`** / **`trailingPartialBytes`** — never abort the full EOD replay for one bad line.
- Post-replay: **`Bun.XML.parse(xml, { compact: false })`** → board price, optional **`ColorHexInt`** via **`parseAsColorHexInt`**, pattern table (**SPIKE_UP** / **DOWN**) via **`Bun.markdown.render`** + registry hex colors.

### 8.5 Unix Domain Socket Dual-Endpoint Pattern & Node.js Lifecycle Alignment

_Official Documentation: [https://bun.com/docs/api/http#unix-domain-sockets](https://bun.com/docs/api/http#unix-domain-sockets)_

SportsDesk standardizes on matching Unix domain socket paths between server listeners and client fetch dispatchers:

```typescript
// 1. Server Listener (Zero TCP Port Exposure)
const server = Bun.serve({
  unix: "/run/sportsdesk/webview.sock",
  fetch(req) {
    return new Response("ok");
  },
});

// 2. Client Outbound Request (Bypasses all proxy environments)
const res = await fetch("http://localhost/health", {
  unix: "/run/sportsdesk/webview.sock",
});
```

#### Node.js / libuv Lifecycle Alignment

Bun matches Node.js / libuv Unix domain socket lifecycle semantics:

1. **Binding Collisions (`EADDRINUSE`)**: Binding to an existing `.sock` file on disk throws `EADDRINUSE` rather than silently unlinking and stealing the socket from another live daemon.
2. **Automatic Socket Cleanup**: Calling `server.stop()` or `listener.stop()` automatically unlinks and removes the `.sock` file from disk (`existsSync(path) === false`), preventing orphaned socket files from blocking subsequent process launches.

---

## 9. Native In-Process Web Automation & Viewport Auditing (`Bun.WebView`)

_Official Documentation: [https://bun.com/docs/runtime/webview](https://bun.com/docs/runtime/webview)_

SportsDesk standardizes on native `Bun.WebView` for live Telegram Mini App viewport auditing, Fantasy402 Manager DOM forensic verification, and accessibility gates. This replaces external Playwright and Puppeteer with a lightweight in-process webview engine. "Zero dependencies" holds only on macOS, where the default `webkit` backend uses the system WKWebView; on Linux and Windows the `chrome` backend needs an installed Chrome, Chromium, Edge, or Brave (the preinstalled Edge is enough on Windows).

### 9.1 Core Architectural Principles

- **OS-Level Event Dispatching (`isTrusted: true`)**: All mouse, keyboard, and scroll inputs are dispatched as operating-system-level events. Monitored sites and anti-bot systems cannot distinguish `view.click()` from physical hardware input (`isTrusted: true`).
- **Playwright-Style Actionability Auto-Waiting**: Selector-based operations automatically wait for the target element to be attached to the DOM, visible, layout-stable, and unobscured before dispatching actions.
- **Explicit Resource Management**: Implements `Disposable` and `AsyncDisposable`, enabling deterministic scope cleanup via `await using view = new Bun.WebView(...)`.
- **Process Model & Tab Pooling**: One browser subprocess is shared per Bun process; subsequent `new Bun.WebView()` instances open isolated tabs within that existing subprocess.

### 9.2 API Reference & Operational Methods

```typescript
await using view = new Bun.WebView({
  width: 1280,
  height: 800,
  backend: "webkit", // "webkit" | "chrome" | { type: "chrome", path: string, argv: string[] }
  console: globalThis.console, // or (type, ...args) => void; `true` throws TypeError (ERR_INVALID_ARG_TYPE)
});

await view.navigate("https://fantasy402.com/manager");
await view.click("th[data-language='L-1029']"); // Auto-waits for actionability
await view.scrollTo("#kpi-cards");
const title = await view.evaluate("document.title");
const jpeg = await view.screenshot({ format: "jpeg", quality: 90 });
await Bun.write("reports/audit_viewport.jpg", jpeg);
```

> **Console capture takes an object or a function, not a boolean.** `console: true` throws
> `TypeError` with code `ERR_INVALID_ARG_TYPE` (measured on Bun 1.4.4). Pass
> `globalThis.console` to mirror page output to Bun's console, or a
> `(type, ...args) => void` callback to receive each call yourself (this is what
> `scripts/capture/webview.ts` and `scripts/audit_docs_webview_cron.ts` do).

> **WebP.** Raw `view.screenshot({ format: "webp" })` is Chrome-only — the WebKit backend
> throws. The repo wrapper re-encodes: `scripts/capture/webview.ts`
> (`needsBunImageTransform`) captures a PNG and converts with `Bun.Image`, so
> `./bin/dx shot --format webp` works on both backends.

| Method / Property                          | Description                                                                                                | SportsDesk Surveillance Application                              |
| :----------------------------------------- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `navigate(url)`                            | Navigates to target HTTP/HTTPS URL                                                                         | Direct navigation to Fantasy402 Manager / Desk routes            |
| `evaluate(expr)`                           | Evaluates JavaScript expression in page context                                                            | DOM extraction of `data-language="L-1029"` headers and KPI cards |
| `screenshot({format, quality, encoding})`  | Captures JPEG, PNG, or WebP viewport (raw WebP is Chrome-only; the wrapper re-encodes PNG via `Bun.Image`) | Automated forensic proof capture for whale ticket anomalies      |
| `click(x, y)` / `click(selector)`          | Native OS mouse click with auto-wait                                                                       | Interactive navigation across Manager tab bars                   |
| `type(text)`                               | Types text into currently focused element                                                                  | Automated credentials dispatch in testing environments           |
| `press(key, {modifiers})`                  | Presses key with optional modifier flags                                                                   | Keyboard navigation and shortcut verification                    |
| `scroll(dx, dy)` / `scrollTo(selector)`    | Native wheel scroll or scroll-to-element                                                                   | Infinite scroll pagination of pending ticket tickers             |
| `goBack()` / `goForward()` / `reload()`    | Viewport navigation controls                                                                               | Session revalidation after token expiration                      |
| `resize(w, h)`                             | Dynamically resizes viewport dimensions                                                                    | Telegram Mini App mobile (390x844) vs desktop testing            |
| `cdp(method, params)`                      | Raw Chrome DevTools protocol command (Chrome only; requires a prior `navigate()`)                          | Low-level network interception and cookie extraction             |
| `view.url` / `view.title` / `view.loading` | Synchronous page state properties                                                                          | Polling state assertions during navigation sequences             |

#### Operation slots: one call per kind, awaited

Each view has independent operation slots, and **one operation of each kind may be in flight at a time**:

- one `navigate()` — shared with `reload()` / `goBack()` / `goForward()` on the Chrome backend
- one `evaluate()`
- one `screenshot()`
- one `cdp()` (Chrome only)
- one "simple" slot shared by `click()`, `type()`, `press()`, `scroll()`, `scrollTo()` and `resize()` (plus history on WebKit)

Starting a second operation while its slot is occupied throws `ERR_INVALID_STATE` **synchronously** — it does not queue. Two shipped scripts hit exactly these rules: one started a second `cdp()` before the first settled (now queued through a single promise chain in `scripts/capture/f402_manager_boot_har.ts`), the other called `cdp("Network.enable")` before the first `navigate()` (now moved after login in `scripts/capture/f402_probe.ts`). Every call must be awaited, and `cdp()` only works after `await view.navigate(...)`. On WebKit, `cdp()` throws `ERR_METHOD_NOT_IMPLEMENTED`.

#### Viewport geometry differs by backend

Measured on Bun 1.4.4, macOS + Chrome 156: with the Chrome backend the constructor `width`/`height` size the **outer** window, not the viewport — `innerHeight` comes out as `height - 87` and `innerWidth` is floored at 500. Use `await view.resize(w, h)` when you need the documented viewport size. WebKit honors the constructor as a viewport, and its screenshots are device-pixel: a 1440x900 view yields a 2880x1800 PNG on a Retina display.

#### `dataStore` is process-wide on Chrome, per-view on WebKit

`dataStore.directory` is the persistence switch: the default is `"ephemeral"` (cookies, `localStorage`,
IndexedDB and cache discarded when the view closes), and a directory keeps them across runs. The two
backends do not mean the same thing by it.

- **Chrome**: `dataStore.directory` maps to `--user-data-dir` and applies to the **entire Chrome
  process**, not to the view. Bun spawns Chrome once per Bun process, so the **first view's directory
  wins** and a later view requesting a different directory is ignored. `scripts/capture/webview.ts`
  records the directory that actually won (`noteChromeDataStoreDir`) and prints one
  `[webview] chrome dataStore: ignoring … (first view wins)` warning instead of pretending the request
  applied. For capture work that means one profile per Bun process: two views cannot use two profiles,
  and isolation needs two processes.
- **WebKit**: each view has its own data store, so the requested directory is honoured per view.
  Persistent storage there requires **macOS 15.2+**; on older macOS pass `dataStore: "ephemeral"` (the
  default). Wrapper behaviour on Bun 1.4.4, matching the published `Bun.WebView` persistent-storage
  notes.

#### One Chrome profile per process: the sibling lock

Chrome's profile singleton is per directory, so two Bun processes opening the same `dataStore` do not
isolate: the second collides on the singleton and Chrome reports an opaque `Chrome process closed the
pipe`, which names neither the conflict nor its owner. The capture scripts
(`scripts/capture/f402_manager_boot_har.ts`, `f402_probe.ts`, `batch_pending_delete_session.ts`,
`probe_f402_protocol_matrix.ts`) and the profile session bridge now take a sibling lock at
`<profileDir>.bun-webview.lock` (`lib/f402_profile_lock.ts`, Bun 1.4.4):

- the file records `{ pid, startedAt }` **beside** the profile, never inside it, so Chrome never sees
  an unexpected entry;
- a live pid with a fresh `startedAt` makes the second `acquireProfileLock()` throw
  `ProfileInUseError`, naming the holder pid and start time — fail fast, before a WebView launches,
  instead of the pipe error;
- a lock whose pid is gone (`process.kill(pid, 0)` → `ESRCH`) or older than the 12 h stale window is
  replaced;
- the lock is released on scope exit (`using`), on `release()`, and from a `process.once("exit")` hook,
  because `process.exit()` skips dispose scopes.

What the lock cannot see: an **external** Chrome started on the same `--user-data-dir` — the manual MFA
bootstrap, or a browser the operator left open. It holds no lock file, so it is outside this protocol
and still produces the pipe error. Quit it before a capture run.

#### A profile is not a session

`Bun.FetchSession` has no `dataStore`, so `createF402ReplayTransport()` never opens a WebView profile;
a directory full of signed-in cookies still sends a cookie-less request. The bridge is explicit:

```sh
bun run session:login --from-profile <dir>
```

If a WebView command fails with `Chrome process closed the pipe`, the cause is on Chrome's stderr,
not in the keychain: run `bun run session:status --diagnose` first. It probes a minimal headless
page, prints the Chrome binary and the classified failure (`sandbox-denied`, `gpu-denied`,
`crashpad-denied`, `profile-locked`, `not-found`) plus remediation. A sandbox denial means the
command is running inside a restrictive agent/CI sandbox — run it in a normal terminal; do **not**
add `--no-sandbox` to make a credential login pass.

`lib/f402_profile_session.ts` launches that profile in a headless Chrome WebView, navigates to the
portal origin, reads every cookie over CDP (`Network.getAllCookies`), keeps the ones scoped to the
portal host, and writes the 0600 session file (`F402_SESSION_FILE`, default
`~/.cache/sportsdesk/f402-session.json`) that the transport reads. The view is closed in a `finally`,
and a profile with no scoped cookies throws `ProfileSessionError` rather than minting a session of
401s. `bun run session:status` reports which of proxy / session-file / anonymous the transport would
use without printing a cookie value. The bridge takes the same profile lock, so exporting while a
capture holds that profile fails fast instead of colliding inside Chrome.

#### Teardown: `close()` per view, `closeAll()` only at exit

`ManagedWebView.close()` is the teardown; it calls the synchronous, idempotent `view.close()` and never
escalates. `Bun.WebView.closeAll()` SIGKILLs the shared browser process, so the wrapper reserves it for
the `process.once("exit")` net. Launching a new Chrome view immediately after `closeAll()` is racy:
measured on Bun 1.4.4, the first launch fails with `Chrome process closed the pipe` and the same launch
succeeds roughly one second later. Do not use `closeAll()` to reset state between views — close each
view and let the process-exit net handle the rest.

---

### Uploading screenshots to the blob gateway

`./bin/dx shot` can hand the captured file to the hardened blob gateway. The gateway
(`services/blob_and_live_bets_server.ts`) validates the bearer token, caps the upload, decodes with
`Bun.Image`, downscales only when the capture exceeds 1280px (never upscales), and stores
`blobs/<key>.webp`; the client then verifies the stored object through `GET ?download=1`.

```sh
BLOB_API_TOKEN=... ./bin/dx shot --f402-login --f402-page /manager \
  --out scratch/shots/manager.png --upload-blob \
  --blob-gateway http://127.0.0.1:4021 --blob-key gslive-manager-evidence
```

- `--upload-blob` requires the default file encoding (`--encoding blob`) and `BLOB_API_TOKEN`.
- `--blob-gateway` overrides `BLOB_GATEWAY_URL`/`BLOB_PORT` (default loopback `4021`).
- The final JSON adds `blob: {key, objectKey, bytesWritten, width, height, url}` after the PUT and
  the download verification both succeed; a failed upload exits non-zero after the local file is
  written, so the screenshot is never lost silently.

## 10. Explicit Resource Management & JavaScriptCore Upgrades

Bun v1.4+ features an upgraded WebKit JavaScriptCore (JSC) engine with native support for TC39 Explicit Resource Management:

### 10.1 `using` and `await using` Declarations

All long-lived resources across SportsDesk implement `[Symbol.dispose]` or `[Symbol.asyncDispose]`:

```typescript
// Synchronous disposal (Bun.serve, Bun.cron)
function runHealthCheck() {
  using server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  // server[Symbol.dispose]() called deterministically on return
}

// Asynchronous disposal (Bun.WebView, DB connections)
async function auditPortal() {
  await using view = new Bun.WebView({ width: 800, height: 600 });
  await view.navigate("http://localhost:4020");
  // view[Symbol.asyncDispose]() awaited deterministically on return
}
```

### 10.2 JavaScriptCore Optimizations & Native Async Stack Traces

- **Native Async Stack Traces**: Complete async stack traces are preserved across native APIs (`node:fs`, `Bun.write`, `node:http`, `node:dns`), drastically reducing troubleshooting time for hanging network pipes.
- **JIT Inlining & Intrinsics**: `Array.isArray()` is implemented as a direct JIT intrinsic; `String#includes` utilizes single-character search optimizations; promise resolution reactions run via optimized `PerformPromiseThen` nodes.

---

## 11. Outbound Proxy CONNECT Tunnel Pooling

When routing outbound traffic through enterprise HTTP/HTTPS proxies, Bun's HTTP engine maintains a keep-alive pool of established TLS `CONNECT` tunnels:

- Subsequent HTTPS requests to the same remote host reuse existing proxy tunnels rather than re-negotiating TCP + TLS handshakes through the proxy for every request.
- Dramatically cuts latency on high-frequency external polling (e.g., Telegram Bot API and Cloudflare API calls).

---

## 12. Terminal Markdown Rendering (`Bun.markdown.ansi`) & OSC 8 Integration

Bun provides zero-startup native Markdown rendering directly to the terminal:

- **CLI Rendering**: Executing `bun ./file.md` renders formatted ANSI output directly to `stdout`.
- **Programmatic API**: `Bun.markdown.ansi(markdownString, options)` generates styled ANSI strings with support for OSC 8 clickable terminal hyperlinks (`{ hyperlinks: true }`), terminal column wrapping (`{ columns: 80 }`), and inline Kitty Graphics Protocol imagery (`{ kittyGraphics: true }`).
- SportsDesk standardizes on `Bun.markdown.ansi` in `lib/canonical_osc8_links.ts` and `sportsdesk_cli.ts` for rendering interactive operational briefs directly inside developer and operator terminals.
