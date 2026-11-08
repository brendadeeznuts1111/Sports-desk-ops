/**
 * @file tests/gdocs_template_instantiate_cli.test.ts
 * @description Integration tests for scripts/gdocs_template_instantiate.ts CLI behavior,
 * title protection, permission checks, fail-closed posture, temp cleanup, and environment isolation.
 */

import { describe, it, expect } from "bun:test";
import { unlinkSync, mkdirSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runCli(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: string | Buffer;
  } = {},
) {
  const proc = Bun.spawnSync(
    ["bun", "scripts/gdocs_template_instantiate.ts", ...args],
    {
      env: (opts.env || Bun.env) as Record<string, string>,
      stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    },
  );
  return {
    status: proc.exitCode,
    stdout: proc.stdout ? proc.stdout.toString() : "",
    stderr: proc.stderr ? proc.stderr.toString() : "",
  };
}

describe("gdocs_template_instantiate CLI", () => {
  it("fails with friendly error message when removed --title option is supplied", () => {
    const proc = runCli(
      ["--template-id", "fake-template-id", "--title", "My Leaky Title"],
      {
        env: {
          ...Bun.env,
          AGY_ACCOUNT: "test@example.com",
        },
      },
    );

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain(
      "Option '--title' was removed to prevent process-table argument leaks.",
    );
    expect(proc.stderr).toContain("--title-file");
  });

  it("fails with exit code 1 when --title-file is omitted (C2/R1)", () => {
    const proc = runCli(["--template-id", "fake-template-id"], {
      env: {
        ...Bun.env,
        AGY_ACCOUNT: "test@example.com",
      },
    });

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain(
      "Error: A document title must be provided via --title-file",
    );
    expect(proc.stdout).not.toContain("Document ready");
  });

  it("fails with exit code 1 when AGY_ACCOUNT is missing (C6)", async () => {
    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "My Safe Title");

    try {
      const proc = runCli(
        ["--template-id", "fake-template-id", "--title-file", tmpTitle],
        {
          env: {
            PATH: Bun.env.PATH || "",
            HOME: Bun.env.HOME || "",
            // AGY_ACCOUNT omitted intentionally
          },
        },
      );

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain(
        "AGY_ACCOUNT environment variable is required",
      );
    } finally {
      unlinkSync(tmpTitle);
    }
  });

  it("masks values by default in --dry-run and rejects --show-values in non-TTY without force (C5/N2)", async () => {
    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    const tmpVars = join(tmpdir(), `vars-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "My Safe Title");
    await Bun.write(tmpVars, "SECRET_ACCOUNT=KP406\nSECRET_SPLIT=50/50");

    try {
      // 1. Default dry-run masks values
      const procMasked = runCli(
        [
          "--template-id",
          "fake-template-id",
          "--title-file",
          tmpTitle,
          "--var-file",
          tmpVars,
          "--dry-run",
        ],
        {
          env: {
            ...Bun.env,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      expect(procMasked.status).toBe(0);
      expect(procMasked.stdout).toContain("SECRET_ACCOUNT (len=5)");
      expect(procMasked.stdout).toContain("SECRET_SPLIT (len=5)");
      expect(procMasked.stdout).not.toContain("KP406");

      // 2. Non-TTY without --force-unmasked must fail
      const procNonTty = runCli(
        [
          "--template-id",
          "fake-template-id",
          "--title-file",
          tmpTitle,
          "--var-file",
          tmpVars,
          "--dry-run",
          "--show-values",
        ],
        {
          env: {
            ...Bun.env,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      expect(procNonTty.status).toBe(1);
      expect(procNonTty.stderr).toContain(
        "--show-values requires an interactive TTY",
      );
    } finally {
      unlinkSync(tmpTitle);
      unlinkSync(tmpVars);
    }
  });

  it("fails closed and auto-trashes doc on post-hydration sentinel failure (P3/C1/P4)", async () => {
    const mockBinDir = join(tmpdir(), `mock-bin-${Date.now()}`);
    mkdirSync(mockBinDir, { recursive: true });

    const mockGdriveScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "cp" ]; then
  echo '{"id":"mock-new-doc-123456789012345"}'
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "permissions" ]; then
  echo '[]'
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "batch" ]; then
  echo 'Executed 1 operations.'
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "trash" ]; then
  echo 'Moved mock-new-doc-123456789012345 to trash.'
  exit 0
fi
exit 0
`;

    const mockGdocsScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "sed" ]; then
  echo 'Substitutions applied.'
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "read" ]; then
  echo 'Specification: {{UNRESOLVED_CUSTOMER_ID}}'
  exit 0
fi
exit 0
`;

    const gdriveBin = join(mockBinDir, "gdrive");
    const gdocsBin = join(mockBinDir, "gdocs");
    await Bun.write(gdriveBin, mockGdriveScript);
    await Bun.write(gdocsBin, mockGdocsScript);
    chmodSync(gdriveBin, 0o755);
    chmodSync(gdocsBin, 0o755);

    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "Mock Partner Document");

    try {
      const proc = runCli(
        [
          "--template-id",
          "mock-template-id-1234567890",
          "--title-file",
          tmpTitle,
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${mockBinDir}:${Bun.env.PATH}`,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain(
        "Hydrated document failed verification gate!",
      );
      expect(proc.stderr).toContain("UNRESOLVED_CUSTOMER_ID");
      expect(proc.stderr).toContain("Template hydration failed");
      expect(proc.stdout).toContain("Auto-trashing incomplete document");
      expect(proc.stdout).not.toContain("✅ Document ready");
    } finally {
      rmSync(mockBinDir, { recursive: true, force: true });
      unlinkSync(tmpTitle);
    }
  });

  // Test A: Temp cleanup on child failure (H6/H7/R3)
  it("cleans up temporary directory and files when child sed fails (Test A)", async () => {
    const mockBinDir = join(tmpdir(), `mock-fail-bin-${Date.now()}`);
    mkdirSync(mockBinDir, { recursive: true });

    const mockGdriveScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "cp" ]; then
  echo '{"id":"mock-doc-to-fail"}'
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "permissions" ]; then
  echo '[]'
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "batch" ]; then
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "trash" ]; then
  exit 0
fi
exit 0
`;

    // Make sed fail intentionally with code 2
    const mockGdocsScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "sed" ]; then
  echo 'Fatal sed failure' >&2
  exit 2
fi
exit 0
`;

    await Bun.write(join(mockBinDir, "gdrive"), mockGdriveScript);
    await Bun.write(join(mockBinDir, "gdocs"), mockGdocsScript);
    chmodSync(join(mockBinDir, "gdrive"), 0o755);
    chmodSync(join(mockBinDir, "gdocs"), 0o755);

    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    const tmpVars = join(tmpdir(), `vars-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "Mock Fail Title");
    await Bun.write(tmpVars, "KEY=VAL");

    try {
      const proc = runCli(
        [
          "--template-id",
          "mock-template-id",
          "--title-file",
          tmpTitle,
          "--var-file",
          tmpVars,
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${mockBinDir}:${Bun.env.PATH}`,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      // Must fail with exit code 1
      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain("Error executing gdocs mutate sed");

      // Verify no dangling gdocs-inst-* directories remain in tmpdir
      const remainingTempDirs = readdirSync(tmpdir()).filter((f) =>
        f.startsWith("gdocs-inst-"),
      );
      expect(remainingTempDirs.length).toBe(0);
    } finally {
      rmSync(mockBinDir, { recursive: true, force: true });
      unlinkSync(tmpTitle);
      unlinkSync(tmpVars);
    }
  });

  // Test B: Title absence from argv (C2/R1)
  it("never passes sensitive title on child argv; verifies generic clone title (Test B)", async () => {
    const mockBinDir = join(tmpdir(), `mock-argv-bin-${Date.now()}`);
    mkdirSync(mockBinDir, { recursive: true });

    const argvLogFile = join(tmpdir(), `argv-log-${Date.now()}.txt`);

    const mockGdriveScript = `#!/bin/sh
echo "$@" >> "${argvLogFile}"
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "cp" ]; then
  echo '{"id":"mock-argv-doc"}'
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "permissions" ]; then
  echo '[]'
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "batch" ]; then
  exit 0
fi
exit 0
`;

    const mockGdocsScript = `#!/bin/sh
echo "$@" >> "${argvLogFile}"
exit 0
`;

    await Bun.write(join(mockBinDir, "gdrive"), mockGdriveScript);
    await Bun.write(join(mockBinDir, "gdocs"), mockGdocsScript);
    chmodSync(join(mockBinDir, "gdrive"), 0o755);
    chmodSync(join(mockBinDir, "gdocs"), 0o755);

    const sensitiveTitle = "CONFIDENTIAL_CANARY_PLAYER_BB55103_SETTLEMENT";
    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    await Bun.write(tmpTitle, sensitiveTitle);

    try {
      const proc = runCli(
        [
          "--template-id",
          "mock-template-id",
          "--title-file",
          tmpTitle,
          "--skip-sentinel-check",
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${mockBinDir}:${Bun.env.PATH}`,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      expect(proc.status).toBe(0);

      // Read all recorded command lines from argv log
      const argvLogs = await Bun.file(argvLogFile).text();

      // 1. Sensitive title must NEVER appear in child argv
      expect(argvLogs).not.toContain(sensitiveTitle);

      // 2. Generic placeholder title MUST appear in cp arguments
      expect(argvLogs).toContain("[Pending Hydration: DOC-TEMP-");
    } finally {
      rmSync(mockBinDir, { recursive: true, force: true });
      unlinkSync(tmpTitle);
      unlinkSync(argvLogFile);
    }
  });

  // Test C: Child subprocess environment decoy test (P2/P8)
  it("strips decoy secrets from subprocess environment (Test C)", async () => {
    const mockBinDir = join(tmpdir(), `mock-env-bin-${Date.now()}`);
    mkdirSync(mockBinDir, { recursive: true });

    const envDumpFile = join(tmpdir(), `env-dump-${Date.now()}.txt`);

    const mockGdriveScript = `#!/bin/sh
env > "${envDumpFile}"
echo '{"id":"mock-env-doc"}'
exit 0
`;

    await Bun.write(join(mockBinDir, "gdrive"), mockGdriveScript);
    chmodSync(join(mockBinDir, "gdrive"), 0o755);

    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "Mock Env Doc");

    try {
      runCli(
        [
          "--template-id",
          "mock-template-id",
          "--title-file",
          tmpTitle,
          "--skip-sentinel-check",
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${mockBinDir}:${Bun.env.PATH}`,
            AGY_ACCOUNT: "operator@example.com",
            AWS_SECRET_ACCESS_KEY: "DECOY_LEAKED_AWS_KEY_CANARY",
            GITHUB_TOKEN: "DECOY_LEAKED_GH_TOKEN_CANARY",
            PRIVATE_OPERATOR_SECRET: "TOP_SECRET_CANARY_VALUE",
          },
        },
      );

      const capturedEnv = await Bun.file(envDumpFile).text();

      // Assert whitelisted vars are present
      expect(capturedEnv).toContain("AGY_ACCOUNT=operator@example.com");
      expect(capturedEnv).toContain("LANG=C");
      expect(capturedEnv).toContain("LC_ALL=C");

      // Assert decoy secrets are completely stripped
      expect(capturedEnv).not.toContain("DECOY_LEAKED_AWS_KEY_CANARY");
      expect(capturedEnv).not.toContain("DECOY_LEAKED_GH_TOKEN_CANARY");
      expect(capturedEnv).not.toContain("TOP_SECRET_CANARY_VALUE");
    } finally {
      rmSync(mockBinDir, { recursive: true, force: true });
      unlinkSync(tmpTitle);
      unlinkSync(envDumpFile);
    }
  });

  // Test D (R-C): Fail closed on post-hydration read failure
  it("fails closed and auto-trashes doc when readonly read fails (R-C)", async () => {
    const mockBinDir = join(tmpdir(), `mock-readfail-bin-${Date.now()}`);
    mkdirSync(mockBinDir, { recursive: true });

    const mockGdriveScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "cp" ]; then
  echo '{"id":"mock-readfail-doc"}'
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "permissions" ]; then
  echo '[]'
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "batch" ]; then
  exit 0
elif [ "$cmd" = "mutate" ] && [ "$sub" = "trash" ]; then
  echo 'Moved mock-readfail-doc to trash.'
  exit 0
fi
exit 0
`;

    // Make gdocs readonly read fail with exit code 1
    const mockGdocsScript = `#!/bin/sh
cmd="$1"
sub="$2"
if [ "$cmd" = "mutate" ] && [ "$sub" = "sed" ]; then
  exit 0
elif [ "$cmd" = "readonly" ] && [ "$sub" = "read" ]; then
  echo 'Network read error 500' >&2
  exit 1
fi
exit 0
`;

    await Bun.write(join(mockBinDir, "gdrive"), mockGdriveScript);
    await Bun.write(join(mockBinDir, "gdocs"), mockGdocsScript);
    chmodSync(join(mockBinDir, "gdrive"), 0o755);
    chmodSync(join(mockBinDir, "gdocs"), 0o755);

    const tmpTitle = join(tmpdir(), `title-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "Mock ReadFail Title");

    try {
      const proc = runCli(
        ["--template-id", "mock-template-id", "--title-file", tmpTitle],
        {
          env: {
            ...Bun.env,
            PATH: `${mockBinDir}:${Bun.env.PATH}`,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      // Must fail with exit code 1
      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain(
        "Error reading back document for sentinel verification:",
      );
      expect(proc.stdout).toContain("Auto-trashing incomplete document");
      expect(proc.stdout).not.toContain("✅ Document ready");
    } finally {
      rmSync(mockBinDir, { recursive: true, force: true });
      unlinkSync(tmpTitle);
    }
  });

  it("lists registered template kinds and exits 0 when --list-kinds is passed", () => {
    const proc = runCli(["--list-kinds"]);

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Registered Document Template Kinds:");
    expect(proc.stdout).toContain("spec");
    expect(proc.stdout).toContain("partner-review");
    expect(proc.stdout).toContain("risk-audit");
  });

  it("validates required variables upfront when --kind is used", async () => {
    const tmpTitle = join(tmpdir(), `title-kind-${Date.now()}.txt`);
    await Bun.write(tmpTitle, "Partner Review Title");

    const tmpVars = join(tmpdir(), `vars-kind-${Date.now()}.env`);
    // Only supply PLAYER_HANDLE, missing AGENT_ID and REVIEW_PERIOD
    await Bun.write(tmpVars, "PLAYER_HANDLE=KP406\n");

    try {
      const proc = runCli(
        [
          "--kind",
          "partner-review",
          "--title-file",
          tmpTitle,
          "--var-file",
          tmpVars,
          "--dry-run",
        ],
        {
          env: {
            ...Bun.env,
            AGY_ACCOUNT: "test@example.com",
          },
        },
      );

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain(
        'Template kind "partner-review" is missing required substitution keys: AGENT_ID, REVIEW_PERIOD',
      );
    } finally {
      unlinkSync(tmpTitle);
      unlinkSync(tmpVars);
    }
  });
});
