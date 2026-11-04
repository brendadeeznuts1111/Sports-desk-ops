import { describe, expect, test } from "bun:test";

const CLIS = [
  { name: "capture:f402", path: "scripts/capture/f402_probe.ts" },
  { name: "capture:har", path: "scripts/capture/har_probe.ts" },
  { name: "artifacts:cron", path: "scripts/artifacts_cron.ts" },
  { name: "secrets:f402", path: "scripts/secrets_f402.ts" },
  { name: "docs:serve", path: "scripts/serve_docs.ts" },
] as const;

describe("cli help", () => {
  for (const cli of CLIS) {
    test(`${cli.name} --help exits 0 with examples and no side effects`, async () => {
      const proc = Bun.spawn(["bun", cli.path, "--help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain("Options:");
      expect(stdout).toContain("Examples:");
      // Help must not launch a browser or touch the network; stderr stays quiet on success.
      expect(stderr.trim()).toBe("");
    });
  }
});
