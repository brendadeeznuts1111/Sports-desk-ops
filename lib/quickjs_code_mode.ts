/**
 * @file lib/quickjs_code_mode.ts
 * @description QuickJS guest realm for the profile Code Mode tools.
 *
 * The desk MCP host (`lib/code_mode_host.ts`) executes cells with `new AsyncFunction` in the
 * host realm, so a cell can reach `Bun`, `process` and `require`. This module is the isolated path
 * used for the profile tools: cells run inside a QuickJS context (WASM) whose only capability is a
 * synchronous `tools` bridge. Host values cross the boundary as native handles, never as JSON text.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import {
  getProfile,
  getSummary,
  queryProfiles,
} from "./profile_query_tools.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MIN_MEMORY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STACK_BYTES = 1024 * 1024;
/** Guest arguments are packed in the guest with this character budget before the host parses them. */
const MAX_ARGUMENT_CHARS = 1_000_000;

let quickJsModule: Promise<QuickJSWASMModule> | undefined;

const loadQuickJS = (): Promise<QuickJSWASMModule> => {
  quickJsModule ??= getQuickJS();
  return quickJsModule;
};

interface GuestValue {
  readonly handle: QuickJSHandle;
  /** True when this call allocated the handle and the caller must dispose it. */
  readonly owned: boolean;
}

/**
 * Marshal a host value into the guest realm as native QuickJS values (no JSON hop).
 * Exported so the boundary can be tested type-by-type without a tools round trip.
 */
export function toGuest(ctx: QuickJSContext, value: unknown): GuestValue {
  if (value === null) return { handle: ctx.null, owned: false };
  if (value === undefined) return { handle: ctx.undefined, owned: false };
  switch (typeof value) {
    case "number":
      return { handle: ctx.newNumber(value), owned: true };
    case "string":
      return { handle: ctx.newString(value), owned: true };
    case "boolean":
      return { handle: value ? ctx.true : ctx.false, owned: false };
    case "object":
      break;
    default:
      throw new Error(`quickjs_code_mode: cannot marshal ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const array = ctx.newArray();
    for (const [index, entry] of value.entries()) {
      const child = toGuest(ctx, entry);
      ctx.setProp(array, index, child.handle);
      if (child.owned) child.handle.dispose();
    }
    return { handle: array, owned: true };
  }

  const object = ctx.newObject();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const child = toGuest(ctx, entry);
    ctx.setProp(object, key, child.handle);
    if (child.owned) child.handle.dispose();
  }
  return { handle: object, owned: true };
}

type HostTool = (args: unknown) => unknown;

function installTools(
  ctx: QuickJSContext,
  maxToolCalls: number,
): readonly QuickJSHandle[] {
  const tools: Readonly<Record<string, HostTool>> = {
    query_profiles: (args) => queryProfiles(args),
    get_profile: (args) => getProfile(args),
    get_profile_summary: (args) => getSummary(args),
  };
  let calls = 0;

  // Pack arguments in the guest, not the host: JSON.stringify runs under the guest's heap limit and
  // a character budget, so a huge or deep object cannot exhaust host memory through ctx.dump. The
  // host only parses the bounded text. (The guest probe itself still reads the realm directly.)
  const pack = ctx.unwrapResult(
    ctx.evalCode(
      `(function(value) {
        const text = JSON.stringify(value);
        if (typeof text !== "string") {
          throw new Error("ERR_CODE_MODE_ARGUMENT_UNSUPPORTED: arguments must be JSON-serialisable data");
        }
        if (text.length > ${MAX_ARGUMENT_CHARS}) {
          throw new Error("ERR_CODE_MODE_ARGUMENT_TOO_LARGE: argument exceeds the ${MAX_ARGUMENT_CHARS}-character budget");
        }
        return text;
      })`,
      "argument-pack.js",
    ),
  );

  const toolsObject = ctx.newObject();
  for (const [name, hostTool] of Object.entries(tools)) {
    const fn = ctx.newFunction(name, (...argHandles) => {
      calls += 1;
      if (calls > maxToolCalls) {
        throw new Error(
          `ERR_CODE_MODE_MAX_CALLS: cell exceeded the ${maxToolCalls} tool-call budget`,
        );
      }
      const [first] = argHandles;
      let args: unknown;
      if (first === undefined) {
        args = undefined;
      } else {
        const packed = ctx.callFunction(pack, ctx.undefined, first);
        if (packed.error) {
          const message = describeGuestError(ctx, packed.error);
          packed.error.dispose();
          throw new Error(`ERR_CODE_MODE_ARGUMENT_UNSUPPORTED: ${message}`);
        }
        const text = ctx.getString(packed.value);
        packed.value.dispose();
        try {
          args = JSON.parse(text);
        } catch {
          throw new Error(
            "ERR_CODE_MODE_ARGUMENT_UNSUPPORTED: argument is not valid JSON data",
          );
        }
      }
      const output = hostTool(args);
      return toGuest(ctx, output).handle;
    });
    ctx.setProp(toolsObject, name, fn);
    fn.dispose();
  }
  ctx.setProp(ctx.global, "tools", toolsObject);
  toolsObject.dispose();
  return [pack];
}

/** QuickJS error objects dump as `{}`; read name/message handles before disposing. */
function describeGuestError(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): string {
  const read = (prop: string): string | null => {
    const propHandle = ctx.getProp(handle, prop);
    if (!propHandle) return null;
    const value = ctx.dump(propHandle);
    propHandle.dispose();
    return typeof value === "string" ? value : null;
  };
  const name = read("name");
  const message = read("message");
  if (name === null && message === null) return String(ctx.dump(handle));
  return `${name ?? "Error"}: ${message ?? ""}`.trim();
}

type SettledGuestPromise =
  { readonly value: QuickJSHandle } | { readonly error: QuickJSHandle };

export interface GuestCellOptions {
  /** Wall-clock budget for the cell; the guest is interrupted when it expires. */
  readonly timeoutMs?: number;
  /** Maximum guest -> host tool calls in one cell (default 100). */
  readonly maxToolCalls?: number;
  /** QuickJS heap ceiling in bytes (default 64 MiB, minimum 1 MiB). */
  readonly memoryLimitBytes?: number;
}

export type RunGuestCellOptions = GuestCellOptions;

const positiveOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Execute a cell in a fresh QuickJS realm and return its value as a host value.
 * The cell is the body of a function: `return tools.query_profiles({...})`.
 */
export async function runGuestCell(
  source: string,
  options: GuestCellOptions = {},
): Promise<unknown> {
  const timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxToolCalls = positiveOr(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
  const memoryLimitBytes = Math.max(
    MIN_MEMORY_LIMIT_BYTES,
    positiveOr(options.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES),
  );

  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(DEFAULT_MAX_STACK_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + timeoutMs),
  );
  const ctx = runtime.newContext();
  let cleanup: readonly QuickJSHandle[] = [];
  try {
    cleanup = installTools(ctx, Math.floor(maxToolCalls));
    const result = ctx.evalCode(
      `(async function(){\n${source}\n})()`,
      "cell.js",
    );
    if (result.error) {
      const message = describeGuestError(ctx, result.error);
      result.error.dispose();
      throw new Error(`quickjs_code_mode: guest cell failed: ${message}`);
    }

    // A cell may await. resolvePromise installs guest then-callbacks, but the guest job queue must
    // be pumped for them to run; a promise that never settles is bounded by a host deadline (the
    // interpreter is idle then, so the interrupt handler cannot fire).
    const outcomes: SettledGuestPromise[] = [];
    const settling = ctx.resolvePromise(result.value);
    settling.then(
      (outcome) => {
        outcomes.push(outcome);
      },
      () => {
        // A late rejection after the runtime is disposed is expected on the deadline path.
      },
    );
    const deadline = Date.now() + timeoutMs + 250;
    try {
      while (outcomes.length === 0) {
        const jobs = runtime.executePendingJobs();
        if ("error" in jobs && jobs.error !== undefined) {
          const message = describeGuestError(ctx, jobs.error);
          jobs.error.dispose();
          throw new Error(`quickjs_code_mode: guest cell failed: ${message}`);
        }
        await Bun.sleep(1);
        if (outcomes.length === 0 && Date.now() > deadline) {
          throw new Error(
            `quickjs_code_mode: guest cell exceeded ${timeoutMs}ms`,
          );
        }
      }
    } finally {
      result.value.dispose();
    }
    const settled = outcomes[0];
    if (settled === undefined) {
      throw new Error("quickjs_code_mode: guest cell promise did not settle");
    }
    if ("error" in settled) {
      const message = describeGuestError(ctx, settled.error);
      settled.error.dispose();
      throw new Error(`quickjs_code_mode: guest cell failed: ${message}`);
    }
    let value: unknown;
    try {
      value = ctx.dump(settled.value);
    } finally {
      settled.value.dispose();
    }
    if (typeof value === "function" || typeof value === "symbol") {
      throw new Error(
        "quickjs_code_mode: guest cell returned a value that cannot cross the boundary",
      );
    }
    return value;
  } finally {
    for (const handle of cleanup) handle.dispose();
    ctx.dispose();
    runtime.dispose();
  }
}
