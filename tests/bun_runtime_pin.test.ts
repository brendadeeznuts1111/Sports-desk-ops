import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_RUNTIME_PIN_CODES,
  BunRuntimePinError,
  RUNTIME_PIN_DOCS,
  assertWorkspaceBunPins,
  checkRuntimePinDocs,
  findBunVersionMentions,
  readBunRuntimePin,
} from "../lib/bun_runtime_pin.ts";

const ROOT = join(import.meta.dir, "..");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bun-runtime-pin-"));
}

describe("readBunRuntimePin", () => {
  test("the checkout pin agrees across .bun-version and package.json", () => {
    const pin = readBunRuntimePin(ROOT);
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(assertWorkspaceBunPins(ROOT, pin).length).toBeGreaterThan(0);
  });

  test("present sources must agree; missing sources fail loudly", () => {
    const root = tempRoot();
    try {
      try {
        readBunRuntimePin(root);
        throw new Error("expected missing pin");
      } catch (error) {
        expect(error).toBeInstanceOf(BunRuntimePinError);
        expect((error as BunRuntimePinError).code).toBe(
          BUN_RUNTIME_PIN_CODES.missing,
        );
      }

      writeFileSync(join(root, ".bun-version"), "1.4.4\n");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          engines: { bun: "1.9.9" },
          packageManager: "bun@1.4.4",
        }),
      );
      try {
        readBunRuntimePin(root);
        throw new Error("expected mismatch");
      } catch (error) {
        expect(error).toBeInstanceOf(BunRuntimePinError);
        const pinError = error as BunRuntimePinError;
        expect(pinError.code).toBe(BUN_RUNTIME_PIN_CODES.mismatch);
        expect(pinError.message).toContain("E_BUN_RUNTIME_PIN_MISMATCH");
        expect(pinError.message).toContain("1.9.9");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a workspace engines.bun that drifts is E_BUN_RUNTIME_PIN_WORKSPACE_DRIFT", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "packages", "example"), { recursive: true });
      writeFileSync(
        join(root, "packages", "example", "package.json"),
        JSON.stringify({ name: "example", engines: { bun: "1.0.0" } }),
      );
      try {
        assertWorkspaceBunPins(root, "1.4.4");
        throw new Error("expected workspace drift");
      } catch (error) {
        expect(error).toBeInstanceOf(BunRuntimePinError);
        const pinError = error as BunRuntimePinError;
        expect(pinError.code).toBe(BUN_RUNTIME_PIN_CODES.workspaceDrift);
        expect(pinError.message).toContain("packages/example/package.json");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkRuntimePinDocs", () => {
  test("flags a drifted pin and a doc that never states the current pin", () => {
    const issues = checkRuntimePinDocs(
      {
        "README.md": "Built on the Bun runtime (v1.0.0) for the desk.",
        "AGENTS.md": "Operator tooling with no runtime version stated.",
      },
      "1.4.4",
    );
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "E_BUN_RUNTIME_PIN_DOC_DRIFT",
      "E_BUN_RUNTIME_PIN_DOC_MISSING",
    ]);
  });

  test("accepts current-pin phrasing used in the orientation docs", () => {
    const mentions = findBunVersionMentions(
      "Bun **1.4.4** (`package.json` `engines.bun`). Bun remains pinned to 1.4.4.",
    );
    expect(mentions.map((mention) => mention.version)).toEqual([
      "1.4.4",
      "1.4.4",
    ]);
    expect(
      checkRuntimePinDocs(
        { "README.md": "Always run through Bun (v1.4.4)." },
        "1.4.4",
      ),
    ).toEqual([]);
  });

  test("orientation docs in this checkout mention the derived pin", () => {
    const pin = readBunRuntimePin(ROOT);
    const docs: Record<string, string> = {};
    for (const file of RUNTIME_PIN_DOCS) {
      docs[file] = readFileSync(join(ROOT, file), "utf8");
    }
    expect(checkRuntimePinDocs(docs, pin)).toEqual([]);
  });
});
