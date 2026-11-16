import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/ci/check_oracle_frozen.ts",
);

const git = (cwd: string, args: readonly string[]) => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
};

const write = (cwd: string, path: string, text: string) =>
  writeFile(join(cwd, path), text);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oracle-gate-"));
  await mkdir(join(dir, "data"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  await mkdir(join(dir, "tests", "code_mode"), { recursive: true });
  await write(dir, "data/profile-snapshot.json", "{}\n");
  await write(dir, "lib/profile_query_schema.ts", "export const schema = 1;\n");
  await write(dir, "tests/code_mode/oracle.ts", "export const frozen = 1;\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.email=ci@example.test",
    "-c",
    "user.name=ci",
    "commit",
    "-qm",
    "init",
  ]);
  return dir;
}

const runGate = (cwd: string): { code: number; output: string } => {
  const result = Bun.spawnSync({
    cmd: ["bun", SCRIPT],
    cwd,
    env: { ...process.env, ORACLE_BASE_REF: "HEAD" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};

const withRepo = async (
  body: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await makeRepo();
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("oracle freeze gate", () => {
  test("passes when nothing changed", async () => {
    await withRepo(async (dir) => {
      const gate = runGate(dir);
      expect(gate.code).toBe(0);
      expect(gate.output).toContain("check:oracle-frozen: ok");
    });
  });

  test("fails when the contract changes without the oracle", async () => {
    await withRepo(async (dir) => {
      await write(dir, "data/profile-snapshot.json", '{"changed":true}\n');
      const gate = runGate(dir);
      expect(gate.code).toBe(1);
      expect(gate.output).toContain("without re-freezing the oracle");
      expect(gate.output).toContain("data/profile-snapshot.json");
    });
  });

  test("fails for an argument-schema change alone", async () => {
    await withRepo(async (dir) => {
      await write(
        dir,
        "lib/profile_query_schema.ts",
        "export const schema = 2;\n",
      );
      expect(runGate(dir).code).toBe(1);
    });
  });

  test("passes when the schema and the oracle change together", async () => {
    await withRepo(async (dir) => {
      await write(dir, "data/profile-snapshot.json", '{"changed":true}\n');
      await write(
        dir,
        "tests/code_mode/oracle.ts",
        "export const frozen = 2;\n",
      );
      const gate = runGate(dir);
      expect(gate.code).toBe(0);
      expect(gate.output).toContain("oracle updated");
    });
  });
});
