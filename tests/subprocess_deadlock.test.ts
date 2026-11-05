import { describe, expect, test } from "bun:test";

/** Complete-output checks: wait for child writes and drain both pipes concurrently. */
describe("Subprocess pipe output integrity", () => {
  const ONE_MEGABYTE = 1024 * 1024;

  test("awaited writes preserve stdout and stderr beyond pipe capacity", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `await Promise.all([
        Bun.write(Bun.stdout, "X".repeat(${ONE_MEGABYTE})),
        Bun.write(Bun.stderr, "E".repeat(${ONE_MEGABYTE}))
      ]);`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("X".repeat(ONE_MEGABYTE));
    expect(stderr).toBe("E".repeat(ONE_MEGABYTE));
  });

  test("repeated awaited stdout writes retain every chunk before natural exit", async () => {
    const chunks = 16;
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `for (let index = 0; index < ${chunks}; index++) {
        await Bun.write(Bun.stdout, String(index).padStart(2, "0").repeat(32768));
      }`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const expected = Array.from({ length: chunks }, (_, index) =>
      String(index).padStart(2, "0").repeat(32768),
    ).join("");
    expect(stdout).toBe(expected);
  });

  test("Bun Shell drains complete output from a naturally exiting child", async () => {
    const { $ } = await import("bun");
    const output =
      await $`${process.execPath} -e 'await Bun.write(Bun.stdout, "X".repeat(1024 * 1024))'`.quiet();
    const result = output.bytes();
    expect(result.byteLength).toBe(ONE_MEGABYTE);
    expect(result.every((byte: number) => byte === 0x58)).toBe(true);
  });
});
