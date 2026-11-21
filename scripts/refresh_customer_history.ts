#!/usr/bin/env bun
/** Run the dashboard-owned retained-history projector from the existing collector scheduler. */
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { refreshGradedWagerExport } from "./capture_graded_wagers.ts";

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "Use an absolute local path");
const configurationSchema = z.object({
  projector: absolutePath,
  sources: z.array(absolutePath).min(1).max(16),
  output: absolutePath,
  capture: absolutePath.optional(),
});
export function parseCustomerHistoryConfiguration(
  env: Readonly<Record<string, string | undefined>>,
) {
  const configuration = configurationSchema.parse({
    projector: env.SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR,
    sources: JSON.parse(env.SPORTSDESK_CUSTOMER_HISTORY_SOURCES ?? "null"),
    output: env.SPORTSDESK_CUSTOMER_HISTORY_JSON,
    capture: env.SPORTSDESK_GRADED_WAGER_EXPORT?.trim() || undefined,
  });
  if (!configuration.projector.endsWith("/scripts/project_customer_history.ts"))
    throw new Error(
      "Use the dashboard-owned scripts/project_customer_history.ts entrypoint",
    );
  if (
    configuration.sources.some(
      (source) => resolve(source) === resolve(configuration.output),
    )
  )
    throw new Error("History output cannot overwrite an export");
  const capture = configuration.capture;
  if (
    capture &&
    (configuration.sources.length >= 16 ||
      [configuration.output, ...configuration.sources].some(
        (path) => resolve(path) === resolve(capture),
      ))
  )
    throw new Error(
      "Graded capture requires a separate export path and room for an extra source",
    );
  return configuration;
}

export async function refreshCustomerHistory(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
) {
  const configuration = parseCustomerHistoryConfiguration(env);
  const { output, sources, projector, capture } = configuration;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const lockPath = `${output}.refresh-lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return { status: "overlap-skipped" } as const;
    throw error;
  }
  const attemptedAt = new Date().toISOString();
  const statusPath = `${output}.status.json`;
  let coverage:
    Awaited<ReturnType<typeof refreshGradedWagerExport>> | undefined;
  let stage = capture ? "capture" : "projection";
  async function writeReceipt(receipt: object) {
    const temp = `${statusPath}.tmp-${process.pid}`;
    await Bun.write(
      temp,
      JSON.stringify({
        schemaVersion: 1,
        attemptedAt,
        upstreamCapturePerformed: coverage !== undefined,
        ...(coverage ? { gradedCapture: coverage } : {}),
        ...receipt,
      }),
      { mode: 0o600 },
    );
    await chmod(temp, 0o600);
    await rename(temp, statusPath);
  }
  try {
    if (capture)
      coverage = await refreshGradedWagerExport(
        capture,
        env.SPORTSDESK_GRADED_PENDING_SNAPSHOT?.trim() || "data/live-bets.json",
      );
    stage = "projection";
    const projectionSources = capture ? [...sources, capture] : sources;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-orphans",
        "--no-env-file",
        "run",
        projector,
        ...projectionSources.flatMap((source) => ["--source", source]),
        "--out",
        output,
        "--if-changed",
      ],
      {
        cwd: resolve(dirname(projector), ".."),
        env: { PATH: env.PATH, HOME: env.HOME },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(120_000),
      },
    );
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(
        "Retained-history projector failed; last good output preserved",
      );
    const result = z
      .object({
        status: z.enum(["updated", "unchanged"]),
        generatedAt: z.string().datetime(),
      })
      .parse(JSON.parse(stdout));
    await writeReceipt(result);
    return result;
  } catch {
    await writeReceipt({
      status: "failed",
      stage,
      reason:
        stage === "capture"
          ? "Fantasy402 graded capture failed"
          : "Projection failed",
    });
    throw new Error(
      "Customer history refresh failed; see the private projection status receipt",
    );
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log(
      "Usage: bun --no-env-file run scripts/refresh_customer_history.ts\nRequires SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR (dashboard entrypoint), SPORTSDESK_CUSTOMER_HISTORY_SOURCES (JSON array of absolute export paths), SPORTSDESK_CUSTOMER_HISTORY_JSON (private output). Set SPORTSDESK_GRADED_WAGER_EXPORT to capture recent graded reports for live pending accounts before projection. Remove a stale .refresh-lock only after verifying no refresh is running.",
    );
  } else {
    try {
      console.log(JSON.stringify(await refreshCustomerHistory()));
    } catch {
      console.error(
        "Customer history refresh failed; check private configuration, source exports and status receipt",
      );
      process.exitCode = 1;
    }
  }
}
