/**
 * @file bun_shapes_overlay.ts
 * @description The only hand-authored half of the Bun shape catalogue: each
 * shape's subsystem, plus evidence for the few shapes that no test, surface
 * probe or baseline can supply.
 *
 * Everything else is derived by `scripts/bun_shapes_catalog.ts` - membership
 * from the tracked-source usage scan, `kind`/`heading` from bun-types, and the
 * `test:`/`surface:` evidence refs from the files that actually exercise them.
 */

import type { ShapeSubsystem, WebGlobalCategory } from "./bun_shapes.ts";

export interface WebGlobalOverlaySpec {
  readonly category: WebGlobalCategory;
  readonly topic: string;
  readonly note?: string;
}

/**
 * Hand-authored taxonomy & desk invariants for Window-adjacent Web globals.
 * Runtime `typeof`, usage status, and static member surfaces are derived by
 * `scripts/bun_shapes_catalog.ts` and `scripts/bun_shape_members.ts`.
 */
export const WEB_GLOBAL_SPECS_BY_NAME: Readonly<
  Record<string, WebGlobalOverlaySpec>
> = Object.freeze({
  // Core URL & search
  URL: {
    category: "url",
    topic: "WHATWG URL",
    note: 'Full WHATWG URL (`URL.canParse`, `URL.parse`). `Bun.file(url)` accepts `file:` `URL` instances only (`new URL("s3://...")` throws `ERR_INVALID_URL_SCHEME`, whereas string `Bun.file("s3://bucket/key")` or `Bun.s3.file(...)` works) and ignores query strings.',
  },
  URLSearchParams: {
    category: "url",
    topic: "Query params",
    note: "Standalone or via `url.searchParams`.",
  },
  // Binary & Files
  Blob: {
    category: "binary",
    topic: "Binary blob",
    note: "Base of `BunFile`.",
  },
  File: {
    category: "binary",
    topic: "Web file",
    note: "Web File constructor; base alongside `Blob`.",
  },
  // Web Streams
  ReadableStream: {
    category: "streams",
    topic: "Byte streams",
    note: "Direct and byte streams (`ReadableStream.from`).",
  },
  WritableStream: {
    category: "streams",
    topic: "Byte streams",
    note: "WHATWG writable stream.",
  },
  TransformStream: {
    category: "streams",
    topic: "Byte streams",
    note: "WHATWG transform stream.",
  },
  // Encoding
  TextEncoder: {
    category: "encoding",
    topic: "Text encoding",
    note: "UTF-8 encoder.",
  },
  TextDecoder: {
    category: "encoding",
    topic: "Text encoding",
    note: "UTF-8 / text decoder.",
  },
  atob: {
    category: "encoding",
    topic: "Base64",
    note: "Base64 decode.",
  },
  btoa: {
    category: "encoding",
    topic: "Base64",
    note: "Base64 encode.",
  },
  // HTTP, fetch & WebSocket
  fetch: {
    category: "http",
    topic: "Fetch client",
    note: "Standard Fetch API (`fetch.preconnect` extension in Bun).",
  },
  Request: {
    category: "http",
    topic: "HTTP primitives",
    note: "Standard Fetch `Request`.",
  },
  Response: {
    category: "http",
    topic: "HTTP primitives",
    note: "Standard Fetch `Response` (`Response.json`, `error`, `redirect`).",
  },
  Headers: {
    category: "http",
    topic: "HTTP primitives",
    note: "Case-insensitive HTTP headers map.",
  },
  AbortController: {
    category: "http",
    topic: "Cancellation",
    note: "Cancellation controller for fetch/streams/timers.",
  },
  AbortSignal: {
    category: "http",
    topic: "Cancellation",
    note: "Cancellation signal (`AbortSignal.timeout`, `any`, `abort`).",
  },
  FormData: {
    category: "http",
    topic: "Multipart",
    note: "Multipart form container (`FormData.from`).",
  },
  WebSocket: {
    category: "http",
    topic: "WebSocket",
    note: "Client WebSocket constructor (`CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`).",
  },
  // Workers & messaging
  Worker: {
    category: "workers",
    topic: "Worker threads",
    note: "JS worker thread alternative to `Bun.spawn`.",
  },
  MessagePort: {
    category: "workers",
    topic: "Worker IPC",
    note: "Cross-worker messaging endpoint.",
  },
  MessageChannel: {
    category: "workers",
    topic: "Worker IPC",
    note: "Paired `MessagePort` channel.",
  },
  BroadcastChannel: {
    category: "workers",
    topic: "Worker IPC",
    note: "Pub/sub channel across workers in the same process.",
  },
  structuredClone: {
    category: "workers",
    topic: "Deep clone",
    note: "Deep structured clone.",
  },
  // WebCrypto
  crypto: {
    category: "crypto",
    topic: "WebCrypto",
    note: "WebCrypto (`getRandomValues`, `randomUUID`, `subtle`, `timingSafeEqual`).",
  },
  SubtleCrypto: {
    category: "crypto",
    topic: "WebCrypto",
    note: "WebCrypto subtle operations (`SubtleCrypto.supports`).",
  },
  CryptoKey: {
    category: "crypto",
    topic: "WebCrypto",
    note: "WebCrypto key handle.",
  },
  // Timers & Performance
  performance: {
    category: "timing",
    topic: "High-res timing",
    note: "High-resolution timing (`now`, `mark`, `measure`, `eventLoopUtilization`).",
  },
  setTimeout: {
    category: "timing",
    topic: "Timers & microtasks",
    note: "Standard timer.",
  },
  setInterval: {
    category: "timing",
    topic: "Timers & microtasks",
    note: "Standard repeating timer.",
  },
  queueMicrotask: {
    category: "timing",
    topic: "Timers & microtasks",
    note: "Microtask queue scheduler.",
  },
  // Console & CLI
  console: {
    category: "cli",
    topic: "Structured logging",
    note: "Structured console (`log`, `warn`, `error`, `table`, `write`).",
  },
  alert: {
    category: "cli",
    topic: "CLI prompts",
    note: "CLI-friendly prompt (not a browser dialog).",
  },
  confirm: {
    category: "cli",
    topic: "CLI prompts",
    note: "CLI-friendly y/n confirmation (not a browser dialog).",
  },
  prompt: {
    category: "cli",
    topic: "CLI prompts",
    note: "CLI-friendly stdin line prompt (not a browser dialog).",
  },
  // Events
  Event: {
    category: "events",
    topic: "DOM-free events",
    note: "DOM-free `Event` base class.",
  },
  EventTarget: {
    category: "events",
    topic: "DOM-free events",
    note: "DOM-free event dispatcher.",
  },
  CustomEvent: {
    category: "events",
    topic: "DOM-free events",
    note: "Typed `detail` event.",
  },
  MessageEvent: {
    category: "events",
    topic: "DOM-free events",
    note: "Worker/WebSocket message event.",
  },
  ErrorEvent: {
    category: "events",
    topic: "DOM-free events",
    note: "Error event payload.",
  },
  CloseEvent: {
    category: "events",
    topic: "DOM-free events",
    note: "WebSocket close event.",
  },
  // Realms & Errors
  ShadowRealm: {
    category: "realms",
    topic: "Isolated realms",
    note: "Stage 3 isolated evaluation realm.",
  },
  reportError: {
    category: "realms",
    topic: "Error hooks",
    note: "Unhandled error reporting hook.",
  },
});

/** Shapes whose evidence cannot be discovered from a test file or the surface probe. */
export const SHAPE_EVIDENCE_FALLBACK: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  argv: ["probe:proc.shell"],
  ArrayBufferSink: ["probe:crypto.compress"],
  color: ["probe:text.ansi"],
  concatArrayBuffers: ["probe:crypto.compress"],
  Cookie: ["probe:data.cookies"],
  CryptoHasher: ["probe:crypto.hash"],
  deepEquals: ["probe:data.compare"],
  enableANSIColors: ["probe:text.ansi"],
  env: ["probe:proc.shell"],
  escapeHTML: ["probe:text.ansi"],
  fileURLToPath: ["probe:proc.paths"],
  gc: ["probe:proc.spawn"],
  Glob: ["probe:data.glob"],
  gunzipSync: ["probe:crypto.compress"],
  gzipSync: ["probe:crypto.compress"],
  hash: ["probe:crypto.hash"],
  JSONC: ["probe:data.json"],
  main: ["probe:proc.shell"],
  nanoseconds: ["probe:proc.timing"],
  openInEditor: ["probe:proc.paths"],
  randomUUIDv7: ["probe:crypto.hash"],
  resolveSync: ["probe:proc.paths"],
  revision: ["probe:proc.meta"],
  sleepSync: ["probe:proc.timing"],
  spawnSync: ["probe:proc.spawn"],
  stdin: ["probe:proc.stdio"],
  stdout: ["probe:proc.stdio"],
  stringWidth: ["probe:text.width"],
  version: ["probe:proc.meta"],
  wrapAnsi: ["probe:text.width"],
  zstdCompress: ["probe:crypto.compress"],
  zstdCompressSync: ["probe:crypto.compress"],
  zstdDecompressSync: ["probe:crypto.compress"],
});

/** Our taxonomy. Not derivable: bun-types tags only 43 symbols with `@category`. */
export const SHAPE_SUBSYSTEMS_BY_NAME: Readonly<
  Record<string, ShapeSubsystem>
> = Object.freeze({
  $: "process",
  allocUnsafe: "crypto",
  Archive: "storage",
  argv: "process",
  MatchedRoute: "network",
  ArrayBufferSink: "crypto",
  build: "process",
  BunFile: "process",
  BunRequest: "network",
  color: "text",
  ColorInput: "text",
  concatArrayBuffers: "crypto",
  connect: "network",
  Cookie: "data",
  CookieMap: "data",
  cron: "storage",
  CronController: "storage",
  CryptoHasher: "crypto",
  CryptoHashInterface: "crypto",
  CSRF: "crypto",
  deepEquals: "data",
  deepMatch: "data",
  deflateSync: "crypto",
  dns: "network",
  embeddedFiles: "process",
  enableANSIColors: "text",
  env: "meta",
  Env: "meta",
  escapeHTML: "text",
  EventSource: "network",
  fetch: "network",
  FetchProxyOption: "network",
  FetchSession: "network",
  FetchSessionInit: "network",
  file: "process",
  FileSink: "process",
  FileSystemRouter: "network",
  fileURLToPath: "process",
  gc: "process",
  generateHeapSnapshot: "process",
  Glob: "data",
  gunzipSync: "crypto",
  gzipSync: "crypto",
  hash: "crypto",
  Image: "image",
  Import: "data",
  ImportKind: "data",
  indexOfLine: "data",
  inflateSync: "crypto",
  inspect: "text",
  isStandaloneExecutable: "process",
  isMainThread: "process",
  JSON5: "data",
  JSONC: "data",
  JSONL: "data",
  listen: "network",
  main: "process",
  markdown: "text",
  MD4: "crypto",
  MD5: "crypto",
  mmap: "process",
  ModuleGraph: "process",
  nanoseconds: "process",
  openInEditor: "process",
  password: "crypto",
  Password: "crypto",
  pathToFileURL: "process",
  peek: "process",
  plugin: "process",
  randomUUIDv5: "crypto",
  randomUUIDv7: "crypto",
  readableStreamToArray: "crypto",
  readableStreamToArrayBuffer: "crypto",
  readableStreamToFormData: "crypto",
  redis: "storage",
  RedisClient: "storage",
  ResourceUsage: "process",
  resolve: "process",
  resolveSync: "process",
  revision: "meta",
  s3: "storage",
  S3Client: "storage",
  S3File: "storage",
  S3FilePresignOptions: "storage",
  S3ListObjectsOptions: "storage",
  S3ListObjectsResponse: "storage",
  S3Options: "storage",
  S3Stats: "storage",
  secrets: "storage",
  semver: "data",
  serve: "network",
  Serve: "network",
  Server: "network",
  sha: "crypto",
  SHA1: "crypto",
  SHA224: "crypto",
  SHA256: "crypto",
  SHA384: "crypto",
  SHA512: "crypto",
  SHA512_256: "crypto",
  sleep: "process",
  sleepSync: "process",
  sliceAnsi: "text",
  spawn: "process",
  SpawnOptions: "process",
  spawnSync: "process",
  sql: "storage",
  SQL: "storage",
  stderr: "process",
  stdin: "process",
  stdout: "process",
  stringWidth: "text",
  stripANSI: "text",
  Subprocess: "process",
  Terminal: "process",
  TerminalOptions: "process",
  TOML: "data",
  Transpiler: "data",
  udpSocket: "network",
  unsafe: "process",
  version: "meta",
  version_with_sha: "meta",
  WebSocket: "network",
  WebView: "image",
  which: "process",
  Worker: "process",
  wrapAnsi: "text",
  write: "process",
  XML: "data",
  YAML: "data",
  zstdCompress: "crypto",
  zstdCompressSync: "crypto",
  zstdDecompress: "crypto",
  zstdDecompressSync: "crypto",
});
