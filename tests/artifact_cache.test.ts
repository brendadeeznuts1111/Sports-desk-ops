import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedJsonFile,
  readFileBytes,
  resetArtifactCache,
} from "../lib/artifact_cache.ts";

/**
 * Every artifact route re-read and re-parsed its file per request: 0.85 ms for the 94 KB agent
 * tree, 0.53 ms for the 110 KB contest list. The cache is keyed on mtime + size, so the two things
 * that must be true are (a) a hit does not parse, and (b) a rewrite is seen on the next request.
 */

const dir = join(
  tmpdir(),
  `sportsdesk-artifact-cache-${process.pid}-${Date.now()}`,
);
mkdirSync(dir, { recursive: true });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetArtifactCache();
});

describe("cachedJsonFile", () => {
  test("parses once, then serves the same value", async () => {
    const path = join(dir, "a.json");
    writeFileSync(path, JSON.stringify({ n: 1 }));
    let parses = 0;
    const artifact = cachedJsonFile(path, (raw) => {
      parses += 1;
      return raw as { n: number };
    });

    const first = await artifact.read();
    const second = await artifact.read();
    expect(first?.value).toEqual({ n: 1 });
    expect(second?.value).toEqual({ n: 1 });
    expect(parses).toBe(1);
    expect(second?.version).toBe(first?.version ?? "");
  });

  test("a rewrite is picked up immediately, with a new version", async () => {
    const path = join(dir, "b.json");
    writeFileSync(path, JSON.stringify({ n: 1 }));
    let parses = 0;
    const artifact = cachedJsonFile(path, (raw) => {
      parses += 1;
      return raw as { n: number };
    });
    const first = await artifact.read();

    // Different length as well as a new mtime: some filesystems coarsen mtime.
    writeFileSync(path, JSON.stringify({ n: 22 }));
    const second = await artifact.read();

    expect(parses).toBe(2);
    expect(second?.value).toEqual({ n: 22 });
    expect(second?.version).not.toBe(first?.version ?? "");
  });

  test("an absent file is null and is not cached as a value", async () => {
    const path = join(dir, "missing.json");
    const artifact = cachedJsonFile(path, (raw) => raw);
    expect(await artifact.read()).toBeNull();
    writeFileSync(path, JSON.stringify({ appeared: true }));
    expect(await artifact.read()).toEqual({
      version: expect.any(String),
      value: { appeared: true },
    });
  });

  test("deleting the file forgets the cached value", async () => {
    const path = join(dir, "gone.json");
    writeFileSync(path, JSON.stringify({ n: 1 }));
    const artifact = cachedJsonFile(path, (raw) => raw as { n: number });
    expect((await artifact.read())?.value).toEqual({ n: 1 });
    rmSync(path);
    expect(await artifact.read()).toBeNull();
  });

  test("a parse error surfaces on the read that finds the new file", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    const artifact = cachedJsonFile(path, (raw) => raw);
    await expect(artifact.read()).rejects.toThrow();
  });
});

describe("readFileBytes", () => {
  test("returns bytes and a version, and reuses them until the file changes", async () => {
    const path = join(dir, "bytes.txt");
    writeFileSync(path, "hello");
    const first = await readFileBytes(path);
    expect(new TextDecoder().decode(first?.value)).toBe("hello");

    const second = await readFileBytes(path);
    expect(second?.value).toBe(first?.value); // same cached view, not a re-read

    writeFileSync(path, "hello world");
    const third = await readFileBytes(path);
    expect(new TextDecoder().decode(third?.value)).toBe("hello world");
    expect(third?.version).not.toBe(first?.version ?? "");
  });

  test("an absent file is null", async () => {
    expect(await readFileBytes(join(dir, "nope.txt"))).toBeNull();
  });
});
