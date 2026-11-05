import { describe, expect, test } from "bun:test";

/**
 * The Node.js built-ins whose internals Bun 1.4.1 loads on first use. The in-process import
 * checks the public surface; the cold subprocess checks that a fresh process can still require
 * all of them together after the lazy split.
 */

const MODULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["node:assert", ["ok", "strictEqual"]],
  ["node:https", ["request", "Agent"]],
  ["node:http", ["request", "createServer"]],
  ["node:http2", ["connect", "createServer"]],
  ["node:vm", ["createContext", "runInNewContext"]],
  ["node:fs", ["readFileSync", "promises"]],
  ["node:util", ["inspect", "parseArgs"]],
  ["node:tty", ["isatty", "ReadStream"]],
  ["node:worker_threads", ["Worker", "isMainThread"]],
  ["node:child_process", ["spawn", "execFileSync"]],
];

describe("Node built-in lazy loading", () => {
  test("each module exposes its public surface", async () => {
    for (const [name, members] of MODULES) {
      const module = (await import(name)) as Record<string, unknown>;
      for (const member of members) {
        expect(module[member], `${name}.${member}`).toBeDefined();
      }
    }
  });

  test("a cold process can require every module", () => {
    const names = MODULES.map(([name]) => name);
    const script = [
      `for (const name of ${JSON.stringify(names)}) require(name);`,
      `console.log("ok");`,
    ].join("\n");
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(proc.stdout.toString().trim()).toBe("ok");
  });
});
