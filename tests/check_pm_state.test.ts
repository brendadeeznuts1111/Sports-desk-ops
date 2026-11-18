/**
 * @file tests/check_pm_state.test.ts
 * @description `nodeModulesState` must separate the states `bun prune --check` conflates.
 *
 * Measured on 1.4.4: prune reports a missing `node_modules` and a dangling symlink as
 * "No node_modules folder (nothing to prune)" with exit 0, while a resolvable symlink is refused
 * with exit 1. `check:pm-state` exists to fail on all four, so the classifier is the contract.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeModulesState, stateFailure } from "../scripts/check_pm_state.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pm-state-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("nodeModulesState", () => {
  test("reports a missing folder as missing", () => {
    expect(nodeModulesState(root)).toBe("missing");
    expect(stateFailure("missing")).not.toBeNull();
  });

  test("reports a real directory as a directory", () => {
    const project = join(root, "plain");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    expect(nodeModulesState(project)).toBe("directory");
    expect(stateFailure("directory")).toBeNull();
  });

  test("distinguishes a dangling symlink from no folder at all", () => {
    const project = join(root, "dangling");
    mkdirSync(project, { recursive: true });
    symlinkSync(join(root, "never-created"), join(project, "node_modules"));
    // The distinction that matters: `existsSync` says false for both of these.
    expect(nodeModulesState(project)).toBe("broken-symlink");
    expect(stateFailure("broken-symlink")).not.toBeNull();
  });

  test("refuses a resolvable symlink, as prune does", () => {
    const store = join(root, "store", "node_modules");
    mkdirSync(store, { recursive: true });
    const project = join(root, "linked");
    mkdirSync(project, { recursive: true });
    symlinkSync(store, join(project, "node_modules"));
    expect(nodeModulesState(project)).toBe("linked-directory");
    expect(stateFailure("linked-directory")).not.toBeNull();
  });

  test("reports a plain file as not a directory", () => {
    const project = join(root, "file");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "node_modules"), "");
    expect(nodeModulesState(project)).toBe("not-a-directory");
    expect(stateFailure("not-a-directory")).not.toBeNull();
  });
});
