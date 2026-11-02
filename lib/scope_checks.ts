/**
 * Scope and policy checks over enriched wagers.
 *
 * The account-info response is the scope anchor: an account's `Office` and `Store` say which part
 * of the organisation it belongs to, and `customerID` — not `Login`, which is padded — names it.
 * The checks here are pure, so the enrichment pass can annotate rows without dropping them: an
 * out-of-scope row in the ticker is a *finding*, and a filter that hides it destroys the finding.
 *
 * One category error is deliberately excluded. `DenyLiveBetting` governs the account it is set on,
 * so comparing a wager's `WagerType` against the *agent's* flag says nothing about the player who
 * placed it. `checkCustomerLiveFlag` therefore takes the *customer's* account info; when the caller
 * only enriched agents, it returns nothing rather than a false finding.
 */

import type { AccountInfo } from "./account_info.ts";

export interface ScopeAnchor {
  readonly office: string;
  readonly store: string;
  /** The account whose subtree this session sees — `customerID`, trimmed. */
  readonly rootId: string;
}

export type ScopeKind =
  "out-of-scope" | "second-root" | "root-wager" | "live-flag-inert";

export interface ScopeFinding {
  readonly kind: ScopeKind;
  /** The wager number or agent login the finding is about. */
  readonly subject: string;
  readonly detail: string;
}

export function anchorFromAccountInfo(info: AccountInfo): ScopeAnchor {
  return {
    office: info.office,
    store: info.store,
    rootId: info.customerId,
  };
}

/** Office **and** store must match; either alone groups accounts that are not the same business. */
export function isInScope(
  account: Pick<AccountInfo, "office" | "store">,
  anchor: ScopeAnchor,
): boolean {
  return account.office === anchor.office && account.store === anchor.store;
}

/**
 * An account whose `AgentID` is null is the root of its own subtree. Seeing one that is not the
 * anchor means the session is reading a different root's rows — a cross-subtree read, not a
 * child record.
 */
export function isSecondRoot(
  account: Pick<AccountInfo, "agentId" | "customerId">,
  anchor: ScopeAnchor,
): boolean {
  return account.agentId === null && account.customerId !== anchor.rootId;
}

export function checkAgentScope(
  subject: string,
  account: AccountInfo,
  anchor: ScopeAnchor,
): readonly ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  if (!isInScope(account, anchor)) {
    findings.push({
      kind: "out-of-scope",
      subject,
      detail: `${account.customerId} is ${account.office}/${account.store}, expected ${anchor.office}/${anchor.store}`,
    });
  }
  if (isSecondRoot(account, anchor)) {
    findings.push({
      kind: "second-root",
      subject,
      detail: `${account.customerId} has AgentID null and is not ${anchor.rootId} — a different subtree`,
    });
  }
  return findings;
}

/**
 * A wager whose agent is the anchor's own root. The root is an agent account, so a wager filed
 * under it is either mislabelled or placed from a channel the account does not have.
 */
export function checkRootWager(
  wager: { readonly wagerNumber?: unknown; readonly agentId: string },
  anchor: ScopeAnchor,
): readonly ScopeFinding[] {
  if (
    wager.agentId.trim().toUpperCase() !== anchor.rootId.trim().toUpperCase()
  ) {
    return [];
  }
  return [
    {
      kind: "root-wager",
      subject: String(wager.wagerNumber ?? "?"),
      detail: `wager is filed under the root account ${anchor.rootId} itself`,
    },
  ];
}

/**
 * `WagerType: L` on a wager whose **own customer** denies live betting. Pass the customer's
 * account info, not the agent's: the flag is per account.
 *
 * This holds whatever `L` means — if it is live, the flag was overridden; if it is not live, the
 * flag is decorative. Both are worth reporting; neither is decided here.
 */
export function checkCustomerLiveFlag(
  wager: { readonly wagerNumber?: unknown; readonly wagerType: string },
  customerAccount: Pick<AccountInfo, "denyLiveBetting"> | undefined,
): readonly ScopeFinding[] {
  if (customerAccount === undefined) return [];
  if (wager.wagerType.trim().toUpperCase() !== "L") return [];
  if (customerAccount.denyLiveBetting !== "Y") return [];
  return [
    {
      kind: "live-flag-inert",
      subject: String(wager.wagerNumber ?? "?"),
      detail: "wager type L on an account whose DenyLiveBetting is Y",
    },
  ];
}
