/**
 * Offline tests for `cli/bun_reference_cli.ts`: argument parsing, layered help, actionable usage
 * errors, exit codes, and the no-network subcommands (`contract`, `kinds`, `colours`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliUsageError,
  EXIT,
  manifestDrift,
  parseCliArgs,
  runCli,
  type CliIo,
} from "../cli/bun_reference_cli.ts";
import { runReferenceAudit } from "../lib/bun_reference_audit.ts";
import { bunRevisionComposite } from "../lib/bun_runtime.ts";
import { fixtureFetch } from "./fixtures/bun_reference_fixture.ts";

// runCli captures its io in a record of functions; keep a simple recorder instead.
function recorder(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    out,
    err,
  };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function manifestFixture(): Promise<string> {
  const result = await runReferenceAudit({
    fetchJson: fixtureFetch,
    probe: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "bun-ref-cli-"));
  tempDirs.push(dir);
  const path = join(dir, "reference-contract.json");
  writeFileSync(path, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return path;
}

describe("parseCliArgs (discriminated actions)", () => {
  test("bare invocation is the help action, not an error", () => {
    const action = parseCliArgs([]);
    expect(action.command).toBe("help");
    if (action.command !== "help") throw new Error("narrowing");
    expect(action.helpTopic).toBeNull();
    expect(action.json).toBe(false);
  });

  test("audit carries only its own options", () => {
    const action = parseCliArgs([
      "audit",
      "--json",
      "--out",
      "scratch/x",
      "--no-probe",
    ]);
    expect(action.command).toBe("audit");
    if (action.command !== "audit") throw new Error("narrowing");
    expect(action.json).toBe(true);
    expect(action.out).toBe("scratch/x");
    expect(action.noProbe).toBe(true);
    expect(action.quiet).toBe(false);
  });

  test("help topics are validated and audit --help keeps its topic", () => {
    const topic = parseCliArgs(["help", "colours"]);
    expect(topic.command).toBe("help");
    if (topic.command !== "help") throw new Error("narrowing");
    expect(topic.helpTopic).toBe("colours");

    const own = parseCliArgs(["audit", "--help"]);
    expect(own.command).toBe("help");
    if (own.command !== "help") throw new Error("narrowing");
    expect(own.helpTopic).toBe("audit");
    expect(() => parseCliArgs(["help", "nope"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["help", "help"])).toThrow(CliUsageError);
  });

  test("data commands have a non-null manifest; contract may omit it", () => {
    const check = parseCliArgs(["check", "--manifest", "m.json"]);
    expect(check.command).toBe("check");
    if (check.command !== "check") throw new Error("narrowing");
    expect(check.manifest).toBe("m.json");

    const kinds = parseCliArgs(["kinds", "--manifest", "m.json"]);
    if (kinds.command !== "kinds") throw new Error("narrowing");
    expect(kinds.manifest).toBe("m.json");

    const contract = parseCliArgs(["contract"]);
    if (contract.command !== "contract") throw new Error("narrowing");
    expect(contract.manifest).toBeNull();
    expect(contract.schemaOnly).toBe(false);
  });

  test("missing --manifest fails with an example invocation", () => {
    expect(() => parseCliArgs(["check"])).toThrow(CliUsageError);
    try {
      parseCliArgs(["check"]);
    } catch (error) {
      expect((error as Error).message).toContain(
        "--manifest <path> is required for check",
      );
      expect((error as Error).message).toContain(
        "bun cli/bun_reference_cli.ts check --manifest",
      );
    }
  });

  test("unknown command and option fail", () => {
    expect(() => parseCliArgs(["frobnicate"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["audit", "--bogus"])).toThrow(CliUsageError);
  });

  test("command-scoped flags are rejected on other commands", () => {
    expect(() =>
      parseCliArgs(["kinds", "--schema", "--manifest", "x"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["check", "--out", "x", "--manifest", "y"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["check", "--quiet", "--manifest", "y"])).toThrow(
      CliUsageError,
    );
  });

  test("--revision is a global help action with its own flag", () => {
    const action = parseCliArgs(["--revision"]);
    expect(action.command).toBe("help");
    if (action.command !== "help") throw new Error("narrowing");
    expect(action.revision).toBe(true);
    expect(action.version).toBe(false);
    const withCommand = parseCliArgs(["audit", "--revision"]);
    expect(withCommand.command).toBe("help");
    expect(withCommand.revision).toBe(true);
  });

  test("--version is a global help action", () => {
    const action = parseCliArgs(["--version"]);
    expect(action.command).toBe("help");
    expect(action.version).toBe(true);
    const withCommand = parseCliArgs(["audit", "--version"]);
    expect(withCommand.command).toBe("help");
    expect(withCommand.version).toBe(true);
  });
});

describe("runCli (no network)", () => {
  test("bare and --help exit 0 with examples", async () => {
    const bare = recorder();
    expect(await runCli([], bare.io)).toBe(EXIT.ok);
    expect(bare.out.join("\n")).toContain("Examples:");
    const helped = recorder();
    expect(await runCli(["--help"], helped.io)).toBe(EXIT.ok);
    expect(helped.out.join("\n")).toContain(
      "bun cli/bun_reference_cli.ts audit",
    );
  });

  test("--version exits 0 and names the manifest schema", async () => {
    const rec = recorder();
    expect(await runCli(["--version"], rec.io)).toBe(EXIT.ok);
    expect(rec.out.join("\n")).toContain("draft 2020-12");
  });

  test("--revision prints the same composite as bun --revision", async () => {
    const rec = recorder();
    expect(await runCli(["--revision"], rec.io)).toBe(EXIT.ok);
    expect(rec.out).toEqual([bunRevisionComposite()]);
    // Shape from the pinned binary: `<version>+<9-char sha>`.
    expect(bunRevisionComposite()).toBe(
      `${Bun.version}+${Bun.revision.slice(0, 9)}`,
    );
  });

  test("--revision --json is machine-readable and stable", async () => {
    const rec = recorder();
    expect(await runCli(["--revision", "--json"], rec.io)).toBe(EXIT.ok);
    const parsed = JSON.parse(rec.out.join("\n")) as {
      version: string;
      revision: string;
      composite: string;
    };
    expect(parsed.version).toBe(Bun.version);
    expect(parsed.revision).toBe(Bun.revision);
    expect(parsed.composite).toBe(bunRevisionComposite());
    const second = recorder();
    expect(await runCli(["--revision", "--json"], second.io)).toBe(EXIT.ok);
    expect(second.out).toEqual(rec.out);
  });

  test("--version and --revision together print both lines", async () => {
    const rec = recorder();
    expect(await runCli(["--version", "--revision"], rec.io)).toBe(EXIT.ok);
    expect(rec.out).toEqual([
      "bun-reference cli v1 · manifest schema draft 2020-12",
      bunRevisionComposite(),
    ]);
  });

  test("usage errors exit 2 on stderr with an example", async () => {
    const rec = recorder();
    expect(await runCli(["bogus"], rec.io)).toBe(EXIT.usage);
    expect(rec.err.join("\n")).toContain("unknown command: bogus");
    expect(rec.err.join("\n")).toContain("try --help");
    expect(rec.out).toEqual([]);
  });

  test("contract validates a manifest; kinds and colours render it", async () => {
    const path = await manifestFixture();
    const contract = recorder();
    expect(await runCli(["contract", "--manifest", path], contract.io)).toBe(
      EXIT.ok,
    );
    expect(contract.out.join("\n")).toContain("contract manifest valid");

    const kinds = recorder();
    expect(await runCli(["kinds", "--manifest", path], kinds.io)).toBe(EXIT.ok);
    expect(kinds.out.join("\n")).toContain("kind | documented");

    const colours = recorder();
    expect(await runCli(["colours", "--manifest", path], colours.io)).toBe(
      EXIT.ok,
    );
    const output = colours.out.join("\n");
    expect(output).toContain("kind (name) | alias | colour | count");
    expect(output).toContain("classes | C | blue | 1");
    expect(output).toContain("functions | F | emerald | 3");
  });

  test("contract --schema prints the generated JSON Schema", async () => {
    const rec = recorder();
    expect(await runCli(["contract", "--schema"], rec.io)).toBe(EXIT.ok);
    expect(rec.out.join("\n")).toContain("draft 2020-12");
  });

  test("contract with a missing manifest exits 2 with the audit hint", async () => {
    const rec = recorder();
    expect(
      await runCli(
        ["contract", "--manifest", "/nonexistent/manifest.json"],
        rec.io,
      ),
    ).toBe(EXIT.usage);
    expect(rec.err.join("\n")).toContain("contract manifest not found");
    expect(rec.err.join("\n")).toContain("audit --out");
  });
});

describe("manifestDrift", () => {
  test("ignores generatedAt and reports changed keys", async () => {
    const result = await runReferenceAudit({
      fetchJson: fixtureFetch,
      probe: false,
    });
    const manifest = result.manifest;
    const same = { ...manifest, generatedAt: "1999-01-01T00:00:00.000Z" };
    expect(manifestDrift(same, manifest)).toEqual([]);
    const changed = { ...manifest, distinctPairs: manifest.distinctPairs + 1 };
    expect(manifestDrift(changed, manifest)).toEqual(["distinctPairs"]);
  });
});
