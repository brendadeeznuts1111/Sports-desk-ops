/** Synthetic Fantasy402 puller trees for analyze tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SynthPlayer {
  readonly customerID: string;
  readonly Login: string;
  readonly NameFirst?: string;
  readonly Agent: string;
  readonly Password?: string;
  readonly CreditLimit?: number;
}

export interface SynthLedgerRow {
  readonly DocumentNumber: number;
  readonly TranCode: string;
  readonly TranType: string;
  readonly Amount: number;
  readonly Balance: number;
  readonly Description: string;
  readonly TranDateTime: string;
  readonly EnteredBy?: string;
}

export interface SynthWeblogRow {
  readonly AccessDateTime: string;
  readonly IPAddress: string;
  readonly LoginID: string;
  readonly Operation: string;
  readonly Data?: string;
}

export interface SynthSnapshot {
  readonly id: string;
  readonly players: readonly SynthPlayer[];
}

export interface SynthPullSpec {
  readonly snapshots: readonly SynthSnapshot[];
  readonly hierarchy?: readonly {
    readonly AgentId: string;
    readonly MasterAgentID?: string;
    readonly Level?: number;
    readonly AgentType?: string;
    readonly Login?: string;
  }[];
  readonly ledger: Readonly<Record<string, readonly SynthLedgerRow[]>>;
  readonly deleted?: Readonly<Record<string, readonly SynthLedgerRow[]>>;
  readonly weblog: Readonly<Record<string, readonly SynthWeblogRow[]>>;
  readonly customerAdmin?: readonly {
    readonly CustomerID: string;
    readonly CreditLimit: number;
    readonly CurrentBalance?: number;
    readonly Password?: string;
  }[];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeSyntheticPull(root: string, spec: SynthPullSpec): string {
  const current = spec.snapshots[spec.snapshots.length - 1];
  if (current === undefined) {
    throw new Error("synthetic pull needs at least one census snapshot");
  }
  const hierarchy = spec.hierarchy ?? [
    {
      AgentId: "ROOT",
      MasterAgentID: "",
      Level: 0,
      AgentType: "M",
      Login: "ROOT",
    },
  ];
  writeJson(join(root, "census", "getHeriarchy.json"), { LIST: hierarchy });
  writeJson(join(root, "census", "getListAgenstByAgent.json"), {
    GENERAL: [],
    PLAYERS: current.players,
  });
  for (const snap of spec.snapshots) {
    writeJson(
      join(root, "snapshots", snap.id, "census", "getListAgenstByAgent.json"),
      {
        GENERAL: [],
        PLAYERS: snap.players,
      },
    );
  }
  if (spec.customerAdmin !== undefined) {
    writeJson(join(root, "census", "getCustomerAdmin.json"), {
      LIST: spec.customerAdmin,
    });
  }
  for (const [accountId, rows] of Object.entries(spec.ledger)) {
    writeJson(join(root, "transactions", `${accountId}.json`), {
      LIST: rows,
      SL: "OK",
    });
  }
  for (const [accountId, rows] of Object.entries(spec.deleted ?? {})) {
    writeJson(join(root, "transactions", `${accountId}.deleted.json`), {
      LIST: rows.map((row) => ({ ...row, CustomerID: accountId })),
    });
  }
  for (const [day, rows] of Object.entries(spec.weblog)) {
    writeJson(join(root, "weblog", `${day}.json`), { LIST: rows });
  }
  return root;
}

/** Planted ALICE/BOB cluster plus decoys that must not link. */
export function plantedClusterPull(): SynthPullSpec {
  const early = "2026-11-01";
  const late = "2026-11-08";
  const playersEarly = [
    {
      customerID: "ALICE",
      Login: "alice",
      NameFirst: "A",
      Agent: "SUB1",
      Password: "secret-alice",
    },
    {
      customerID: "BOB",
      Login: "bob",
      NameFirst: "B",
      Agent: "SUB1",
      Password: "secret-bob",
    },
    { customerID: "CAROL", Login: "carol", NameFirst: "C", Agent: "SUB1" },
    { customerID: "DAVE", Login: "dave", NameFirst: "D", Agent: "SUB2" },
    { customerID: "ERIN", Login: "erin", NameFirst: "E", Agent: "SUB2" },
    { customerID: "FAY", Login: "fay", NameFirst: "F", Agent: "SUB2" },
    { customerID: "GUS", Login: "gus", NameFirst: "G", Agent: "SUB3" },
    { customerID: "HENRY", Login: "henry", NameFirst: "H", Agent: "SUB3" },
  ];
  const playersLate = playersEarly.map((row) =>
    row.customerID === "ALICE" ? { ...row, Agent: "SUB2" } : row,
  );
  return {
    snapshots: [
      { id: early, players: playersEarly },
      { id: late, players: playersLate },
    ],
    customerAdmin: [
      {
        CustomerID: "ALICE",
        CreditLimit: 100000,
        CurrentBalance: 20000,
        Password: "nope",
      },
      { CustomerID: "BOB", CreditLimit: 100000, CurrentBalance: 90000 },
    ],
    ledger: {
      ALICE: [
        {
          DocumentNumber: 1,
          TranCode: "C",
          TranType: "E",
          Amount: 80000,
          Balance: 80000,
          Description: "Deposit",
          TranDateTime: "2026-10-01 12:00:00",
          EnteredBy: "cashier",
        },
        {
          DocumentNumber: 2,
          TranCode: "D",
          TranType: "A",
          Amount: 5000,
          Balance: 75000,
          Description: "Wager ticket 1001-1",
          TranDateTime: "2026-10-02 12:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 3,
          TranCode: "D",
          TranType: "L",
          Amount: 5000,
          Balance: 70000,
          Description: "Lost ticket 1001-1",
          TranDateTime: "2026-10-02 18:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 4,
          TranCode: "C",
          TranType: "E",
          Amount: 20000,
          Balance: 90000,
          Description: "Deposit",
          TranDateTime: "2026-10-08 12:00:00",
          EnteredBy: "cashier",
        },
        {
          DocumentNumber: 5,
          TranCode: "D",
          TranType: "A",
          Amount: 8000,
          Balance: 82000,
          Description: "Wager ticket 1002-1",
          TranDateTime: "2026-10-09 12:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 6,
          TranCode: "D",
          TranType: "L",
          Amount: 8000,
          Balance: 74000,
          Description: "Lost ticket 1002-1",
          TranDateTime: "2026-10-09 18:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 7,
          TranCode: "C",
          TranType: "E",
          Amount: 20000,
          Balance: 94000,
          Description: "Deposit",
          TranDateTime: "2026-10-15 12:00:00",
          EnteredBy: "cashier",
        },
        {
          DocumentNumber: 8,
          TranCode: "D",
          TranType: "U",
          Amount: 15000,
          Balance: 20000,
          Description: "Transfer out",
          TranDateTime: "2026-11-01 15:00:00",
          EnteredBy: "clerk-rare",
        },
        {
          DocumentNumber: 9,
          TranCode: "D",
          TranType: "D",
          Amount: 1000,
          Balance: 19000,
          Description: "Adjustment",
          TranDateTime: "2026-11-01 16:00:00",
          EnteredBy: "system",
        },
      ],
      BOB: [
        {
          DocumentNumber: 11,
          TranCode: "C",
          TranType: "E",
          Amount: 50000,
          Balance: 50000,
          Description: "Deposit",
          TranDateTime: "2026-10-20 12:00:00",
          EnteredBy: "cashier",
        },
        {
          DocumentNumber: 12,
          TranCode: "C",
          TranType: "T",
          Amount: 15000,
          Balance: 65000,
          Description: "Transfer in",
          TranDateTime: "2026-11-01 15:02:00",
          EnteredBy: "clerk-rare",
        },
        {
          DocumentNumber: 13,
          TranCode: "D",
          TranType: "A",
          Amount: 2000,
          Balance: 63000,
          Description: "Wager ticket 2001-1",
          TranDateTime: "2026-11-13 12:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 14,
          TranCode: "C",
          TranType: "W",
          Amount: 1800,
          Balance: 64800,
          Description: "Won ticket 2001-1",
          TranDateTime: "2026-11-13 18:00:00",
          EnteredBy: "system",
        },
        {
          DocumentNumber: 15,
          TranCode: "C",
          TranType: "C",
          Amount: 500,
          Balance: 65300,
          Description: "Adjustment",
          TranDateTime: "2026-11-13 18:30:00",
          EnteredBy: "system",
        },
      ],
      CAROL: [
        {
          DocumentNumber: 21,
          TranCode: "C",
          TranType: "E",
          Amount: 10000,
          Balance: 10000,
          Description: "Deposit",
          TranDateTime: "2026-10-01 12:00:00",
          EnteredBy: "cashier",
        },
        {
          DocumentNumber: 22,
          TranCode: "D",
          TranType: "A",
          Amount: 1000,
          Balance: 9000,
          Description: "Placed",
          TranDateTime: "2026-10-10 12:00:00",
          EnteredBy: "system",
        },
      ],
      DAVE: [
        {
          DocumentNumber: 31,
          TranCode: "C",
          TranType: "E",
          Amount: 10000,
          Balance: 10000,
          Description: "Deposit",
          TranDateTime: "2026-10-03 12:00:00",
          EnteredBy: "cashier",
        },
      ],
      ERIN: [
        {
          DocumentNumber: 41,
          TranCode: "C",
          TranType: "E",
          Amount: 10000,
          Balance: 10000,
          Description: "Deposit",
          TranDateTime: "2026-10-05 12:00:00",
          EnteredBy: "cashier",
        },
      ],
      FAY: [
        {
          DocumentNumber: 51,
          TranCode: "C",
          TranType: "E",
          Amount: 10000,
          Balance: 10000,
          Description: "Deposit",
          TranDateTime: "2026-10-07 12:00:00",
          EnteredBy: "cashier",
        },
      ],
      GUS: [
        {
          DocumentNumber: 61,
          TranCode: "C",
          TranType: "E",
          Amount: 15000,
          Balance: 15000,
          Description: "Deposit",
          TranDateTime: "2026-11-11 15:00:00",
          EnteredBy: "cashier",
        },
      ],
      HENRY: [
        {
          DocumentNumber: 71,
          TranCode: "C",
          TranType: "C",
          Amount: 2000,
          Balance: 2000,
          Description: "Adjustment",
          TranDateTime: "2026-11-02 12:00:00",
          EnteredBy: "system",
        },
      ],
    },
    weblog: {
      "2026-11-01": [
        {
          AccessDateTime: "2026-11-01 14:50:00",
          IPAddress: "203.0.113.10",
          LoginID: "alice",
          Operation: "Login successful Token",
          Data: "",
        },
        {
          AccessDateTime: "2026-11-01 14:55:00",
          IPAddress: "203.0.113.10",
          LoginID: "alice",
          Operation: "API LOG | Ticket: 1002 Risk:80 Win:0",
          Data: "wager accepted by: alice",
        },
        {
          AccessDateTime: "2026-11-01 15:01:00",
          IPAddress: "203.0.113.10",
          LoginID: "bob",
          Operation: "Login successful",
          Data: "",
        },
        {
          AccessDateTime: "2026-11-01 15:03:00",
          IPAddress: "203.0.113.10",
          LoginID: "bob",
          Operation: "(M) View Pending (M) [ v1.2.3 | sports.example ]",
          Data: "",
        },
        {
          AccessDateTime: "2026-11-01 10:00:00",
          IPAddress: "8.8.8.8",
          LoginID: "carol",
          Operation: "Login successful",
          Data: "",
        },
      ],
      "2026-10-10": [
        {
          AccessDateTime: "2026-10-10 10:00:00",
          IPAddress: "8.8.8.8",
          LoginID: "dave",
          Operation: "Login successful",
          Data: "",
        },
      ],
      "2026-10-20": [
        {
          AccessDateTime: "2026-10-20 10:00:00",
          IPAddress: "8.8.8.8",
          LoginID: "erin",
          Operation: "Login successful",
          Data: "",
        },
      ],
      "2026-10-28": [
        {
          AccessDateTime: "2026-10-28 10:00:00",
          IPAddress: "8.8.8.8",
          LoginID: "fay",
          Operation: "Login successful",
          Data: "",
        },
      ],
      "2026-11-11": [
        {
          AccessDateTime: "2026-11-11 16:00:00",
          IPAddress: "198.51.100.9",
          LoginID: "gus",
          Operation: "Login successful",
          Data: "",
        },
      ],
    },
  };
}
