/**
 * `getAccountInfoOwner` responses → the six fields that place a node in the organisation.
 *
 * The hierarchy tree carries only `{ l, p, t }`, so it cannot say which office or store an agent
 * belongs to. The account-info response can: `Office`, `Store`, `AgentType`, `AgentID`, `SKIN`, and
 * `AgentMenuStyle`. Grouping nodes by (Office, Store) is what would let the tree show
 * `NOLAROSE → PPHINSIDER → master → …` instead of starting at a login.
 *
 * Two field facts drive the parse, both observed on 2026-11-02:
 *  - `Login` is padded to CHAR(10) and `customerID` is not; the join key is the trimmed login.
 *  - `AgentID` is `null` on a master account (`AgentType: "M"`), so it cannot be the identity.
 */

export interface AccountInfo {
  /** Trimmed, upper-cased login (falling back to customerID) — the tree's key. */
  readonly key: string;
  /** Trimmed `Login` as reported; not padded. */
  readonly login: string;
  readonly customerId: string;
  /** `null` when the account reports none — a master account does. */
  readonly agentId: string | null;
  /** Raw `AgentType`: `M`, `A`, … */
  readonly agentType: string;
  readonly office: string;
  readonly store: string;
  /** The skin the session loaded (`SKIN`), when present. */
  readonly skin: string | null;
  readonly defaultSiteSkin: string;
  /** `Tile Menu` is the value that selects the deferred hierarchy load. */
  readonly agentMenuStyle: string;
  /** `Y`/`N`: whether *this* account may bet live. It governs the account, not its downline. */
  readonly denyLiveBetting: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

function optional(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === "" ? null : trimmed;
}

/**
 * Parses one response. Accepts the bare `{ accountInfo: {...} }` envelope or the inner object, and
 * keeps going when fields are missing: an enrichment pass should record what it can and report the
 * rest, not abort a 2,000-node walk on one odd row.
 */
export function parseAccountInfo(raw: unknown): AccountInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("account-info response must be an object");
  }
  const envelope = raw as Record<string, unknown>;
  const inner =
    typeof envelope["accountInfo"] === "object" &&
    envelope["accountInfo"] !== null
      ? (envelope["accountInfo"] as Record<string, unknown>)
      : envelope;

  const login = text(inner["Login"]);
  const customerId = text(inner["customerID"]);
  const key = (login || customerId).toUpperCase();
  if (key === "") {
    throw new Error("account-info response has neither Login nor customerID");
  }

  return {
    key,
    login,
    customerId,
    agentId: optional(inner["AgentID"]),
    agentType: text(inner["AgentType"]),
    office: text(inner["Office"]),
    store: text(inner["Store"]),
    skin: optional(envelope["SKIN"] ?? inner["SKIN"]),
    defaultSiteSkin: text(inner["DefaultSiteSkin"]),
    agentMenuStyle: text(inner["AgentMenuStyle"]),
    denyLiveBetting: text(inner["DenyLiveBetting"]).toUpperCase(),
  };
}

export interface AccountInfoGroup {
  readonly office: string;
  readonly store: string;
  readonly nodes: number;
  /** Logins with no parent in the tree — the candidate "sibling roots" of the office. */
  readonly roots: readonly string[];
}

/** Groups enriched nodes by (Office, Store); empty fields are reported, not dropped. */
export function groupByOfficeStore(
  rows: readonly {
    readonly login: string;
    readonly office: string | null;
    readonly store: string | null;
    readonly isRoot: boolean;
  }[],
): readonly AccountInfoGroup[] {
  const groups = new Map<
    string,
    { office: string; store: string; nodes: number; roots: string[] }
  >();
  for (const row of rows) {
    const office = (row.office ?? "").trim();
    const store = (row.store ?? "").trim();
    const key = `${office}\u0000${store}`;
    const group = groups.get(key) ?? { office, store, nodes: 0, roots: [] };
    group.nodes += 1;
    if (row.isRoot) group.roots.push(row.login);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, roots: [...group.roots].sort() }))
    .sort(
      (a, b) =>
        a.office.localeCompare(b.office) || a.store.localeCompare(b.store),
    );
}
