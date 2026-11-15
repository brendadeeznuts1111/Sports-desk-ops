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
  readonly WagerLimit?: number;
  readonly CurrentBalance?: number;
  readonly Active?: string;
  readonly ReadOnlyFlag?: string;
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
  readonly customerAdmin?: readonly {
    readonly CustomerID: string;
    readonly CreditLimit?: number;
    readonly WagerLimit?: number;
    readonly CurrentBalance?: number;
    readonly Active?: string;
    readonly ReadOnlyFlag?: string;
    readonly Password?: string;
  }[];
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
  readonly pending?: readonly Record<string, unknown>[];
  readonly ticker?: readonly Record<string, unknown>[];
  readonly graded?: Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  readonly figureDate?: Readonly<
    Record<string, Readonly<Record<string, readonly Record<string, unknown>[]>>>
  >;
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
    if (snap.customerAdmin !== undefined) {
      writeJson(
        join(root, "snapshots", snap.id, "census", "getCustomerAdmin.json"),
        { LIST: snap.customerAdmin },
      );
    }
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
  if (spec.pending !== undefined) {
    writeJson(join(root, "wagers", "pending.json"), { LIST: spec.pending });
  }
  if (spec.ticker !== undefined) {
    writeJson(join(root, "wagers", "ticker.json"), { LIST: spec.ticker });
  }
  for (const [day, rows] of Object.entries(spec.graded ?? {})) {
    writeJson(join(root, "wagers", "graded", `${day}.json`), { LIST: rows });
  }
  for (const [customerId, days] of Object.entries(spec.figureDate ?? {})) {
    for (const [day, rows] of Object.entries(days)) {
      writeJson(
        join(root, "wagers", "figure-date", customerId, `${day}.json`),
        { LIST: { INFO: rows } },
      );
    }
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

function steamLeg(
  customerID: string,
  ticket: number,
  when: string,
  orig: number,
  adj: number,
): Record<string, unknown> {
  return {
    TicketNumber: ticket,
    WagerNumber: ticket,
    CustomerID: customerID,
    AcceptedDateTime: when,
    AmountWagered: 10000,
    ToWinAmount: 9100,
    WagerType: "S",
    SportType: "Basketball",
    PeriodDescription: "Game",
    Team1ID: "LAL",
    Team2ID: "BOS",
    ChosenTeamID: "LAL",
    OrigSpread: orig,
    AdjSpread: adj,
    Description: "LAL -3.5",
  };
}

function parlayLeg(
  customerID: string,
  ticket: number,
  play: number,
  when: string,
  sport: string,
  team1: string,
  team2: string,
  line: number,
): Record<string, unknown> {
  return {
    TicketNumber: ticket,
    WagerNumber: ticket * 10 + play,
    PlayNumber: play,
    CustomerID: customerID,
    AcceptedDateTime: when,
    AmountWagered: play === 1 ? 20000 : 0,
    ToWinAmount: play === 1 ? 60000 : 0,
    WagerType: "P",
    SportType: sport,
    PeriodDescription: "Game",
    Team1ID: team1,
    Team2ID: team2,
    ChosenTeamID: team1,
    AdjSpread: line,
    OrigSpread: line,
    Description: `${team1} ${line}`,
  };
}

/** Planted steam ring + shared-parlay ring, plus decoys that must not link. */
export function plantedBehaviourPull(): SynthPullSpec {
  const players = [
    { customerID: "STEAM1", Login: "steam1", Agent: "SUB1" },
    { customerID: "STEAM2", Login: "steam2", Agent: "SUB1" },
    { customerID: "STEAM3", Login: "steam3", Agent: "SUB1" },
    { customerID: "SOLO", Login: "solo", Agent: "SUB2" },
    { customerID: "PAR1", Login: "par1", Agent: "SUB3" },
    { customerID: "PAR2", Login: "par2", Agent: "SUB3" },
    { customerID: "PAR3", Login: "par3", Agent: "SUB3" },
    { customerID: "JOIN1", Login: "join1", Agent: "SUB4" },
  ];
  const steam = [
    steamLeg("STEAM1", 7001, "2026-11-01 15:00:00", -3, -3.5),
    steamLeg("STEAM2", 7002, "2026-11-01 15:01:30", -3, -3.5),
    steamLeg("STEAM3", 7003, "2026-11-01 15:02:00", -3, -3.5),
    steamLeg("SOLO", 7099, "2026-11-01 18:00:00", -3, -3.5),
  ];
  const parlays = [
    parlayLeg(
      "PAR1",
      8001,
      1,
      "2026-11-01 16:00:00",
      "Soccer",
      "MEX",
      "USA",
      -0.5,
    ),
    parlayLeg(
      "PAR1",
      8001,
      2,
      "2026-11-01 16:00:00",
      "Basketball",
      "CHI",
      "NYK",
      -4,
    ),
    parlayLeg(
      "PAR1",
      8001,
      3,
      "2026-11-01 16:00:00",
      "Football",
      "KC",
      "BUF",
      -2.5,
    ),
    parlayLeg(
      "PAR2",
      8002,
      1,
      "2026-11-01 16:08:00",
      "Soccer",
      "MEX",
      "USA",
      -0.5,
    ),
    parlayLeg(
      "PAR2",
      8002,
      2,
      "2026-11-01 16:08:00",
      "Basketball",
      "CHI",
      "NYK",
      -4,
    ),
    parlayLeg(
      "PAR2",
      8002,
      3,
      "2026-11-01 16:08:00",
      "Football",
      "KC",
      "BUF",
      -2.5,
    ),
    parlayLeg(
      "PAR3",
      8003,
      1,
      "2026-11-01 16:10:00",
      "Tennis",
      "AUS",
      "ESP",
      -1.5,
    ),
    parlayLeg(
      "PAR3",
      8003,
      2,
      "2026-11-01 16:10:00",
      "Hockey",
      "TOR",
      "MTL",
      -1.5,
    ),
    parlayLeg(
      "PAR3",
      8003,
      3,
      "2026-11-01 16:10:00",
      "Baseball",
      "NYY",
      "BOS",
      -1.5,
    ),
  ];
  const joinWager = {
    TicketNumber: 5001,
    WagerNumber: 5001,
    CustomerID: "JOIN1",
    AcceptedDateTime: "2026-11-01 12:00:00",
    AmountWagered: 5000,
    ToWinAmount: 4500,
    WagerType: "S",
    SportType: "Basketball",
    PeriodDescription: "Game",
    Team1ID: "MIA",
    Team2ID: "ORL",
    ChosenTeamID: "MIA",
    AdjSpread: -2,
    GradeNum: 42,
    DocumentNumber: 4242,
    Description: "MIA -2",
  };
  return {
    snapshots: [{ id: "2026-11-01", players }],
    ledger: {
      JOIN1: [
        {
          DocumentNumber: 4242,
          TranCode: "D",
          TranType: "A",
          Amount: 5000,
          Balance: 15000,
          Description: "Wager ticket 5001-1",
          TranDateTime: "2026-11-01 12:00:00",
          EnteredBy: "system",
        },
      ],
      STEAM1: [],
      STEAM2: [],
      STEAM3: [],
      SOLO: [],
      PAR1: [],
      PAR2: [],
      PAR3: [],
    },
    weblog: {
      "2026-11-01": [
        {
          AccessDateTime: "2026-11-01 12:00:05",
          IPAddress: "203.0.113.80",
          LoginID: "join1",
          Operation: "API LOG | Ticket: 5001 Risk:50 Win:45",
          Data: "",
        },
        {
          AccessDateTime: "2026-11-01 15:00:02",
          IPAddress: "203.0.113.81",
          LoginID: "steam1",
          Operation: "API LOG | Ticket: 7001 Risk:100 Win:91",
          Data: "",
        },
      ],
    },
    graded: { "2026-11-01": [...steam, ...parlays, joinWager] },
    figureDate: {
      JOIN1: { "2026-11-01": [joinWager] },
    },
  };
}

/** Timeline, CLV, middling, and login-latency rings plus decoys. */
export function plantedEnhancePull(): SynthPullSpec {
  const t1 = "2026-11-08T14:00:00.000Z";
  const t1b = "2026-11-08T14:00:20.000Z";
  const t2 = "2026-11-08T15:00:00.000Z";
  const t2b = "2026-11-08T15:00:22.000Z";
  const t3 = "2026-11-08T16:00:00.000Z";
  const t3b = "2026-11-08T16:00:18.000Z";
  const mid = "2026-11-08T17:00:00.000Z";
  const mid2 = "2026-11-08T17:04:00.000Z";
  const clvA = "2026-11-08T18:00:00.000Z";
  const clvB = "2026-11-08T19:00:00.000Z";
  const late = "2026-11-08T14:10:00.000Z";

  const earlyPlayers = [
    {
      customerID: "MOVE1",
      Login: "move1",
      NameFirst: "M",
      Agent: "SUB1",
      CreditLimit: 50,
      WagerLimit: 10,
      CurrentBalance: 40,
      Active: "Y",
    },
    { customerID: "CLV1", Login: "clv1", NameFirst: "C1", Agent: "SUB1" },
    { customerID: "CLV2", Login: "clv2", NameFirst: "C2", Agent: "SUB1" },
    { customerID: "CLV3", Login: "clv3", NameFirst: "C3", Agent: "SUB2" },
    { customerID: "MID1", Login: "mid1", NameFirst: "M1", Agent: "SUB1" },
    { customerID: "MID2", Login: "mid2", NameFirst: "M2", Agent: "SUB2" },
    { customerID: "LAT1", Login: "lat1", NameFirst: "L1", Agent: "SUB1" },
    { customerID: "LAT2", Login: "lat2", NameFirst: "L2", Agent: "SUB1" },
    { customerID: "LAT3", Login: "lat3", NameFirst: "L3", Agent: "SUB3" },
  ];
  const laterPlayers = earlyPlayers.map((p) =>
    p.customerID === "MOVE1"
      ? {
          ...p,
          Agent: "SUB2",
          CreditLimit: 20,
          WagerLimit: 5,
          CurrentBalance: 5,
          Active: "N",
        }
      : p,
  );

  const clvWager = (
    customer: string,
    ticket: string,
    event: { team1: string; team2: string },
    when: string,
    orig: number,
    adj: number,
  ) => ({
    CustomerID: customer,
    TicketNumber: ticket,
    AmountWagered: 11000,
    AcceptedDateTime: when,
    SportType: "NBA",
    WagerType: "S",
    Team1ID: event.team1,
    Team2ID: event.team2,
    ChosenTeamID: event.team1,
    PeriodDescription: "Game",
    OrigSpread: orig,
    AdjSpread: adj,
  });

  const ev1 = { team1: "BOS", team2: "NYK" };
  const ev2 = { team1: "MIA", team2: "CHI" };
  const ev3 = { team1: "DAL", team2: "PHX" };

  return {
    snapshots: [
      { id: "2026-11-01", players: earlyPlayers },
      { id: "2026-11-08", players: laterPlayers },
    ],
    ledger: {
      MOVE1: [
        {
          DocumentNumber: 1,
          TranCode: "C",
          TranType: "A",
          Amount: 1000,
          Balance: 4000,
          Description: "open",
          TranDateTime: "2026-11-01T12:00:00.000Z",
        },
      ],
    },
    weblog: {
      "2026-11-08": [
        {
          AccessDateTime: t1,
          IPAddress: "198.51.100.10",
          LoginID: "lat1",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t2,
          IPAddress: "198.51.100.10",
          LoginID: "lat1",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t3,
          IPAddress: "198.51.100.10",
          LoginID: "lat1",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t1,
          IPAddress: "198.51.100.11",
          LoginID: "lat2",
          Operation: "Login successful Token",
        },
        {
          AccessDateTime: t2,
          IPAddress: "198.51.100.11",
          LoginID: "lat2",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t3,
          IPAddress: "198.51.100.11",
          LoginID: "lat2",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t1,
          IPAddress: "198.51.100.12",
          LoginID: "lat3",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t2,
          IPAddress: "198.51.100.12",
          LoginID: "lat3",
          Operation: "Login successful",
        },
        {
          AccessDateTime: t3,
          IPAddress: "198.51.100.12",
          LoginID: "lat3",
          Operation: "Login successful",
        },
      ],
    },
    graded: {
      "2026-11-08": [
        clvWager("CLV1", "9001", ev1, clvA, -3, -3.5),
        clvWager("CLV1", "9002", ev2, clvB, -2.5, -3),
        clvWager("CLV2", "9003", ev1, clvA, -3, -3.5),
        clvWager("CLV2", "9004", ev2, clvB, -2.5, -3),
        clvWager("CLV3", "9005", ev3, clvA, -3, -3),
        {
          CustomerID: "MID1",
          TicketNumber: "9101",
          AmountWagered: 15000,
          AcceptedDateTime: mid,
          SportType: "NBA",
          WagerType: "S",
          Team1ID: "LAL",
          Team2ID: "GSW",
          ChosenTeamID: "GSW",
          PeriodDescription: "Game",
          OrigSpread: 3,
          AdjSpread: 3,
        },
        {
          CustomerID: "MID2",
          TicketNumber: "9102",
          AmountWagered: 15000,
          AcceptedDateTime: mid2,
          SportType: "NBA",
          WagerType: "S",
          Team1ID: "LAL",
          Team2ID: "GSW",
          ChosenTeamID: "LAL",
          PeriodDescription: "Game",
          OrigSpread: -2.5,
          AdjSpread: -2.5,
        },
        {
          CustomerID: "LAT1",
          TicketNumber: "9201",
          AmountWagered: 5000,
          AcceptedDateTime: t1b,
          SportType: "NBA",
          Team1ID: "ORL",
          Team2ID: "ATL",
          ChosenTeamID: "ORL",
          PeriodDescription: "Game",
          OrigSpread: -1,
          AdjSpread: -1,
        },
        {
          CustomerID: "LAT1",
          TicketNumber: "9202",
          AmountWagered: 5000,
          AcceptedDateTime: t2b,
          SportType: "NBA",
          Team1ID: "ORL",
          Team2ID: "ATL",
          ChosenTeamID: "ORL",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT1",
          TicketNumber: "9203",
          AmountWagered: 5000,
          AcceptedDateTime: t3b,
          SportType: "NBA",
          Team1ID: "ORL",
          Team2ID: "ATL",
          ChosenTeamID: "ORL",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT2",
          TicketNumber: "9204",
          AmountWagered: 5000,
          AcceptedDateTime: t1b,
          SportType: "NBA",
          Team1ID: "SAC",
          Team2ID: "POR",
          ChosenTeamID: "SAC",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT2",
          TicketNumber: "9205",
          AmountWagered: 5000,
          AcceptedDateTime: t2b,
          SportType: "NBA",
          Team1ID: "SAC",
          Team2ID: "POR",
          ChosenTeamID: "SAC",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT2",
          TicketNumber: "9206",
          AmountWagered: 5000,
          AcceptedDateTime: t3b,
          SportType: "NBA",
          Team1ID: "SAC",
          Team2ID: "POR",
          ChosenTeamID: "SAC",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT3",
          TicketNumber: "9207",
          AmountWagered: 25,
          AcceptedDateTime: late,
          SportType: "NBA",
          Team1ID: "MIN",
          Team2ID: "OKC",
          ChosenTeamID: "MIN",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT3",
          TicketNumber: "9208",
          AmountWagered: 25,
          AcceptedDateTime: "2026-11-08T15:10:00.000Z",
          SportType: "NBA",
          Team1ID: "MIN",
          Team2ID: "OKC",
          ChosenTeamID: "MIN",
          PeriodDescription: "Game",
        },
        {
          CustomerID: "LAT3",
          TicketNumber: "9209",
          AmountWagered: 25,
          AcceptedDateTime: "2026-11-08T16:10:00.000Z",
          SportType: "NBA",
          Team1ID: "MIN",
          Team2ID: "OKC",
          ChosenTeamID: "MIN",
          PeriodDescription: "Game",
        },
      ],
    },
  };
}
