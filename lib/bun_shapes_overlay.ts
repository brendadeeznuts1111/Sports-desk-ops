/**
 * @file bun_shapes_overlay.ts
 * @description The editorial half of the Bun shape catalogue: each shape's
 * subsystem (our taxonomy) and the evidence that pins its behaviour.
 *
 * Everything else about a row - which shapes exist, their kind, and their
 * heading - is derived by `scripts/bun_shapes_catalog.ts` from the usage scan
 * (the repo's own `Bun.*` calls) and `bun-types@1.4.4` declarations. Keep this
 * file to the two fields a compiler cannot supply.
 */

import type { ShapeSubsystem } from "./bun_shapes.ts";

export interface ShapeOverlay {
  readonly subsystem: ShapeSubsystem;
  /** `probe:<id>` | `test:<path>` | `surface:<check-name>`. */
  readonly evidence: readonly string[];
}

export const SHAPE_OVERLAY: Readonly<Record<string, ShapeOverlay>> =
  Object.freeze({
    $: {
      subsystem: "process",
      evidence: ["test:tests/bun_shapes_coverage.test.ts"],
    },
    allocUnsafe: {
      subsystem: "crypto",
      evidence: ["surface:allocUnsafe", "test:tests/bun_capabilities.test.ts"],
    },
    Archive: {
      subsystem: "storage",
      evidence: ["surface:Archive", "probe:storage.archive"],
    },
    argv: { subsystem: "process", evidence: ["probe:proc.shell"] },
    ArrayBufferSink: {
      subsystem: "crypto",
      evidence: ["probe:crypto.compress"],
    },
    build: {
      subsystem: "process",
      evidence: ["test:tests/bun_bundler_plugin_contract.test.ts"],
    },
    BunRequest: {
      subsystem: "network",
      evidence: ["test:tests/bun_request_contract.test.ts"],
    },
    color: { subsystem: "text", evidence: ["probe:text.ansi"] },
    concatArrayBuffers: {
      subsystem: "crypto",
      evidence: ["probe:crypto.compress"],
    },
    connect: {
      subsystem: "network",
      evidence: ["surface:connect", "test:tests/bun_capabilities.test.ts"],
    },
    Cookie: { subsystem: "data", evidence: ["probe:data.cookies"] },
    CookieMap: {
      subsystem: "data",
      evidence: ["surface:CookieMap", "test:tests/bun_capabilities.test.ts"],
    },
    cron: {
      subsystem: "storage",
      evidence: ["surface:cron", "test:tests/bun_capabilities.test.ts"],
    },
    CronController: {
      subsystem: "storage",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    CryptoHasher: { subsystem: "crypto", evidence: ["probe:crypto.hash"] },
    CSRF: { subsystem: "crypto", evidence: ["surface:CSRF"] },
    deepEquals: { subsystem: "data", evidence: ["probe:data.compare"] },
    dns: { subsystem: "network", evidence: ["surface:dns.lookup"] },
    enableANSIColors: { subsystem: "text", evidence: ["probe:text.ansi"] },
    env: { subsystem: "meta", evidence: ["probe:proc.shell"] },
    Env: {
      subsystem: "meta",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    escapeHTML: { subsystem: "text", evidence: ["probe:text.ansi"] },
    fetch: {
      subsystem: "network",
      evidence: ["surface:fetch", "test:tests/bun_capabilities.test.ts"],
    },
    FetchProxyOption: {
      subsystem: "network",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    FetchSession: {
      subsystem: "network",
      evidence: ["surface:FetchSession", "test:tests/bun_capabilities.test.ts"],
    },
    FetchSessionInit: {
      subsystem: "network",
      evidence: ["test:tests/fetch_session_contract.test.ts"],
    },
    file: { subsystem: "process", evidence: ["surface:file"] },
    FileSink: {
      subsystem: "process",
      evidence: ["probe:proc.terminal", "test:tests/bun_capabilities.test.ts"],
    },
    fileURLToPath: { subsystem: "process", evidence: ["probe:proc.paths"] },
    gc: { subsystem: "process", evidence: ["probe:proc.spawn"] },
    Glob: { subsystem: "data", evidence: ["probe:data.glob"] },
    gunzipSync: { subsystem: "crypto", evidence: ["probe:crypto.compress"] },
    gzipSync: { subsystem: "crypto", evidence: ["probe:crypto.compress"] },
    hash: { subsystem: "crypto", evidence: ["probe:crypto.hash"] },
    Image: {
      subsystem: "image",
      evidence: [
        "surface:Image",
        "test:tests/bun_capabilities.test.ts",
        "probe:image.metadata",
      ],
    },
    Import: {
      subsystem: "data",
      evidence: [
        "test:tests/bun_shapes_types.test-d.ts",
        "test:tests/nsh_desk_contract.test.ts",
      ],
    },
    ImportKind: {
      subsystem: "data",
      evidence: [
        "test:tests/bun_shapes_types.test-d.ts",
        "test:tests/nsh_desk_contract.test.ts",
      ],
    },
    indexOfLine: {
      subsystem: "data",
      evidence: [
        "test:tests/bun_index_of_line.test.ts",
        "test:tests/jsonl_stream_replay.test.ts",
        "test:tests/f402_bet_ticker_jsonl.test.ts",
      ],
    },
    inspect: {
      subsystem: "text",
      evidence: ["surface:inspect.table", "probe:text.inspect"],
    },
    isStandaloneExecutable: {
      subsystem: "process",
      evidence: ["surface:isStandaloneExecutable"],
    },
    JSON5: {
      subsystem: "data",
      evidence: ["surface:JSON5", "probe:data.parse"],
    },
    JSONC: { subsystem: "data", evidence: ["probe:data.json"] },
    JSONL: {
      subsystem: "data",
      evidence: [
        "surface:JSONL.parse",
        "surface:JSONL.parseChunk",
        "test:tests/bun_capabilities.test.ts",
        "probe:data.parse",
      ],
    },
    listen: {
      subsystem: "network",
      evidence: ["surface:listen", "test:tests/bun_capabilities.test.ts"],
    },
    main: { subsystem: "process", evidence: ["probe:proc.shell"] },
    markdown: { subsystem: "text", evidence: ["surface:markdown"] },
    nanoseconds: { subsystem: "process", evidence: ["probe:proc.timing"] },
    openInEditor: { subsystem: "process", evidence: ["probe:proc.paths"] },
    password: {
      subsystem: "crypto",
      evidence: ["surface:password", "test:tests/bun_capabilities.test.ts"],
    },
    Password: {
      subsystem: "crypto",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    pathToFileURL: {
      subsystem: "process",
      evidence: ["test:tests/bun_url_native_utils.test.ts"],
    },
    randomUUIDv7: { subsystem: "crypto", evidence: ["probe:crypto.hash"] },
    readableStreamToArrayBuffer: {
      subsystem: "crypto",
      evidence: [
        "surface:readableStreamToArrayBuffer",
        "test:tests/jsonl_stream_replay.test.ts",
      ],
    },
    RedisClient: {
      subsystem: "storage",
      evidence: ["surface:RedisClient", "test:tests/bun_capabilities.test.ts"],
    },
    resolveSync: { subsystem: "process", evidence: ["probe:proc.paths"] },
    revision: { subsystem: "meta", evidence: ["probe:proc.meta"] },
    s3: {
      subsystem: "storage",
      evidence: ["surface:s3", "test:tests/bun_s3client_contract.test.ts"],
    },
    S3Client: { subsystem: "storage", evidence: ["surface:S3Client"] },
    S3File: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    S3FilePresignOptions: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    S3ListObjectsOptions: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    S3ListObjectsResponse: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    S3Options: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    S3Stats: {
      subsystem: "storage",
      evidence: ["test:tests/bun_s3client_contract.test.ts"],
    },
    secrets: {
      subsystem: "storage",
      evidence: ["surface:secrets.get", "test:tests/bun_capabilities.test.ts"],
    },
    semver: {
      subsystem: "data",
      evidence: ["surface:semver.satisfies", "probe:data.semver"],
    },
    serve: {
      subsystem: "network",
      evidence: ["surface:serve", "test:tests/bun_capabilities.test.ts"],
    },
    Serve: {
      subsystem: "network",
      evidence: ["test:tests/live_bets_typed_server.test.ts"],
    },
    Server: {
      subsystem: "network",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    sleep: {
      subsystem: "process",
      evidence: ["surface:sleep", "probe:proc.timing"],
    },
    sleepSync: { subsystem: "process", evidence: ["probe:proc.timing"] },
    sliceAnsi: { subsystem: "text", evidence: ["surface:sliceAnsi"] },
    spawn: { subsystem: "process", evidence: ["surface:spawn"] },
    spawnSync: { subsystem: "process", evidence: ["probe:proc.spawn"] },
    sql: {
      subsystem: "storage",
      evidence: ["surface:sql", "test:tests/bun_capabilities.test.ts"],
    },
    SQL: {
      subsystem: "storage",
      evidence: ["surface:SQL", "test:tests/bun_capabilities.test.ts"],
    },
    stdin: { subsystem: "process", evidence: ["probe:proc.stdio"] },
    stdout: { subsystem: "process", evidence: ["probe:proc.stdio"] },
    stringWidth: { subsystem: "text", evidence: ["probe:text.width"] },
    stripANSI: {
      subsystem: "text",
      evidence: ["surface:stripANSI", "test:tests/nsh_desk_contract.test.ts"],
    },
    Terminal: {
      subsystem: "process",
      evidence: ["surface:Terminal", "probe:proc.terminal"],
    },
    TOML: { subsystem: "data", evidence: ["surface:TOML", "probe:data.parse"] },
    Transpiler: {
      subsystem: "data",
      evidence: ["surface:Transpiler", "test:tests/nsh_desk_contract.test.ts"],
    },
    udpSocket: {
      subsystem: "network",
      evidence: ["surface:udpSocket", "test:tests/bun_capabilities.test.ts"],
    },
    version: { subsystem: "meta", evidence: ["probe:proc.meta"] },
    version_with_sha: {
      subsystem: "meta",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    },
    WebView: { subsystem: "image", evidence: ["surface:WebView"] },
    which: {
      subsystem: "process",
      evidence: ["surface:which", "probe:proc.paths"],
    },
    wrapAnsi: { subsystem: "text", evidence: ["probe:text.width"] },
    write: { subsystem: "process", evidence: ["surface:write"] },
    XML: {
      subsystem: "data",
      evidence: [
        "surface:XML",
        "probe:data.parse",
        "test:tests/bun_xml_contract.test.ts",
      ],
    },
    YAML: { subsystem: "data", evidence: ["surface:YAML", "probe:data.parse"] },
    zstdCompress: { subsystem: "crypto", evidence: ["probe:crypto.compress"] },
    zstdCompressSync: {
      subsystem: "crypto",
      evidence: ["probe:crypto.compress"],
    },
    zstdDecompressSync: {
      subsystem: "crypto",
      evidence: ["probe:crypto.compress"],
    },
  });
