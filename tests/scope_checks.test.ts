import { describe, expect, test } from "bun:test";
import type { AccountInfo } from "../lib/account_info.ts";
import {
  anchorFromAccountInfo,
  checkAgentScope,
  checkCustomerLiveFlag,
  checkRootWager,
  isInScope,
  isSecondRoot,
} from "../lib/scope_checks.ts";

/**
 * The account-info response is the scope anchor. `Office` + `Store` say which part of the
 * organisation an account belongs to, and the findings are *annotated*, never filtered — a
 * cross-office row in the ticker is the finding, so dropping it destroys the evidence.
 */

const anchorInfo: AccountInfo = {
  key: "BILLY666",
  login: "BILLY666",
  customerId: "BILLY666",
  agentId: null,
  agentType: "M",
  office: "NOLAROSE",
  store: "PPHINSIDER",
  skin: "M",
  defaultSiteSkin: "RiseOfSnake",
  agentMenuStyle: "Tile Menu",
  denyLiveBetting: "Y",
};

const anchor = anchorFromAccountInfo(anchorInfo);
const agent = (over: Partial<AccountInfo> = {}): AccountInfo => ({
  ...anchorInfo,
  key: "CAKEJAKE",
  login: "CAKEJAKE",
  customerId: "CAKEJAKE",
  agentId: "BILLY666",
  agentType: "A",
  denyLiveBetting: "N",
  ...over,
});

describe("anchorFromAccountInfo", () => {
  test("uses customerID, which is the unpadded copy", () => {
    expect(anchor).toEqual({
      office: "NOLAROSE",
      store: "PPHINSIDER",
      rootId: "BILLY666",
    });
  });
});

describe("scope", () => {
  test("office and store must both match", () => {
    expect(isInScope(agent(), anchor)).toBe(true);
    expect(isInScope(agent({ store: "GSLIVE" }), anchor)).toBe(false);
    expect(isInScope(agent({ office: "NOLAROB" }), anchor)).toBe(false);
  });

  test("a null AgentID on another account is a second root, not a child", () => {
    const other = agent({ customerId: "NOLAWOLF", agentId: null });
    expect(isSecondRoot(other, anchor)).toBe(true);
    const findings = checkAgentScope("NOLAWOLF", other, anchor);
    expect(findings.map((finding) => finding.kind)).toContain("second-root");
  });

  test("the anchor itself is not a second root", () => {
    expect(isSecondRoot(anchorInfo, anchor)).toBe(false);
  });

  test("an in-scope agent produces no findings", () => {
    expect(checkAgentScope("CAKEJAKE", agent(), anchor)).toEqual([]);
  });

  test("out-of-scope and second-root can both fire, and neither drops the row", () => {
    const stray = agent({
      customerId: "KOBE8",
      agentId: null,
      office: "NOLAROB",
      store: "GSLIVE",
    });
    const findings = checkAgentScope("KOBE8", stray, anchor);
    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      "out-of-scope",
      "second-root",
    ]);
    expect(findings[0]?.detail).toContain("expected NOLAROSE/PPHINSIDER");
  });
});

describe("wagers", () => {
  test("a wager filed under the root account is flagged", () => {
    expect(
      checkRootWager({ wagerNumber: 767174209, agentId: "BILLY666" }, anchor),
    ).toHaveLength(1);
    expect(
      checkRootWager({ wagerNumber: 1, agentId: "CAKEJAKE" }, anchor),
    ).toEqual([]);
    // Case and padding must not hide it.
    expect(
      checkRootWager({ wagerNumber: 2, agentId: " billy666 " }, anchor),
    ).toHaveLength(1);
  });

  test("the live flag is checked against the customer's account, not the agent's", () => {
    const wager = { wagerNumber: 3, wagerType: "L" };
    // The agent denies live betting; that says nothing about the player who placed the wager.
    expect(
      checkCustomerLiveFlag(wager, agent({ denyLiveBetting: "Y" })),
    ).toHaveLength(1);
    // No customer account info means no finding — not a guess.
    expect(checkCustomerLiveFlag(wager, undefined)).toEqual([]);
    // A customer who may bet live produces no finding.
    expect(checkCustomerLiveFlag(wager, { denyLiveBetting: "N" })).toEqual([]);
    // And a non-L wager is out of scope for this check entirely.
    expect(
      checkCustomerLiveFlag(
        { wagerNumber: 4, wagerType: "S" },
        { denyLiveBetting: "Y" },
      ),
    ).toEqual([]);
  });
});
