/**
 * Process-level lock for a Bun.WebView dataStore directory.
 *
 * Chrome's profile singleton is per-directory: a second Bun process that opens the same
 * dataStore fails with an opaque "Chrome process closed the pipe" instead of naming the
 * conflict. The lock file lives beside the profile (`<dir>.bun-webview.lock`), never inside
 * it, so Chrome never sees an unexpected entry.
 *
 * Identity is the real directory: `realpathSync.native(profileDir)` when it exists, so a
 * symlinked alias of the same profile resolves to the same lock file instead of a second one.
 *
 * Creation is atomic in content as well as in name: the record is written to a sibling temp
 * file and hard-linked into place, so a record at the lock path is always complete. Removing a
 * record — takeover of a stale one, or release — happens only under a sibling mutex
 * (`<lock>.reap`) and only when the path still holds the record that was judged, so concurrent
 * takeovers produce exactly one winner and a release never deletes a successor's record.
 *
 * Pid reuse: a record blocks while its pid is alive and its `startedAt` is younger than
 * `staleMs` — 12 hours by default ({@link DEFAULT_PROFILE_LOCK_STALE_MS}). An unrelated process
 * that inherits a recycled pid can therefore block a run for up to `staleMs`. That default is
 * deliberate: a real WebView session can outlast any shorter window, and a blocked run reports
 * the record's `startedAt`, so a stale-owner false positive is diagnosable. Pass a smaller
 * `staleMs` only when the caller knows its sessions are shorter.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** Default window after which a lock is considered abandoned even if its pid still exists. */
export const DEFAULT_PROFILE_LOCK_STALE_MS = 12 * 60 * 60 * 1000;

const LOCK_SUFFIX = ".bun-webview.lock";

/** Reads of an unreadable record before it is treated as abandoned. */
const RECORD_READ_ATTEMPTS = 3;
/** Gap between those reads; covers a writer whose bytes are still landing. */
const RECORD_READ_RETRY_MS = 10;

/** Bound on create/read/takeover passes, so a pathological race cannot spin forever. */
const ACQUIRE_ATTEMPTS = 8;

/** Sibling file whose exclusive creation serializes every removal of a lock record. */
const REMOVAL_MUTEX_SUFFIX = ".reap";
/** How long a remover waits for the mutex before giving up on that removal. */
const REMOVAL_MUTEX_WAIT_MS = 2_000;
/** A mutex older than this was left by a process that died while holding it. */
const REMOVAL_MUTEX_STALE_MS = 10_000;

interface ProfileLockRecord {
  pid: number;
  startedAt: string;
}

export class ProfileInUseError extends Error {
  readonly profileDir: string;
  readonly holderPid: number;
  readonly startedAt: string;

  constructor(profileDir: string, holderPid: number, startedAt: string) {
    super(
      `WebView profile ${profileDir} is already in use by pid ${holderPid} ` +
        `(startedAt ${startedAt}); wait for that process to exit or pass a different --profile`,
    );
    this.name = "ProfileInUseError";
    this.profileDir = profileDir;
    this.holderPid = holderPid;
    this.startedAt = startedAt;
  }
}

export interface ProfileLock {
  readonly path: string;
  release(): void;
  [Symbol.dispose](): void;
}

export interface AcquireProfileLockOptions {
  /** Owner recorded in the lock file; defaults to the current process. */
  readonly pid?: number | undefined;
  /** Clock used for `startedAt` and staleness; defaults to `new Date()`. */
  readonly now?: Date | undefined;
  /** Age after which a live pid no longer blocks a new run. */
  readonly staleMs?: number | undefined;
  /** Liveness probe; defaults to `process.kill(pid, 0)` with ESRCH meaning dead. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}

/**
 * The directory a profile argument names: its real path when it exists, its lexical path when
 * it does not. Two symlinked aliases of one profile therefore collide on one lock file.
 */
function resolveProfileDir(profileDir: string): string {
  try {
    return realpathSync.native(profileDir);
  } catch {
    return resolve(profileDir);
  }
}

/** Resolve the sibling lock path for a profile directory. */
export function profileLockPath(profileDir: string): string {
  return `${resolveProfileDir(profileDir)}${LOCK_SUFFIX}`;
}

function readLockRecord(lockPath: string): ProfileLockRecord | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, startedAt } = parsed as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    if (typeof startedAt !== "string") return null;
    if (!Number.isFinite(Date.parse(startedAt))) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  if (typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the record, retrying briefly: another process may have created the path a moment ago
 * and its bytes may still be landing (an older writer used a plain `wx` write for this).
 */
function readLockRecordWithRetry(lockPath: string): ProfileLockRecord | null {
  for (let attempt = 1; ; attempt++) {
    const record = readLockRecord(lockPath);
    if (record !== null) return record;
    if (attempt >= RECORD_READ_ATTEMPTS) return null;
    sleepSync(RECORD_READ_RETRY_MS);
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a cleanup failure must not mask the caller's own error.
  }
}

/**
 * Create `lockPath` with `payload` atomically in name and content.
 *
 * The record is written to a sibling temp file (same directory, so the same filesystem) and
 * then `linkSync`ed into place: the lock path either does not exist or names a complete record.
 * A plain `writeFileSync(lockPath, ..., { flag: "wx" })` does not give that — the path exists
 * with zero bytes before the bytes land, and a loser reading then sees an empty record.
 *
 * @returns `true` when this call created the lock, `false` when another holder already exists.
 */
function createLockFile(
  lockPath: string,
  payload: string,
  pid: number,
): boolean {
  const nonce = Bun.randomUUIDv7();
  const tmpPath = `${lockPath}.${pid}.${nonce}.tmp`;
  try {
    writeFileSync(tmpPath, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(tmpPath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    // `tmpPath` and `lockPath` are the same inode after a successful link, so the lock survives.
    removeQuietly(tmpPath);
  }
}

function recordMatches(
  record: ProfileLockRecord | null,
  expected: ProfileLockRecord | null,
): boolean {
  if (expected === null) return record === null;
  return (
    record !== null &&
    record.pid === expected.pid &&
    record.startedAt === expected.startedAt
  );
}

/**
 * Run `fn` while holding `<lockPath>.reap`, the mutex every remover of `lockPath` takes.
 *
 * @returns `false` when the mutex stayed busy for {@link REMOVAL_MUTEX_WAIT_MS}; `fn` did not run.
 */
function withRemovalMutex(lockPath: string, fn: () => void): boolean {
  const mutexPath = `${lockPath}${REMOVAL_MUTEX_SUFFIX}`;
  const deadline = Date.now() + REMOVAL_MUTEX_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(mutexPath, "", { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const heldMs = mutexAgeMs(mutexPath);
    if (heldMs !== null && heldMs > REMOVAL_MUTEX_STALE_MS) {
      // A holder died inside a section that takes microseconds.
      removeQuietly(mutexPath);
      continue;
    }
    if (Date.now() >= deadline) return false;
    sleepSync(1);
  }
  try {
    fn();
  } finally {
    removeQuietly(mutexPath);
  }
  return true;
}

function mutexAgeMs(mutexPath: string): number | null {
  try {
    return Date.now() - statSync(mutexPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove `lockPath` only when it still holds the record we decided about.
 *
 * Creation never overwrites (it links onto an absent path) and every removal holds the removal
 * mutex, so the record read inside the mutex is the one unlinked. The path is never emptied and
 * refilled: putting a successor's record back opened a window in which a third contender could
 * link its own, leaving two holders.
 *
 * @param expected `null` removes the path only if it is still unreadable.
 */
function removeLockRecord(
  lockPath: string,
  expected: ProfileLockRecord | null,
): void {
  withRemovalMutex(lockPath, () => {
    if (!existsSync(lockPath)) return;
    if (recordMatches(readLockRecord(lockPath), expected)) {
      removeQuietly(lockPath);
    }
  });
}

/** `process.kill(pid, 0)` probe: ESRCH means gone, EPERM means alive but not ours. */
export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function buildLock(
  lockPath: string,
  pid: number,
  startedAt: string,
): ProfileLock {
  const owned: ProfileLockRecord = { pid, startedAt };
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    removeLockRecord(lockPath, owned);
  };

  // `process.exit()` skips dispose scopes; the exit hook is what actually cleans up there.
  process.once("exit", release);

  return {
    path: lockPath,
    release,
    [Symbol.dispose](): void {
      release();
    },
  };
}

/**
 * Take the process-level lock for `profileDir`.
 *
 * A lock held by a live pid younger than `staleMs` throws {@link ProfileInUseError}; a lock
 * whose pid is gone (ESRCH), older than `staleMs`, or unreadable even after retries is replaced.
 * Replacement removes the judged record under the removal mutex and then links a fresh one, so two contenders
 * replacing the same stale lock leave exactly one record behind.
 */
export function acquireProfileLock(
  profileDir: string,
  options: AcquireProfileLockOptions = {},
): ProfileLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? DEFAULT_PROFILE_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  const resolvedDir = resolveProfileDir(profileDir);
  const lockPath = `${resolvedDir}${LOCK_SUFFIX}`;
  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = now.toISOString();
  const payload = `${JSON.stringify({ pid, startedAt })}\n`;

  for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
    if (createLockFile(lockPath, payload, pid)) {
      return buildLock(lockPath, pid, startedAt);
    }

    const existing = readLockRecordWithRetry(lockPath);
    if (existing !== null) {
      const ageMs = now.getTime() - Date.parse(existing.startedAt);
      if (ageMs <= staleMs && isProcessAlive(existing.pid)) {
        throw new ProfileInUseError(
          resolvedDir,
          existing.pid,
          existing.startedAt,
        );
      }
    }

    // Stale, dead, or still unreadable: clear exactly the bytes we judged, then race for the
    // link again. If another contender wins that link, the next pass re-reads its record
    // instead of overwriting it.
    removeLockRecord(lockPath, existing);
  }

  const last = readLockRecord(lockPath);
  if (last !== null) {
    throw new ProfileInUseError(resolvedDir, last.pid, last.startedAt);
  }
  throw new Error(
    `Could not acquire the WebView profile lock ${lockPath} after ` +
      `${ACQUIRE_ATTEMPTS} attempts; another process keeps recreating it`,
  );
}
