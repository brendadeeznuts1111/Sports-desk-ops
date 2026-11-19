#!/usr/bin/env bun
/**
 * @file scripts/diff-bun-globals.ts
 * @description Diffs `Object.getOwnPropertyNames(globalThis)` against the 63 documented
 * globals on https://bun.com/docs/runtime/globals.
 *
 * Usage:
 *   bun scripts/diff-bun-globals.ts
 *   bun scripts/diff-bun-globals.ts --include-es
 *   bun scripts/diff-bun-globals.ts --json
 */

const DOCUMENTED_GLOBALS = [
  // Bun (3)
  "Bun",
  "BuildMessage",
  "ResolveMessage",
  // Cloudflare (1)
  "HTMLRewriter",
  // Cross-platform (3)
  "globalThis",
  "JSON",
  "ShadowRealm",
  // Node.js (8)
  "Buffer",
  "__dirname",
  "__filename",
  "exports",
  "global",
  "module",
  "process",
  "require",
  // Web (48)
  "AbortController",
  "AbortSignal",
  "alert",
  "atob",
  "Blob",
  "btoa",
  "ByteLengthQueuingStrategy",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "confirm",
  "console",
  "CountQueuingStrategy",
  "Crypto",
  "crypto",
  "CryptoKey",
  "CustomEvent",
  "DOMException",
  "Event",
  "EventTarget",
  "fetch",
  "FormData",
  "Headers",
  "MessageEvent",
  "performance",
  "prompt",
  "queueMicrotask",
  "ReadableByteStreamController",
  "ReadableStream",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "reportError",
  "Request",
  "Response",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "SubtleCrypto",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "TransformStreamDefaultController",
  "URL",
  "URLSearchParams",
  "WebAssembly",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter",
] as const;

// CJS/ESM module-wrapper bindings documented as globals, not own properties on globalThis
const MODULE_SCOPED_BINDINGS = new Set([
  "__dirname",
  "__filename",
  "exports",
  "module",
  "require",
]);

// Standard ECMAScript built-in globals (filtered out by default to isolate host/runtime drift)
const ES_BUILTINS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "decodeURI",
  "decodeURIComponent",
  "DisposableStack",
  "AsyncDisposableStack",
  "encodeURI",
  "encodeURIComponent",
  "Error",
  "escape",
  "eval",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Intl",
  "isFinite",
  "isNaN",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "parseFloat",
  "parseInt",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "undefined",
  "unescape",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
]);

const includeEs = Bun.argv.includes("--include-es");
const asJson = Bun.argv.includes("--json");

const docSet = new Set<string>(DOCUMENTED_GLOBALS);
const liveNames = Object.getOwnPropertyNames(globalThis);
const liveSet = new Set<string>(liveNames);

const documentedAndPresent = DOCUMENTED_GLOBALS.filter((k) =>
  liveSet.has(k),
).sort();
const documentedModuleScoped = DOCUMENTED_GLOBALS.filter(
  (k) => !liveSet.has(k) && MODULE_SCOPED_BINDINGS.has(k),
).sort();
const documentedMissing = DOCUMENTED_GLOBALS.filter(
  (k) => !liveSet.has(k) && !MODULE_SCOPED_BINDINGS.has(k),
).sort();

const undocumentedLive = liveNames
  .filter((k) => !docSet.has(k) && (includeEs || !ES_BUILTINS.has(k)))
  .sort();

const report = {
  runtime: {
    bun: Bun.version,
    revision: Bun.revision,
    documentedCount: DOCUMENTED_GLOBALS.length,
    liveGlobalThisCount: liveNames.length,
  },
  counts: {
    present: documentedAndPresent.length,
    moduleScoped: documentedModuleScoped.length,
    missingFromGlobalThis: documentedMissing.length,
    undocumentedLive: undocumentedLive.length,
  },
  documentedMissing,
  documentedModuleScoped,
  undocumentedLive,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Bun ${report.runtime.bun} (${report.runtime.revision.slice(0, 10)}) | docs=${report.runtime.documentedCount} | live globalThis=${report.runtime.liveGlobalThisCount}`,
  );
  console.table([report.counts]);

  console.log("\nDocumented but absent from globalThis:");
  console.log(
    documentedMissing.length ? documentedMissing.join(", ") : "(none)",
  );

  console.log("\nDocumented module-scoped bindings (not on globalThis):");
  console.log(documentedModuleScoped.join(", "));

  console.log(
    `\nPresent on globalThis but undocumented (${includeEs ? "including ES built-ins" : "host/runtime only"}):`,
  );
  console.log(undocumentedLive.join(", "));
}
