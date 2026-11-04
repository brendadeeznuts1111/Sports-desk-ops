import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import {
  buildWeblogRollup,
  classifyIp,
  parseAccessMs,
  parseOperation,
  readWeblogJsonlChunks,
  readWeblogJsonlFile,
  readWeblogRows,
  weblogDecompressionSupport,
} from "../lib/f402_weblog.ts";

const event = (
  accessMs: number,
  loginId: string,
  ip: string,
  operation: string,
) => ({
  accessMs,
  loginId,
  ip,
  ip32: null,
  ipv6Prefix64: null,
  operation,
  ...parseOperation(operation),
});

const encoder = new TextEncoder();
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "f402-weblog-"));
  dirs.push(dir);
  return dir;
}

const weblogLine = (
  loginId: string,
  accessDateTime: string,
  ip: string,
  operation: string,
): string =>
  JSON.stringify({
    AccessDateTime: accessDateTime,
    LoginID: loginId,
    IPAddress: ip,
    Operation: operation,
  });

async function compress(
  text: string,
  format: "gzip" | "zstd",
): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Feed `bytes` as chunks split at `boundaries`, so records straddle the chunk edges. */
async function* chunksAt(
  bytes: Uint8Array,
  boundaries: readonly number[],
): AsyncGenerator<Uint8Array> {
  let previous = 0;
  for (const boundary of [...boundaries, bytes.length]) {
    if (boundary <= previous || boundary > bytes.length) continue;
    yield bytes.subarray(previous, boundary);
    previous = boundary;
  }
}

/**
 * The pre-refactor reader: readline over the same bytes plus the same row validation. Its counts
 * are the parity oracle for the streaming reader — no expected number is hand-written.
 */
async function legacyWeblogCounts(text: string): Promise<{
  total: number;
  parsed: number;
  malformed: number;
  templates: Set<string>;
}> {
  const input = Readable.from([encoder.encode(text)]);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const templates = new Set<string>();
  let total = 0;
  let parsed = 0;
  let malformed = 0;
  for await (const line of rl) {
    total += 1;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformed += 1;
      continue;
    }
    const accessMs = parseAccessMs(String(raw.AccessDateTime ?? ""));
    if (!Number.isFinite(accessMs)) {
      malformed += 1;
      continue;
    }
    parsed += 1;
    templates.add(parseOperation(raw.Operation).template);
  }
  return { total, parsed, malformed, templates };
}

describe("f402 weblog bridge", () => {
  test("decomposes UI and plain Operation strings", () => {
    const ui = parseOperation(
      " (M)  Login successful  (M)  [ v1.0.280 | www.fire22.ag ]",
    );
    expect(ui.deviceClass).toBe("M");
    expect(ui.clientVersion).toBe("1.0.280");
    expect(ui.skinDomain).toBe("www.fire22.ag");
    expect(ui.actionKind).toBe("UI:login_successful");
    expect(parseOperation("Login successful").actionKind).toBe("LOGIN");
    expect(parseOperation("Wager Accepted by:GSLIVE").actionKind).toBe(
      "WAGER_ACCEPTED:GSLIVE",
    );
    expect(parseOperation("API LOG | PARLAY | Ticket: 1").actionKind).toBe(
      "API_LOG:parlay",
    );
  });

  test("classifies CIDR ranges with unsigned masks", () => {
    expect(classifyIp("100.64.1.2")).toBe("CGNAT");
    expect(classifyIp("172.56.1.2")).toBe("T_MOBILE");
    expect(classifyIp("174.192.1.2")).toBe("VERIZON_192");
    expect(classifyIp("146.75.146.74")).toBe("ICLOUD_RELAY");
    expect(classifyIp("140.248.1.2")).toBe("BOT_RING_140_248");
    expect(classifyIp("8.8.8.8")).toBe("OTHER");
    expect(classifyIp("2001:db8::1")).toBe("IPV6_OTHER_64");
  });

  test("causal join conserves wagers and passes the four gates", () => {
    const rows = [event(1_000, "A", "146.75.146.74", "Login successful")];
    const rollup = buildWeblogRollup(
      {
        rows,
        malformed: 0,
        total: 1,
        templates: new Set(rows.map((r) => r.template)),
      },
      [{ login: "A", insertMs: 6_000, ticket: "1" }],
      0,
      10_000,
    );
    expect(rollup.join.matched).toBe(1);
    expect(rollup.join.persistentUnmatched).toBe(0);
    expect(rollup.join.nonWebChannel).toBe(0);
    expect(rollup.join.futureJoins).toBe(0);
    expect(rollup.gates.every((g) => g.status === "pass")).toBe(true);
    expect(rollup.flags.sniperTwins).toBe(0);
  });
});

describe("streaming JSONL reader", () => {
  test("multi-byte UTF-8 records that straddle chunk boundaries parse to the exact object", async () => {
    const first = weblogLine(
      "A",
      "2026-11-01 10:00:00",
      "1.2.3.4",
      "Login successful",
    );
    const second = weblogLine(
      "スナイパー",
      "2026-11-01 10:01:00",
      "1.2.3.5",
      " (M)  Login successful  (M)  [ v1.0.280 | www.fire22.ag ]",
    );
    const third = weblogLine(
      "🌍 visitor",
      "2026-11-01 10:02:00",
      "1.2.3.6",
      "API LOG | PARLAY | Ticket: 1",
    );
    const text = `${first}\n${second}\n${third}\n`;
    const bytes = encoder.encode(text);
    const byteOffset = (index: number): number =>
      encoder.encode(text.slice(0, index)).length;
    // Splits land *inside* a 3-byte and a 4-byte character, not only between records.
    const splits = [
      byteOffset(text.indexOf("ス")) + 1,
      byteOffset(text.indexOf("ス")) + 2,
      byteOffset(text.indexOf("🌍")) + 2,
    ];
    const expected = [JSON.parse(first), JSON.parse(second), JSON.parse(third)];
    for (const split of splits) {
      const read = await readWeblogJsonlChunks(chunksAt(bytes, [split]), {
        windowBytes: 5,
      });
      expect(read.values).toEqual(expected);
      expect(read.total).toBe(3);
      expect(read.malformed).toBe(0);
      expect(read.bytesConsumed).toBe(bytes.length);
    }

    const dir = await tempDir();
    const path = join(dir, "weblog.jsonl");
    await writeFile(path, bytes);
    const web = await readWeblogRows([path]);
    expect(web.rows.map((row) => row.loginId)).toEqual([
      "A",
      "スナイパー",
      "🌍 visitor",
    ]);
    expect(web.rows[1]?.operation).toBe(
      (JSON.parse(second) as { Operation: string }).Operation,
    );
    expect(web.rows[1]?.template).toBe("UI:M:login_successful:v1.0.280");
    expect(web.total).toBe(3);
    expect(web.malformed).toBe(0);
  });

  test("a .jsonl.gz fixture round-trips through the streaming reader", async () => {
    const text = [
      weblogLine(
        "A",
        "2026-11-01 10:00:00",
        "1.2.3.4",
        " (M)  Login successful  (M)  [ v1.0.280 | www.fire22.ag ]",
      ),
      weblogLine(
        "B",
        "2026-11-01 10:01:00",
        "1.2.3.5",
        "API LOG | PARLAY | Ticket: 1",
      ),
      weblogLine("C", "2026-11-01 10:02:00", "1.2.3.6", "Login successful"),
    ].join("\n");
    const dir = await tempDir();
    const path = join(dir, "weblog.jsonl.gz");
    await writeFile(path, await compress(`${text}\n`, "gzip"));

    const read = await readWeblogJsonlFile(path);
    expect(read.values).toHaveLength(3);
    expect(read.total).toBe(3);
    expect(read.malformed).toBe(0);
    // Decompressed byte length, not the gzip size: the cursor counts uncompressed bytes.
    expect(read.bytesConsumed).toBe(encoder.encode(`${text}\n`).length);

    // Magic bytes are the backup when the suffix does not name a compression.
    const mislabeled = join(dir, "weblog-magic.jsonl");
    await writeFile(mislabeled, await compress(`${text}\n`, "gzip"));
    const viaMagic = await readWeblogJsonlFile(mislabeled);
    expect(viaMagic.values).toHaveLength(3);
    expect(viaMagic.bytesConsumed).toBe(encoder.encode(`${text}\n`).length);

    const empty = join(dir, "weblog-empty.jsonl");
    await writeFile(empty, "");
    const emptyRead = await readWeblogJsonlFile(empty);
    expect(emptyRead.total).toBe(0);
    expect(emptyRead.bytesConsumed).toBe(0);

    const web = await readWeblogRows([path]);
    expect(web.rows).toHaveLength(3);
    expect(web.total).toBe(3);
    expect(web.malformed).toBe(0);
    expect([...web.templates].sort()).toEqual([
      "API_LOG",
      "LOGIN",
      "UI:M:login_successful:v1.0.280",
    ]);
  });

  test.skipIf(!weblogDecompressionSupport().zstd)(
    "a .jsonl.zst fixture round-trips through the same reader",
    async () => {
      const text = `${weblogLine("A", "2026-11-01 10:00:00", "1.2.3.4", "Login successful")}\n`;
      const dir = await tempDir();
      const path = join(dir, "weblog.jsonl.zst");
      await writeFile(path, await compress(text, "zstd"));
      const read = await readWeblogJsonlFile(path);
      expect(read.values).toHaveLength(1);
      expect(read.malformed).toBe(0);
      expect(read.bytesConsumed).toBe(encoder.encode(text).length);
      const web = await readWeblogRows([path]);
      expect(web.rows.map((row) => row.loginId)).toEqual(["A"]);
    },
  );

  test("a full read consumes exactly the file bytes and never replays the final newline", async () => {
    const first = weblogLine(
      "A",
      "2026-11-01 10:00:00",
      "1.2.3.4",
      "Login successful",
    );
    const second = weblogLine(
      "B",
      "2026-11-01 10:05:00",
      "1.2.3.5",
      "Chosen Team",
    );
    const terminated = `${first}\n${second}\n`;
    const fixtures: ReadonlyArray<{
      name: string;
      text: string;
      total: number;
      malformed: number;
    }> = [
      { name: "lf-terminated", text: terminated, total: 2, malformed: 0 },
      {
        name: "unterminated-final-line",
        text: terminated.slice(0, -1),
        total: 2,
        malformed: 0,
      },
      {
        name: "trailing-blank-lines",
        text: `${terminated}\n\n`,
        total: 4,
        malformed: 2,
      },
      {
        name: "blank-and-space-lines",
        text: `${first}\n\n   \n${second}\n`,
        total: 4,
        malformed: 2,
      },
      {
        name: "crlf",
        text: `${first}\r\n${second}\r\n`,
        total: 2,
        malformed: 0,
      },
    ];
    const dir = await tempDir();
    for (const fixture of fixtures) {
      const path = join(dir, `${fixture.name}.jsonl`);
      await writeFile(path, fixture.text);
      const bytes = encoder.encode(fixture.text);
      const read = await readWeblogJsonlFile(path);
      expect({ name: fixture.name, bytes: read.bytesConsumed }).toEqual({
        name: fixture.name,
        bytes: bytes.length,
      });
      expect({ name: fixture.name, total: read.total }).toEqual({
        name: fixture.name,
        total: fixture.total,
      });
      expect({ name: fixture.name, malformed: read.malformed }).toEqual({
        name: fixture.name,
        malformed: fixture.malformed,
      });
      expect(read.values).toHaveLength(2);
    }
  });

  test("accepts a plain array of byte chunks and rejects a record past the window bound", async () => {
    const text = `${weblogLine("A", "2026-11-01 10:00:00", "1.2.3.4", "Login successful")}\n${weblogLine("B", "2026-11-01 10:01:00", "1.2.3.5", "Chosen Team")}\n`;
    const bytes = encoder.encode(text);
    const read = await readWeblogJsonlChunks([bytes]);
    expect(read.values).toHaveLength(2);
    expect(read.bytesConsumed).toBe(bytes.length);

    // A bare byte buffer is a source too (the window loop slices it).
    const bare = await readWeblogJsonlChunks(bytes, { windowBytes: 9 });
    expect(bare.values).toEqual(read.values);
    expect(bare.bytesConsumed).toBe(bytes.length);

    const unterminated = encoder.encode("x".repeat(64));
    await expect(
      readWeblogJsonlChunks([unterminated], {
        windowBytes: 8,
        maxRecordBytes: 16,
      }),
    ).rejects.toThrow("unterminated JSONL record exceeds 16 bytes");
  });

  test("the malformed-line fallback keeps the legacy per-line counts", async () => {
    const text = [
      weblogLine("A", "2026-11-01 10:00:00", "1.2.3.4", "Login successful"),
      "not json at all",
      "",
      "   ",
      weblogLine("B", "2026-11-01 10:05:00", "1.2.3.5", "Chosen Team"),
      "{",
    ].join("\n");
    const dir = await tempDir();
    for (const [name, fixture] of [
      ["lf", text],
      ["crlf", text.replaceAll("\n", "\r\n")],
    ] as const) {
      const legacy = await legacyWeblogCounts(fixture);
      const path = join(dir, `${name}.jsonl`);
      await writeFile(path, fixture);
      const web = await readWeblogRows([path]);
      expect({ name, total: web.total }).toEqual({
        name,
        total: legacy.total,
      });
      expect({ name, parsed: web.rows.length }).toEqual({
        name,
        parsed: legacy.parsed,
      });
      expect({ name, malformed: web.malformed }).toEqual({
        name,
        malformed: legacy.malformed,
      });
      expect({ name, templates: [...web.templates].sort() }).toEqual({
        name,
        templates: [...legacy.templates].sort(),
      });
      // The bad JSON line poisons its `parseChunk` window, and the records after the blank
      // lines are still parsed: the fallback is per line, not an abandoned window.
      expect(web.rows.map((row) => row.loginId)).toEqual(["A", "B"]);
    }
  });
});
