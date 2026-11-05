import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendExecutionApproval,
  approvedSignalIds,
  readExecutionApprovals,
} from "../lib/execution_approvals.ts";

const ROOT = mkdtempSync(join(tmpdir(), "execution-approvals-"));
afterAllCleanup();

function afterAllCleanup(): void {
  process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
}

describe("execution approvals", () => {
  test("missing ledger reads as empty, not an error", async () => {
    const state = await readExecutionApprovals(join(ROOT, "missing"));
    expect(state.rows).toEqual([]);
    expect(state.latest.size).toBe(0);
  });

  test("approve and reject append, and the latest decision wins", async () => {
    const approved = await appendExecutionApproval(ROOT, {
      signalId: "sig-1",
      action: "approve",
      actor: "alice",
      style: "maker",
      atIso: "2026-11-05T00:00:00.000Z",
    });
    expect(approved.style).toBe("maker");
    expect(await approvedSignalIds(await readExecutionApprovals(ROOT))).toEqual(
      ["sig-1"],
    );

    await appendExecutionApproval(ROOT, {
      signalId: "sig-1",
      action: "reject",
      actor: "bob",
      reason: "price moved",
      atIso: "2026-11-05T00:01:00.000Z",
    });
    const state = await readExecutionApprovals(ROOT);
    expect(state.latest.get("sig-1")?.actor).toBe("bob");
    expect(state.latest.get("sig-1")?.reason).toBe("price moved");
    expect(await approvedSignalIds(state)).toEqual([]);
  });

  test("actor and rejection reason are required", async () => {
    await expect(
      appendExecutionApproval(ROOT, {
        signalId: "sig-2",
        action: "approve",
        actor: " ",
      }),
    ).rejects.toThrow("actor is required");
    await expect(
      appendExecutionApproval(ROOT, {
        signalId: "sig-2",
        action: "reject",
        actor: "alice",
        reason: " ",
      }),
    ).rejects.toThrow("rejection requires a reason");
  });

  test("an approved signal id is unique per latest decision", async () => {
    await appendExecutionApproval(ROOT, {
      signalId: "sig-3",
      action: "approve",
      actor: "alice",
    });
    await appendExecutionApproval(ROOT, {
      signalId: "sig-3",
      action: "approve",
      actor: "bob",
      style: "taker",
    });
    const state = await readExecutionApprovals(ROOT);
    expect(await approvedSignalIds(state)).toEqual(["sig-3"]);
    expect(state.latest.get("sig-3")?.actor).toBe("bob");
  });
});
