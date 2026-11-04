/**
 * Bun WorkerOptions contract.
 *
 * Bun extends the Web Worker constructor with `argv`, `env`, `preload`, `name`, `ref` and
 * `smol`; `credentials` and `type` are accepted no-ops. This pins the options the repo may rely
 * on without depending on ELK or another worker payload.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SHARE_ENV } from "node:worker_threads";

interface WorkerProbe {
  bunArgv: string[];
  processArgv: string[];
  sameArgv: boolean;
  testEnv: string | undefined;
  preloaded: string | null;
}

function once<T>(worker: Worker): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data as T);
    worker.onerror = (event) => reject(event.error ?? event.message);
  });
}

function ping<T>(worker: Worker, payload: unknown = "read"): Promise<T> {
  const result = once<T>(worker);
  worker.postMessage(payload);
  return result;
}

describe("WorkerOptions contract", () => {
  test("argv, env and preload reach the worker; no-op options are accepted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-options-"));
    const workerPath = join(dir, "worker.ts");
    const preloadPath = join(dir, "preload.ts");
    try {
      writeFileSync(preloadPath, 'globalThis.__workerPreloaded = "yes";\n');
      writeFileSync(
        workerPath,
        [
          "postMessage({",
          "  bunArgv: Bun.argv,",
          "  processArgv: process.argv,",
          "  sameArgv: Bun.argv === process.argv,",
          "  testEnv: process.env.WORKER_TEST,",
          "  preloaded: (globalThis as any).__workerPreloaded ?? null,",
          "});",
        ].join("\n"),
      );

      const worker = new Worker(pathToFileURL(workerPath), {
        argv: ["--alpha", 42, true, null, { x: 1 }],
        env: { ...process.env, WORKER_TEST: "yes" },
        preload: [preloadPath],
        name: "probe",
        smol: true,
        ref: false,
        credentials: "same-origin",
        type: "module",
      });
      try {
        const result = await once<WorkerProbe>(worker);
        expect(result.bunArgv.slice(-5)).toEqual([
          "--alpha",
          "42",
          "true",
          "null",
          "[object Object]",
        ]);
        expect(result.processArgv).toEqual(result.bunArgv);
        expect(result.sameArgv).toBe(true);
        expect(result.testEnv).toBe("yes");
        expect(result.preloaded).toBe("yes");
      } finally {
        worker.terminate();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("name is accepted but not exposed on 1.4.4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-name-"));
    const workerPath = join(dir, "worker.ts");
    try {
      writeFileSync(
        workerPath,
        [
          "postMessage({",
          "  selfName: (self as any).name ?? null,",
          "  globalName: (globalThis as any).name ?? null,",
          "  tag: Object.prototype.toString.call(self),",
          "  dedicated: typeof (globalThis as any).DedicatedWorkerGlobalScope,",
          "});",
        ].join("\n"),
      );
      const worker = new Worker(pathToFileURL(workerPath), {
        name: "probe",
        ref: false,
      });
      try {
        const result = await once<{
          selfName: string | null;
          globalName: string | null;
          tag: string;
          dedicated: string;
        }>(worker);
        expect(result).toEqual({
          selfName: null,
          globalName: null,
          tag: "[object Object]",
          dedicated: "undefined",
        });
        expect((worker as Worker & { name?: string | null }).name ?? null).toBe(
          null,
        );
      } finally {
        worker.terminate();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env defaults to a snapshot and explicit env replaces it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-env-"));
    const workerPath = join(dir, "worker.ts");
    const previousDefault = process.env.WORKER_DEFAULT;
    const previousParent = process.env.PARENT_ONLY;
    try {
      writeFileSync(
        workerPath,
        [
          "onmessage = () => {",
          "  postMessage({",
          "    defaulted: process.env.WORKER_DEFAULT ?? null,",
          "    parentOnly: process.env.PARENT_ONLY ?? null,",
          "    workerOnly: process.env.WORKER_ONLY ?? null,",
          "    keyCount: Object.keys(process.env).length,",
          "  });",
          "};",
        ].join("\n"),
      );
      process.env.WORKER_DEFAULT = "parent";
      process.env.PARENT_ONLY = "parent-only";

      const defaultWorker = new Worker(pathToFileURL(workerPath), {
        ref: false,
      });
      process.env.WORKER_DEFAULT = "changed";
      try {
        const result = await ping<{
          defaulted: string | null;
          parentOnly: string | null;
        }>(defaultWorker);
        // The default is a snapshot taken at worker creation, not a live alias.
        expect(result.defaulted).toBe("parent");
        expect(result.parentOnly).toBe("parent-only");
      } finally {
        defaultWorker.terminate();
      }

      const explicitWorker = new Worker(pathToFileURL(workerPath), {
        env: { WORKER_ONLY: "worker-only" },
        ref: false,
      });
      try {
        const result = await ping<{
          defaulted: string | null;
          parentOnly: string | null;
          workerOnly: string | null;
          keyCount: number;
        }>(explicitWorker);
        // An explicit env replaces process.env rather than merging into it.
        expect(result.defaulted).toBeNull();
        expect(result.parentOnly).toBeNull();
        expect(result.workerOnly).toBe("worker-only");
        expect(result.keyCount).toBe(1);
      } finally {
        explicitWorker.terminate();
      }

      const emptyWorker = new Worker(pathToFileURL(workerPath), {
        env: {},
        ref: false,
      });
      try {
        const result = await ping<{ keyCount: number }>(emptyWorker);
        expect(result.keyCount).toBe(0);
      } finally {
        emptyWorker.terminate();
      }
    } finally {
      if (previousDefault === undefined) delete process.env.WORKER_DEFAULT;
      else process.env.WORKER_DEFAULT = previousDefault;
      if (previousParent === undefined) delete process.env.PARENT_ONLY;
      else process.env.PARENT_ONLY = previousParent;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ref:true keeps the parent alive; ref:false does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-ref-"));
    try {
      writeFileSync(join(dir, "worker.ts"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(dir, "parent.ts"),
        [
          "const ref = process.argv[2];",
          'const options = ref === "default" ? {} : { ref: ref === "true" };',
          'new Worker("./worker.ts", options);',
          'console.log("parent-done");',
        ].join("\n"),
      );

      const probe = async (
        ref: boolean | "default",
      ): Promise<"exited" | "alive"> => {
        const proc = Bun.spawn({
          cmd: [process.execPath, "parent.ts", String(ref)],
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const outcome = await Promise.race([
          proc.exited.then(() => "exited" as const),
          Bun.sleep(1_000).then(() => "alive" as const),
        ]);
        if (outcome === "alive") {
          proc.kill();
          await proc.exited;
        }
        return outcome;
      };

      expect(await probe(false)).toBe("exited");
      expect(await probe(true)).toBe("alive");
      expect(await probe("default")).toBe("alive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("relative worker and preload paths resolve from cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-relative-"));
    try {
      writeFileSync(
        join(dir, "worker.ts"),
        "postMessage({ preloaded: (globalThis as any).__workerPreloaded ?? null });\n",
      );
      writeFileSync(
        join(dir, "load-sentry.js"),
        'globalThis.__workerPreloaded = "yes";\n',
      );
      writeFileSync(
        join(dir, "parent.ts"),
        [
          'const worker = new Worker("./worker.ts", {',
          '  preload: "./load-sentry.js",',
          "  ref: false,",
          "});",
          "const result = await new Promise((resolve, reject) => {",
          "  worker.onmessage = (event) => resolve(event.data);",
          "  worker.onerror = (event) => reject(event.error ?? event.message);",
          "});",
          "console.log(JSON.stringify(result));",
          "worker.terminate();",
        ].join("\n"),
      );

      const run = Bun.spawnSync({
        cmd: [process.execPath, "parent.ts"],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual({ preloaded: "yes" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SHARE_ENV shares process.env both ways", async () => {
    expect(typeof SHARE_ENV).toBe("symbol");
    expect(SHARE_ENV.description).toBe("nodejs.worker_threads.SHARE_ENV");

    const dir = mkdtempSync(join(tmpdir(), "worker-share-env-"));
    const workerPath = join(dir, "worker.ts");
    const previous = process.env.WORKER_SHARED;
    try {
      writeFileSync(
        workerPath,
        [
          "const before = process.env.WORKER_SHARED ?? null;",
          'process.env.WORKER_SHARED = "worker";',
          "postMessage({ before });",
        ].join("\n"),
      );
      process.env.WORKER_SHARED = "parent";

      const worker = new Worker(pathToFileURL(workerPath), {
        env: SHARE_ENV,
        ref: false,
      });
      try {
        const result = await once<{ before: string | null }>(worker);
        expect(result.before).toBe("parent");
        expect(process.env.WORKER_SHARED).toBe("worker");
      } finally {
        worker.terminate();
      }
    } finally {
      if (previous === undefined) delete process.env.WORKER_SHARED;
      else process.env.WORKER_SHARED = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
