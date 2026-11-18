import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPeerProblems,
  formatPeerProblem,
} from "../lib/peer_satisfaction.ts";

/**
 * The release-note behaviour this guards (Bun 1.4.4, "Peer dependencies resolve more like pnpm"):
 * a version the project declares wins even when it is outside a dependent's peer range, and a
 * frozen install never mentions it. On 2026-11-18 that was `react-dom@18.3.1` under
 * `react@19.3.1` — `react-dom/server` then threw at module load, taking `/tracker` with it.
 *
 * The fixture is a plain `node_modules` directory, because that is all `Bun.resolveSync` needs and
 * it keeps the check honest about the layout it is reading.
 */

const ROOT = join(import.meta.dir, "..");

function packageFixture(
  root: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): void {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js", ...extra }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

describe("collectPeerProblems", () => {
  test("reports a declared version that sits outside a dependent's peer range", () => {
    const root = mkdtempSync(join(tmpdir(), "peer-satisfaction-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          dependencies: { react: "19.3.1", "react-dom": "18.3.1" },
        }),
      );
      packageFixture(root, "react", "19.3.1", {
        exports: { ".": "./index.js" },
      });
      packageFixture(root, "react-dom", "18.3.1", {
        peerDependencies: { react: "^18.3.1" },
      });

      const problems = collectPeerProblems(root);
      expect(problems.map(formatPeerProblem)).toEqual([
        'react-dom@18.3.1 -> react@19.3.1 outside "^18.3.1"',
      ]);
      expect(problems[0]?.kind).toBe("out-of-range");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is clean when the peer is inside its range", () => {
    const root = mkdtempSync(join(tmpdir(), "peer-satisfaction-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
        }),
      );
      packageFixture(root, "react", "18.3.1");
      packageFixture(root, "react-dom", "18.3.1", {
        peerDependencies: { react: "^18.3.1" },
      });
      expect(collectPeerProblems(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips optional peers and peers that are also optional dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "peer-satisfaction-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture", dependencies: { tool: "1.0.0" } }),
      );
      packageFixture(root, "tool", "1.0.0", {
        peerDependencies: { absent: "^1.0.0", engine: "^2.0.0" },
        peerDependenciesMeta: { absent: { optional: true } },
        optionalDependencies: { engine: "^2.0.0" },
      });
      expect(collectPeerProblems(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a non-optional peer that resolves nowhere", () => {
    const root = mkdtempSync(join(tmpdir(), "peer-satisfaction-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture", dependencies: { lone: "1.0.0" } }),
      );
      packageFixture(root, "lone", "1.0.0", {
        peerDependencies: { missing: "^1.0.0" },
      });
      const problems = collectPeerProblems(root);
      expect(problems.map(formatPeerProblem)).toEqual([
        'lone@1.0.0 -> missing "^1.0.0" resolves nowhere',
      ]);
      expect(problems[0]?.kind).toBe("unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("follows transitive dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "peer-satisfaction-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture", dependencies: { outer: "1.0.0" } }),
      );
      packageFixture(root, "outer", "1.0.0", {
        dependencies: { inner: "2.0.0" },
      });
      packageFixture(root, "inner", "2.0.0", {
        peerDependencies: { core: "^3.0.0" },
      });
      packageFixture(root, "core", "4.0.0");
      expect(collectPeerProblems(root).map(formatPeerProblem)).toEqual([
        'inner@2.0.0 -> core@4.0.0 outside "^3.0.0"',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checkout's installed tree satisfies every non-optional peer", () => {
    expect(collectPeerProblems(ROOT).map(formatPeerProblem)).toEqual([]);
  });
});
