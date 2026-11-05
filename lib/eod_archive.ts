/**
 * EOD tar.gz bundles via Bun.Archive (gzip level from lib/archive_policy.ts).
 *
 * Large verify: use extract() — `.files()` loads the whole archive into memory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_COMPRESS } from "./archive_policy.ts";
import {
  openSportsdeskSqlite,
  truncateWalAndDisablePersist,
} from "./sportsdesk_sqlite.ts";

export { ARCHIVE_COMPRESS };

/** Prefer extract-based verify above this compressed size (bytes). */
export const EOD_ARCHIVE_EXTRACT_VERIFY_BYTES = 32 * 1024 * 1024;

export type EodArchiveMemberSpec = {
  /** Path inside the tar (e.g. audit/trading_desk_audit.jsonl). */
  archiveName: string;
  /** Filesystem source. */
  path: string;
  /** Flush WAL into the main file before read (default for .sqlite/.db). */
  sqlite?: boolean;
};

export function flushSqliteWalForArchive(dbPath: string): void {
  const db = openSportsdeskSqlite(dbPath);
  try {
    truncateWalAndDisablePersist(db);
  } finally {
    db.close();
  }
}

function isSqlitePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".sqlite") || lower.endsWith(".db");
}

export async function collectEodArchiveMembers(
  members: readonly EodArchiveMemberSpec[],
): Promise<Record<string, Uint8Array>> {
  const payload: Record<string, Uint8Array> = {};
  for (const member of members) {
    const file = Bun.file(member.path);
    if (!(await file.exists())) {
      throw new Error(`eod archive: missing ${member.path}`);
    }
    const sqlite = member.sqlite ?? isSqlitePath(member.path);
    if (sqlite) {
      flushSqliteWalForArchive(member.path);
    }
    payload[member.archiveName] = await file.bytes();
  }
  return payload;
}

export async function writeEodTarGz(
  destination: string,
  members: Record<string, Uint8Array>,
): Promise<number> {
  const archive = new Bun.Archive(members, ARCHIVE_COMPRESS);
  return Bun.write(destination, archive);
}

export async function createEodTarGzFromPaths(
  destination: string,
  members: readonly EodArchiveMemberSpec[],
): Promise<number> {
  const payload = await collectEodArchiveMembers(members);
  return writeEodTarGz(destination, payload);
}

export function sha256HexBytes(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash("sha256", bytes, "hex");
}

const TAR_BLOCK = 512;

function readTarCString(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  const slice = bytes.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function readTarSize(header: Uint8Array): number {
  if (((header[124] ?? 0) & 0x80) !== 0) {
    let value = 0;
    for (let index = 125; index < 136; index++) {
      value = value * 256 + (header[index] ?? 0);
    }
    return value;
  }
  const raw = readTarCString(header, 124, 12).trim();
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function tarEntryName(header: Uint8Array): string {
  const name = readTarCString(header, 0, 100);
  if (readTarCString(header, 257, 6) !== "ustar") return name;
  const prefix = readTarCString(header, 345, 155);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function isUnsafeTarName(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

/**
 * Reject entries that `extract()` would follow outside the destination.
 *
 * `Bun.Archive.extract()` remaps `../` and absolute names under the target, but it follows
 * a symlink entry: a tar containing `link -> /outside` plus `link/evil` writes outside the
 * target directory (measured on 1.4.4). EOD archives are generated locally and never carry
 * links, so refusing links and unsafe names is the safe default before extracting.
 */
export function assertSafeTar(tar: Uint8Array): void {
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(header[156] ?? 0);
    const size = readTarSize(header);
    const dataStart = offset + TAR_BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);

    if (type === "L") {
      pendingPath = readTarCString(data, 0, data.length);
    } else if (type === "x") {
      const text = new TextDecoder().decode(data);
      const match = /(?:^|\n)(?:\d+ )?path=([^\n]*)\n/.exec(text);
      if (match?.[1] !== undefined) pendingPath = match[1];
    } else if (type !== "g") {
      const name = pendingPath ?? tarEntryName(header);
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw new Error(
          `eod archive: unsupported tar entry type ${JSON.stringify(type)} for ${name}`,
        );
      }
      if (isUnsafeTarName(name)) {
        throw new Error(
          `eod archive: unsafe tar entry ${JSON.stringify(name)}`,
        );
      }
      pendingPath = undefined;
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

export function assertSafeTarGz(bytes: Uint8Array): void {
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  assertSafeTar(gzip ? Bun.gunzipSync(new Uint8Array(bytes)) : bytes);
}

/**
 * Hash selected members. Uses `.files(glob)` when small; `extract()` when large.
 */
export async function sha256MembersInTarGz(
  archivePath: string,
  /** `*` only matches tar root; use `**` for nested paths (e.g. audit/*.jsonl). */
  glob = "**",
): Promise<Map<string, string>> {
  const stat = await Bun.file(archivePath).stat();
  const bytes = await Bun.file(archivePath).bytes();
  const archive = new Bun.Archive(bytes);

  if (stat.size <= EOD_ARCHIVE_EXTRACT_VERIFY_BYTES) {
    const selected = await archive.files(glob);
    const out = new Map<string, string>();
    const entries =
      selected instanceof Map
        ? selected.entries()
        : Object.entries(selected as Record<string, unknown>);
    for (const [name, content] of entries) {
      const buf =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content instanceof Uint8Array
            ? content
            : content instanceof Blob
              ? new Uint8Array(await content.arrayBuffer())
              : new Uint8Array(
                  await new Blob([
                    content as string | Blob | ArrayBuffer | Uint8Array,
                  ]).arrayBuffer(),
                );
      out.set(name, sha256HexBytes(buf));
    }
    return out;
  }

  assertSafeTarGz(bytes);
  const dir = mkdtempSync(join(tmpdir(), "eod-verify-"));
  try {
    await archive.extract(dir);
    const out = new Map<string, string>();
    const globber = new Bun.Glob(glob);
    for await (const rel of globber.scan({ cwd: dir, onlyFiles: true })) {
      const full = join(dir, rel);
      const fileBytes = await Bun.file(full).bytes();
      out.set(rel.replaceAll("\\", "/"), sha256HexBytes(fileBytes));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
