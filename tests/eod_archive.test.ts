import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEodTarGzFromPaths,
  sha256HexBytes,
  sha256MembersInTarGz,
  writeEodTarGz,
} from "../lib/eod_archive.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

describe("eod_archive", () => {
  test("writeEodTarGz emits gzip, not a bare tar under a .tar.gz name", async () => {
    // Regression: `Bun.write(dest, archive)` serialises the Archive instance
    // without applying `{ compress: "gzip" }`. Readers accept tar and tar.gz
    // alike, so nothing caught it while EOD bundles shipped uncompressed.
    const dir = mkdtempSync(join(tmpdir(), "eod-gzip-"));
    const out = join(dir, "EOD.tar.gz");
    const body = new Uint8Array(64 * 1024).fill(0x41);

    const written = await writeEodTarGz(out, { "audit.jsonl": body });
    const bytes = readFileSync(out);

    expect(bytes.length).toBe(written);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(bytes.length).toBeLessThan(body.length);

    const tar = Bun.gunzipSync(bytes);
    const files = await new Bun.Archive(tar).files();
    expect([...files.keys()]).toEqual(["audit.jsonl"]);
    expect(files.get("audit.jsonl")?.size).toBe(body.length);
  });

  test("createEodTarGz bundles jsonl and omits wal sidecars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eod-"));
    const jsonl = join(dir, "audit.jsonl");
    writeFileSync(jsonl, '{"id":1}\n');

    const dbPath = join(dir, "desk.sqlite");
    const db = openSportsdeskSqlite(dbPath);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    db.close();

    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    const out = join(dir, "EOD.tar.gz");
    await createEodTarGzFromPaths(out, [
      { archiveName: "audit.jsonl", path: jsonl },
      { archiveName: "desk.sqlite", path: dbPath, sqlite: true },
    ]);

    const hashes = await sha256MembersInTarGz(out, "*");
    expect(hashes.has("audit.jsonl")).toBe(true);
    expect(hashes.has("desk.sqlite")).toBe(true);
    expect(hashes.has("desk.sqlite-wal")).toBe(false);
    expect(hashes.has("desk.sqlite-shm")).toBe(false);

    if (await Bun.file(walPath).exists()) {
      expect(hashes.get("desk.sqlite")).not.toBe(
        sha256HexBytes(await Bun.file(walPath).bytes()),
      );
    }
    void shmPath;
  });

  test("sha256MembersInTarGz default glob includes nested archive paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eod-nested-"));
    const nestedDir = join(dir, "audit");
    mkdirSync(nestedDir, { recursive: true });
    const jsonl = join(nestedDir, "events.jsonl");
    writeFileSync(jsonl, '{"e":1}\n');

    const out = join(dir, "EOD.tar.gz");
    await createEodTarGzFromPaths(out, [
      { archiveName: "audit/events.jsonl", path: jsonl },
    ]);

    const hashes = await sha256MembersInTarGz(out);
    expect(hashes.has("audit/events.jsonl")).toBe(true);
  });
});
