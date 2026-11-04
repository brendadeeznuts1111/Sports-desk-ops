import { describe, expect, test } from "bun:test";

/**
 * The two long-lived processes run under a supervisor. `--no-orphans` makes Bun exit when the parent
 * dies (even if it was SIGKILLed) and take its descendants with it; without it, a killed supervisor
 * leaves the docs server or the cron host reparented to launchd and still running.
 */
const LONG_LIVED = ["docs:serve", "artifacts:cron"] as const;

describe("long-lived scripts opt into --no-orphans", () => {
  test("both scripts pass the flag", async () => {
    const pkg = (await Bun.file("package.json").json()) as {
      scripts: Record<string, string>;
    };
    for (const name of LONG_LIVED) {
      expect(pkg.scripts[name]).toContain("--no-orphans");
      expect(pkg.scripts[name]).toContain("bun ");
    }
  });

  test("the runtime accepts the flag before a script", async () => {
    const proc = Bun.spawn(
      ["bun", "--no-orphans", "scripts/artifacts_cron.ts", "--help"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await proc.stdout.text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Examples:");
  });
});
