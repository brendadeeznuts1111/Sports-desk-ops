import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireProfileLock,
  ProfileInUseError,
  profileLockPath,
} from "../lib/f402_profile_lock.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const LOCK_MODULE_PATH = fileURLToPath(
  new URL("../lib/f402_profile_lock.ts", import.meta.url),
);

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "f402-profile-lock-"));
  roots.push(root);
  return root;
}

function readRecord(lockPath: string): { pid: number; startedAt: string } {
  return JSON.parse(readFileSync(lockPath, "utf8")) as {
    pid: number;
    startedAt: string;
  };
}

function tempFiles(root: string): string[] {
  return readdirSync(root).filter((name) => name.includes(".tmp"));
}

/** Profile lock paths are siblings of the profile directory, so this is the lock's directory. */
function lockDirectory(profile: string): string {
  return dirname(profile);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("acquireProfileLock", () => {
  test("acquires, records the owner, and releases idempotently", () => {
    const profile = join(tempRoot(), "profile");
    const lock = acquireProfileLock(profile, { pid: 4242, now: T0 });

    expect(existsSync(lock.path)).toBe(true);
    expect(lock.path).toBe(`${profile}.bun-webview.lock`);
    expect(readRecord(lock.path)).toEqual({
      pid: 4242,
      startedAt: T0.toISOString(),
    });

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lock.path)).toBe(false);
  });

  test("a live holder makes the second acquire throw ProfileInUseError", () => {
    const profile = join(tempRoot(), "profile");
    const first = acquireProfileLock(profile, { pid: 5151, now: T0 });

    let caught: unknown = null;
    try {
      acquireProfileLock(profile, {
        pid: 6262,
        now: new Date(T0.getTime() + 60_000),
        isProcessAlive: () => true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProfileInUseError);
    const error = caught as ProfileInUseError;
    expect(error.holderPid).toBe(5151);
    expect(error.startedAt).toBe(T0.toISOString());
    expect(error.profileDir).toBe(profile);
    expect(error.message).toContain(profile);
    expect(error.message).toContain("5151");
    expect(error.message).toContain(T0.toISOString());

    // The failed acquire must not clobber the holder's record.
    expect(readRecord(first.path).pid).toBe(5151);
    first.release();
  });

  test("replaces a lock older than staleMs even when the pid is alive", () => {
    const profile = join(tempRoot(), "profile");
    const first = acquireProfileLock(profile, {
      pid: 7001,
      now: T0,
      staleMs: 1_000,
    });

    expect(() =>
      acquireProfileLock(profile, {
        pid: 7002,
        now: new Date(T0.getTime() + 500),
        staleMs: 1_000,
        isProcessAlive: () => true,
      }),
    ).toThrow(ProfileInUseError);

    const second = acquireProfileLock(profile, {
      pid: 7002,
      now: new Date(T0.getTime() + 2_000),
      staleMs: 1_000,
      isProcessAlive: () => true,
    });
    expect(readRecord(second.path).pid).toBe(7002);
    // The replaced holder no longer owns the file, so its release is a no-op.
    first.release();
    expect(readRecord(second.path).pid).toBe(7002);
    second.release();
  });

  test("replaces a dead holder's lock immediately", () => {
    const profile = join(tempRoot(), "profile");
    const first = acquireProfileLock(profile, { pid: 8001, now: T0 });

    const second = acquireProfileLock(profile, {
      pid: 8002,
      now: new Date(T0.getTime() + 1_000),
      isProcessAlive: () => false,
    });

    expect(readRecord(second.path).pid).toBe(8002);
    first.release();
    expect(readRecord(second.path).pid).toBe(8002);
    second.release();
    expect(existsSync(profileLockPath(profile))).toBe(false);
  });

  test("release by a non-owner leaves the file in place", () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    const lock = acquireProfileLock(profile, { pid: 9001, now: T0 });

    const successor = `${JSON.stringify({ pid: 9002, startedAt: T0.toISOString() })}\n`;
    writeFileSync(lock.path, successor);

    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(lock.path, "utf8")).toBe(successor);
    expect(readRecord(lock.path).pid).toBe(9002);
    expect(tempFiles(lockDirectory(profile))).toEqual([]);
  });

  test("a stale holder's release leaves the successor's record alone", () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    const first = acquireProfileLock(profile, {
      pid: 9051,
      now: T0,
      staleMs: 1_000,
    });
    const second = acquireProfileLock(profile, {
      pid: 9052,
      now: new Date(T0.getTime() + 5_000),
      staleMs: 1_000,
      isProcessAlive: () => true,
    });

    first.release();
    expect(readRecord(second.path).pid).toBe(9052);
    second.release();
    expect(existsSync(second.path)).toBe(false);
    expect(tempFiles(lockDirectory(profile))).toEqual([]);
  });

  test("[Symbol.dispose] releases at the end of the block", () => {
    const profile = join(tempRoot(), "profile");
    {
      using lock = acquireProfileLock(profile, { pid: 9101, now: T0 });
      expect(existsSync(lock.path)).toBe(true);
    }
    expect(existsSync(profileLockPath(profile))).toBe(false);
  });

  test("the lock file is a sibling of the profile directory", () => {
    const root = tempRoot();
    const profile = join(root, "nested", "profile");
    const lock = acquireProfileLock(profile, { pid: 9201, now: T0 });

    expect(lock.path).toBe(`${profile}.bun-webview.lock`);
    expect(profileLockPath(profile)).toBe(`${profile}.bun-webview.lock`);
    expect(dirname(lock.path)).toBe(join(root, "nested"));
    expect(lock.path.startsWith(`${profile}/`)).toBe(false);
    expect(existsSync(lock.path)).toBe(true);

    lock.release();
  });

  test("acquire/release does not leak exit listeners", () => {
    const baseline = process.listenerCount("exit");
    const profile = join(tempRoot(), "profile");
    for (let i = 0; i < 3; i++) {
      acquireProfileLock(profile, { pid: 9300 + i, now: T0 }).release();
    }
    expect(process.listenerCount("exit")).toBe(baseline);
  });

  test("a symlinked profile directory resolves to one lock", () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    mkdirSync(profile, { recursive: true });
    const link = join(root, "profile-link");
    symlinkSync(profile, link);

    const realProfile = realpathSync.native(profile);
    const first = acquireProfileLock(profile, { pid: 4401, now: T0 });

    expect(profileLockPath(link)).toBe(profileLockPath(profile));
    expect(profileLockPath(profile)).toBe(`${realProfile}.bun-webview.lock`);
    expect(first.path).toBe(`${realProfile}.bun-webview.lock`);

    let caught: unknown = null;
    try {
      acquireProfileLock(link, {
        pid: 4402,
        now: new Date(T0.getTime() + 60_000),
        isProcessAlive: () => true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProfileInUseError);
    expect((caught as ProfileInUseError).holderPid).toBe(4401);
    // The message names the real directory, so it matches the path in the error object.
    expect((caught as ProfileInUseError).profileDir).toBe(realProfile);
    expect((caught as ProfileInUseError).message).toContain(realProfile);

    first.release();
    expect(existsSync(profileLockPath(link))).toBe(false);
    expect(existsSync(profileLockPath(profile))).toBe(false);
  });

  test("a missing profile directory falls back to the lexical path", () => {
    const root = tempRoot();
    const profile = join(root, "not-created-yet");
    expect(profileLockPath(profile)).toBe(`${profile}.bun-webview.lock`);
  });

  test("an empty or partial record is treated as abandoned and replaced", () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    const lockPath = profileLockPath(profile);
    const payloads = ["", '{"pid":', '{"pid":4242,"startedAt":"2026-'];

    for (const payload of payloads) {
      writeFileSync(lockPath, payload);

      // `isProcessAlive: () => true` proves the recovery comes from the unreadable record, not
      // from the pid looking dead.
      const lock = acquireProfileLock(profile, {
        pid: 4501,
        now: T0,
        isProcessAlive: () => true,
      });
      expect(existsSync(lock.path)).toBe(true);
      expect(readRecord(lock.path)).toEqual({
        pid: 4501,
        startedAt: T0.toISOString(),
      });

      lock.release();
      expect(existsSync(lockPath)).toBe(false);
      expect(tempFiles(root)).toEqual([]);
    }
  });

  test("a recycled pid blocks a new run until staleMs (documented tradeoff)", () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    const first = acquireProfileLock(profile, { pid: 9601, now: T0 });

    // `isProcessAlive` cannot tell a recycled pid from the original holder.
    expect(() =>
      acquireProfileLock(profile, {
        pid: 9602,
        now: new Date(T0.getTime() + 60 * 60 * 1000),
        isProcessAlive: () => true,
      }),
    ).toThrow(ProfileInUseError);

    const second = acquireProfileLock(profile, {
      pid: 9602,
      now: new Date(T0.getTime() + 13 * 60 * 60 * 1000),
      isProcessAlive: () => true,
    });
    expect(readRecord(second.path).pid).toBe(9602);
    first.release();
    second.release();
  });
});

describe("concurrent acquisition", () => {
  const CHILD_SOURCE = `import { renameSync, writeFileSync } from "node:fs";
import { acquireProfileLock } from ${JSON.stringify(LOCK_MODULE_PATH)};

const [profileDir, startAtRaw, statusPath] = process.argv.slice(2);
const startAt = Number(startAtRaw);
// Spin until every sibling is resident, so the acquire calls really interleave.
while (Date.now() < startAt) Bun.sleepSync(1);

let status;
try {
  const lock = acquireProfileLock(profileDir);
  status = { status: "acquired", pid: process.pid, path: lock.path };
} catch (error) {
  const failure = error;
  status = {
    status: failure?.name === "ProfileInUseError" ? "in-use" : "error",
    pid: process.pid,
    holderPid: failure?.holderPid ?? null,
    message: String(failure?.message ?? failure),
  };
}
// The parent polls for statusPath and reads it as soon as it exists, so it must appear complete.
// The suffix avoids ".tmp", which the parent's leak check reserves for the lock module.
writeFileSync(\`\${statusPath}.partial\`, JSON.stringify(status));
renameSync(\`\${statusPath}.partial\`, statusPath);
if (status.status === "acquired") {
  // Hold it until the parent kills us; a normal exit would release it.
  while (true) Bun.sleepSync(50);
}
`;

  interface RaceStatus {
    status: "acquired" | "in-use" | "error";
    pid: number;
    path?: string;
    holderPid?: number | null;
    message?: string;
  }

  async function raceRound(
    root: string,
    round: number,
    contenders: number,
    staleRecord?: string,
  ): Promise<RaceStatus[]> {
    const profile = join(root, `profile-${round}`);
    mkdirSync(profile, { recursive: true });
    if (staleRecord !== undefined) {
      writeFileSync(profileLockPath(profile), staleRecord);
    }
    const scriptPath = join(root, `race-child-${round}.ts`);
    writeFileSync(scriptPath, CHILD_SOURCE);

    const startAt = Date.now() + 200;
    const statusPaths = Array.from({ length: contenders }, (_, index) =>
      join(root, `status-${round}-${index}.json`),
    );
    const procs = statusPaths.map((statusPath) =>
      Bun.spawn(
        [process.execPath, scriptPath, profile, String(startAt), statusPath],
        { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
      ),
    );

    try {
      const deadline = Date.now() + 10_000;
      while (!statusPaths.every(existsSync) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      const missing = statusPaths.filter((path) => !existsSync(path));
      expect(missing).toEqual([]);

      const lockPath = profileLockPath(profile);
      const statuses = statusPaths.map(
        (path) => JSON.parse(readFileSync(path, "utf8")) as RaceStatus,
      );
      const winners = statuses.filter((s) => s.status === "acquired");
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner === undefined) throw new Error("race produced no winner");
      expect(winner.path).toBe(lockPath);
      expect(readRecord(lockPath).pid).toBe(winner.pid);

      const losers = statuses.filter((s) => s.status !== "acquired");
      expect(losers).toHaveLength(contenders - 1);
      for (const loser of losers) {
        expect(loser.status).toBe("in-use");
        expect(loser.holderPid).toBe(winner.pid);
      }
      expect(tempFiles(root)).toEqual([]);
      return statuses;
    } finally {
      for (const proc of procs) proc.kill();
      await Promise.all(procs.map((proc) => proc.exited));
      rmSync(profileLockPath(profile), { force: true });
    }
  }

  test("processes racing for one profile leave exactly one holder", async () => {
    const root = tempRoot();
    for (let round = 0; round < 3; round++) {
      const statuses = await raceRound(root, round, 6);
      expect(statuses.filter((s) => s.status === "acquired")).toHaveLength(1);
    }
  }, 20_000);

  test("processes racing to replace a stale lock leave exactly one holder", async () => {
    const root = tempRoot();
    const stale = `${JSON.stringify({ pid: 999_999, startedAt: "2020-01-01T00:00:00.000Z" })}\n`;
    for (let round = 0; round < 3; round++) {
      const statuses = await raceRound(root, round, 6, stale);
      expect(statuses.filter((s) => s.status === "acquired")).toHaveLength(1);
    }
  }, 20_000);

  test("process exit removes the lock file", async () => {
    const root = tempRoot();
    const profile = join(root, "profile");
    mkdirSync(profile, { recursive: true });
    const scriptPath = join(root, "exit-child.ts");
    const statusPath = join(root, "exit-status.json");
    writeFileSync(
      scriptPath,
      `import { existsSync, writeFileSync } from "node:fs";
import { acquireProfileLock } from ${JSON.stringify(LOCK_MODULE_PATH)};

const [profileDir, statusPath] = process.argv.slice(2);
const lock = acquireProfileLock(profileDir);
writeFileSync(statusPath, JSON.stringify({ path: lock.path, at: existsSync(lock.path) }));
process.exit(0);
`,
    );

    const proc = Bun.spawn(
      [process.execPath, scriptPath, profile, statusPath],
      { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
    );
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
      path: string;
      at: boolean;
    };
    expect(status.at).toBe(true);
    expect(status.path).toBe(profileLockPath(profile));
    // The child exited through `process.exit()`, so only the exit hook can have removed it.
    expect(existsSync(status.path)).toBe(false);
  }, 20_000);
});
