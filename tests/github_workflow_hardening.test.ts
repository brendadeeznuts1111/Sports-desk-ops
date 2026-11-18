/**
 * @file tests/github_workflow_hardening.test.ts
 * @description Keeps the supply-chain posture of `.github/workflows`: every action is pinned to a
 * 40-character commit, every workflow declares `permissions`, every job has a timeout, checkouts do
 * not persist credentials, and Dependabot covers Actions and Bun.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

interface WorkflowStep {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly "timeout-minutes"?: number;
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

const workflowFiles = [
  ...new Glob(".github/workflows/*.yml").scanSync({ onlyFiles: true }),
].sort();

describe("GitHub workflow hardening", () => {
  test("workflows are discovered", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  for (const file of workflowFiles) {
    test(`${file} pins actions and declares permissions/timeouts`, async () => {
      const text = await Bun.file(file).text();
      const document = Bun.YAML.parse(text) as WorkflowDocument;
      expect(document.permissions).toBeDefined();
      expect(document.permissions).toMatchObject({ contents: "read" });
      expect(text).not.toContain("pull_request_target");
      expect(text).not.toContain("bun install --frozen-lockfile");
      const jobs = Object.entries(document.jobs ?? {});
      expect(jobs.length).toBeGreaterThan(0);

      for (const [name, job] of jobs) {
        expect(
          job["timeout-minutes"],
          `${file} job ${name} needs a timeout`,
        ).toBeNumber();
        for (const step of job.steps ?? []) {
          if (step.uses === undefined) continue;
          expect(step.uses, `${file} step must be SHA-pinned`).toMatch(
            /^[^@\s]+@[0-9a-f]{40}$/,
          );
          if (step.uses.startsWith("actions/checkout@")) {
            expect(
              step.with?.["persist-credentials"],
              `${file} checkout must not persist credentials`,
            ).toBe(false);
          }
        }
      }
    });
  }

  test("Dependabot covers GitHub Actions and Bun", async () => {
    const dependabot = Bun.YAML.parse(
      await Bun.file(".github/dependabot.yml").text(),
    ) as { updates?: readonly { "package-ecosystem"?: string }[] };
    const ecosystems = (dependabot.updates ?? []).map(
      (update) => update["package-ecosystem"],
    );
    expect(ecosystems).toContain("github-actions");
    expect(ecosystems).toContain("bun");
  });
});
