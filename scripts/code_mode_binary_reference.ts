#!/usr/bin/env bun
/**
 * Code Mode × Bun binary/compile reference audit (docs MCP + local runtime).
 *
 *   bun run code-mode:binary-reference
 *   bun run code-mode:binary-reference --offline
 */
import { join } from "node:path";
import { BunDocsMcp } from "./bun_docs_mcp.ts";
import { bunReferenceUrl, bunUrl } from "../lib/bun_urls.ts";
import { BUN_SHAPES } from "../lib/bun_shapes.ts";

const root = join(import.meta.dir, "..");
const offline = process.argv.includes("--offline");

const CODE_MODE_COMPILE_SURFACES = [
  "build",
  "Transpiler",
  "isStandaloneExecutable",
  "spawn",
  "spawnSync",
  "file",
  "write",
] as const;

const DOC_GREPS = [
  "native-code",
  "explain=trim",
  "standalone executable",
  "--compile",
  "Bun.build",
] as const;

function shapesForNames(names: readonly string[]) {
  const set = new Set(names);
  return BUN_SHAPES.filter((s) => set.has(s.name)).map((s) => ({
    name: s.name,
    heading: s.heading,
    kind: s.kind,
    subsystem: s.subsystem,
    evidence: s.evidence,
    referenceUrl: s.heading.startsWith("Bun.")
      ? bunReferenceUrl(`bun/${s.name}`)
      : null,
  }));
}

async function explainTrim(entry: string): Promise<{
  readonly supported: boolean;
  readonly excerpt: string;
}> {
  const proc = Bun.spawn(["bun", "check", "--aot", "--explain=trim", entry], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const text = `${stdout}\n${stderr}`.trim();
  const supported =
    !/Unknown flag\s+"--aot"/.test(text) &&
    !/Unknown flag\s+"--explain/.test(text);
  return {
    supported,
    excerpt: text.slice(0, 2000),
  };
}

async function main(): Promise<void> {
  const guestEntry = join(root, "lib/quickjs_code_mode.ts");
  const hostEntry = join(root, "lib/code_mode_host.ts");

  const report: Record<string, unknown> = {
    bun: Bun.version,
    isStandaloneExecutable: Bun.isStandaloneExecutable,
    canonicalDocs: {
      compiler: bunUrl("/docs/compiler"),
      executables: bunUrl("/docs/compiler/executables"),
      sizeTrim: bunUrl("/docs/compiler/size"),
      aot: bunUrl("/docs/compiler/aot"),
      explain: bunUrl("/docs/compiler/explain"),
    },
    reference: {
      build: bunReferenceUrl("bun/build"),
      transpiler: bunReferenceUrl("bun/Transpiler"),
      isStandaloneExecutable: bunReferenceUrl("bun/isStandaloneExecutable"),
    },
    codeMode: {
      hostRealm: {
        path: "lib/code_mode_host.ts",
        mechanism:
          "Bun.Transpiler + AsyncFunction in host realm (MCP spine only)",
        trimNote:
          "Pulls full Bun runtime; --trim keeps APIs the import graph proves unused",
        binaryFit: "trim / jit compile for MCP spine; not a WASM guest",
      },
      guestRealm: {
        path: "lib/quickjs_code_mode.ts",
        mechanism: "quickjs-emscripten WASM; tools bridge only",
        trimNote: "No bun:ffi; suitable for remove native-code binaries",
        binaryFit:
          "Production profile cells; wired via lib/code_mode_profile.ts",
      },
      profileTools: "lib/profile_query_tools.ts",
      profileHostRegistrar: "lib/profile_code_mode_host.ts",
      guestProbe: "bun run probe:code-mode",
    },
    shapesUsedByCodeMode: shapesForNames(CODE_MODE_COMPILE_SURFACES),
    trimExplain: {
      hostEntry: await explainTrim(hostEntry),
      guestEntry: await explainTrim(guestEntry),
    },
    docsMcp: offline
      ? { skipped: true, reason: "--offline" }
      : { greps: {} as Record<string, string> },
  };

  if (!offline) {
    const client = new BunDocsMcp();
    const greps: Record<string, string> = {};
    for (const pattern of DOC_GREPS) {
      try {
        greps[pattern] = await client.callTool("grep_bun", { pattern });
      } catch (e) {
        greps[pattern] = e instanceof Error ? e.message : "grep_bun failed";
      }
    }
    (report.docsMcp as { greps: Record<string, string> }).greps = greps;
  }

  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  await main();
}
