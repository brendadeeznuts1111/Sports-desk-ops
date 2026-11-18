import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  F402AnalyzeError,
  combineEvidenceScores,
  hashIp,
  hashIpsDeep,
  ingestPullDirectory,
  ipRarity,
  linkAccounts,
  parseTicketFromText,
  parseWeblogAction,
  parseWeblogTicket,
  predictAccount,
  predictAccounts,
  runLinkAnalysis,
  assertNoRawIp,
  containsUnhashedIp,
  runPredictAnalysis,
  signedAmountCents,
  TRAN_TYPE_SPECS,
} from "../lib/f402_analyze.ts";
import {
  plantedClusterPull,
  writeSyntheticPull,
  type SynthLedgerRow,
} from "./fixtures/f402-analyze/synthetic_pull.ts";
import { main as analyzeMain } from "../scripts/f402_analyze.ts";
import {
  isSharedInfraIp,
  SHARED_INFRA_CLASSES,
} from "../lib/f402_analyze_link.ts";
import { classifyIp } from "../lib/f402_weblog.ts";
import {
  classifyWeblogIpExtended,
  parseWeblogBetLeg,
} from "../lib/f402_weblog_pattern_tracker.ts";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function plantedTree(): string {
  return writeSyntheticPull(tempDir("f402-analyze-"), plantedClusterPull());
}

describe("tran type signing (#55-compatible)", () => {
  test("A is debit, W is credit, L is debit, X follows TranCode", () => {
    expect(signedAmountCents("A", "C", 5000)).toBe(-5000);
    expect(signedAmountCents("W", "D", 1800)).toBe(1800);
    expect(signedAmountCents("L", "C", 5000)).toBe(-5000);
    expect(signedAmountCents("X", "C", 2000)).toBe(2000);
    expect(signedAmountCents("X", "D", 2000)).toBe(-2000);
  });

  test("T is credit and U is debit", () => {
    expect(signedAmountCents("T", "D", 15000)).toBe(15000);
    expect(signedAmountCents("U", "C", 15000)).toBe(-15000);
    expect(TRAN_TYPE_SPECS.E?.family).toBe("deposit");
    expect(TRAN_TYPE_SPECS.I?.family).toBe("withdrawal");
  });
});

describe("ticket parsers", () => {
  test("parses Ticket: and Wager ticket text, Operation or Data", () => {
    expect(parseTicketFromText("Wager ticket 1001-1")).toBe("1001");
    expect(parseTicketFromText("API LOG | Ticket: 1061060064 Risk:300")).toBe(
      "1061060064",
    );
    const action = parseWeblogAction(
      "API LOG | Ticket: 1061060064 Risk:300 Win:345",
    );
    expect(action.kind).toBe("ticket");
    expect(action.ticket).toBe("1061060064");
    expect(action.risk).toBe(300);
    expect(action.win).toBe(345);
    expect(
      parseWeblogTicket(
        "Login successful",
        "API LOG | Ticket: 99 Risk:1 Win:2",
      ),
    ).toBe("99");
  });
});

describe("reuse of #219 weblog helpers", () => {
  test("bet rows take sport, rotation and period from parseWeblogBetLeg", () => {
    const legs = [
      "Hockey #88 Senators/Ducks U 6&#189; +120 - For Game",
      "Hockey #83 Utah Mammoth -1&#189; +145 - For Game",
      "Football #240 Lions -3 -110 - For 2nd Half",
      "Basketball #501 Celtics/Knicks O 220 -110 - For 1st Half",
    ];
    for (const text of legs) {
      const leg = parseWeblogBetLeg(text);
      const action = parseWeblogAction(`API LOG | Bet : ${text}`);
      expect(action.kind).toBe("bet");
      expect(action.sport).toBe(leg.sport);
      expect(action.eventId).toBe(String(leg.rotationNumber));
      expect(action.period).toBe(leg.periodLabel);
    }
  });

  test("outputs that were already right are unchanged", () => {
    const expected: Record<
      string,
      [string | null, string | null, string | null]
    > = {
      "API LOG | Bet : Hockey #83 Utah Mammoth -170 - For Game": [
        "Hockey",
        "83",
        "Game",
      ],
      "API LOG | Bet : Football #240 Lions -3 -110 - For 2nd Half": [
        "Football",
        "240",
        "2nd Half",
      ],
      "API LOG | Bet :\nFootball #243 Cardinals/Cowboys O 26&#189; -115 - For 2nd Half":
        ["Football", "243", "2nd Half"],
      "API LOG | Bet : #123 something": [null, "123", null],
      "CHANGE LINE #455 Lakers -4 - For Game": [null, "455", "Game"],
      "API LOG | Ticket: 1061060064 Risk:300 Win:345": [null, null, null],
      "Login successful": [null, null, null],
    };
    for (const [op, [sport, eventId, period]] of Object.entries(expected)) {
      const action = parseWeblogAction(op);
      expect([action.sport, action.eventId, action.period]).toEqual([
        sport,
        eventId,
        period,
      ]);
    }
  });

  test("intended changes: bought points keep the period, free text is not a sport", () => {
    const bought = parseWeblogAction(
      "API LOG | Bet : Football #263 Eagles 6 -120 - buying &#189; For Game",
    );
    expect(bought.period).toBe("Game");
    expect(bought.eventId).toBe("263");
    const parlay = parseWeblogAction("API LOG | Bet : Parlay 3 legs");
    expect(parlay.kind).toBe("bet");
    expect(parlay.sport).toBeNull();
    expect(parlay.period).toBeNull();
  });

  test("shared-infrastructure check matches the base classifier on every class", () => {
    const ips = [
      "100.64.1.2",
      "172.56.1.2",
      "174.192.1.2",
      "174.208.1.2",
      "146.75.1.2",
      "140.248.1.2",
      "156.146.132.48",
      "107.115.171.78",
      "70.134.7.166",
      "203.0.113.10",
      "2607:fb90::1",
      "2600:1000::1",
      "2600:380::1",
      "2606:54c0::1",
      "2001:db8::1",
      "",
    ];
    for (const ip of ips) {
      expect(isSharedInfraIp(ip)).toBe(
        SHARED_INFRA_CLASSES.has(classifyIp(ip)),
      );
    }
    for (const ip of ["156.146.132.48", "107.115.171.78", "70.134.7.166"]) {
      const extended = classifyWeblogIpExtended(ip);
      expect(extended).not.toBe(classifyIp(ip));
      expect(SHARED_INFRA_CLASSES.has(extended)).toBe(false);
    }
  });
});

describe("ingest projections", () => {
  test("loads accounts, ledger, weblog, strips secrets, keeps IPs in memory, tracks agent moves", () => {
    const root = plantedTree();
    const projection = ingestPullDirectory(root);
    const alice = projection.accounts.find((row) => row.accountId === "ALICE");
    expect(alice?.agentChanged).toBe(true);
    expect(alice?.agentBySnapshot["2026-11-01"]).toBe("SUB1");
    expect(alice?.agentBySnapshot["2026-11-08"]).toBe("SUB2");
    expect(alice?.creditLimitCents).toBe(100000);
    expect(JSON.stringify(projection.accounts)).not.toContain("secret-alice");
    expect(JSON.stringify(projection.ledger)).not.toContain("nope");
    const placed = projection.ledger.find(
      (row) => row.accountId === "ALICE" && row.tranType === "A",
    );
    expect(placed?.signedAmountCents).toBe(-5000);
    expect(placed?.ticket).toBe("1001");
    const ticketRow = projection.weblog.find((row) => row.ticket === "1002");
    expect(ticketRow?.ipAddress).toBe("203.0.113.10");
    expect(ticketRow?.loginId).toBe("alice");
    expect(projection.censusSnapshotCount).toBe(3);
  });

  test("missing input directory is a named error", () => {
    expect(() =>
      ingestPullDirectory(join(tmpdir(), "no-such-f402-pull")),
    ).toThrow(F402AnalyzeError);
  });
});

describe("linker", () => {
  test("finds the planted cluster and does not link decoys", () => {
    const projection = ingestPullDirectory(plantedTree());
    const report = linkAccounts(projection, { hashIp });
    expect(report.disclaimer).toContain("not confirmed identities");
    const planted = report.clusters.find(
      (cluster) =>
        cluster.accounts.includes("ALICE") && cluster.accounts.includes("BOB"),
    );
    expect(planted).toBeDefined();
    expect(planted?.label).toBe("evidence-scored guess");
    const types = new Set(
      planted?.edges.flatMap((edge) => edge.evidence.map((item) => item.type)),
    );
    expect(types.has("shared_ip")).toBe(true);
    expect(types.has("transfer")).toBe(true);
    const decoys = ["CAROL", "DAVE", "ERIN", "FAY", "GUS", "HENRY"];
    for (const cluster of report.clusters) {
      const hits = cluster.accounts.filter((id) => decoys.includes(id));
      expect(hits).toEqual([]);
    }
    for (const edge of report.edges) {
      expect(edge.label).toBe("evidence-scored guess");
      expect(edge.score).toBeGreaterThanOrEqual(0.2);
      expect(edge.score).toBeLessThanOrEqual(1);
      const involved = [edge.a, edge.b];
      expect(involved.some((id) => decoys.includes(id))).toBe(false);
    }
    expect(report.weblogBetLinks.some((row) => row.ticket === "1002")).toBe(
      true,
    );
    expect(containsUnhashedIp(report)).toBe(false);
    expect(JSON.stringify(report)).not.toContain("203.0.113.10");
    expect(JSON.stringify(report)).not.toContain("8.8.8.8");
  });
});

describe("prediction", () => {
  const nowMs = Date.parse("2026-11-14T00:00:00.000Z");

  test("orders a cooling, declining, moved account above a stable active one", () => {
    const projection = ingestPullDirectory(plantedTree());
    const report = predictAccounts(projection, { nowMs });
    const alice = report.accounts.find((row) => row.accountId === "ALICE");
    const bob = report.accounts.find((row) => row.accountId === "BOB");
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.score).toBeGreaterThan(bob!.score);
    const aliceOrder = report.accounts.findIndex(
      (row) => row.accountId === "ALICE",
    );
    const bobOrder = report.accounts.findIndex(
      (row) => row.accountId === "BOB",
    );
    expect(aliceOrder).toBeLessThan(bobOrder);
    const move = alice!.signals.find((s) => s.name === "agent_moves");
    expect(move?.available).toBe(true);
    expect(move?.value).toBe(1);
    const bobMove = bob!.signals.find((s) => s.name === "agent_moves");
    expect(bobMove?.available).toBe(true);
    expect(bobMove?.value).toBe(0);
    expect(alice!.expectedChange.overdue).toBe(true);
    expect(alice!.expectedChange.model).toBe("exponential-waiting-time");
    expect(report.signalsNeedingMultipleCensusSnapshots).toEqual([
      "agent_moves",
    ]);
    expect(report.snapshotCadence.weblog).toContain("daily");
  });
});

describe("ip hashing and CLI output", () => {
  test("runLinkAnalysis hashes IPs in the summary file and stdout shape", () => {
    const root = plantedTree();
    const { report, outPath } = runLinkAnalysis(root);
    expect(outPath.endsWith("analysis/link-summary.json")).toBe(true);
    const saved = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
    expect(containsUnhashedIp(saved)).toBe(false);
    expect(containsUnhashedIp(report)).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("203.0.113.10");
    const { report: predicted } = runPredictAnalysis(root, {
      nowMs: Date.parse("2026-11-14T00:00:00.000Z"),
    });
    expect(containsUnhashedIp(predicted)).toBe(false);
  });

  test("CLI link writes hashed JSON to stdout", async () => {
    const root = plantedTree();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const code = await analyzeMain(["link", "--in", root]);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as unknown;
    expect(containsUnhashedIp(parsed)).toBe(false);
    expect(logs[0]).not.toContain("203.0.113.10");
    expect(logs[0]).toContain("evidence-scored guess");
  });
});

describe("analyzer hashes every IP and refuses raw output", () => {
  test("every IPv4 and IPv6 in one string is hashed", () => {
    const out = hashIpsDeep({
      note: "from 10.1.2.3 then 10.9.8.7",
      v6: "2026-11-01T10:00:00Z from 2600:380::1 and 2607:fb90::9",
    }) as { note: string; v6: string };
    expect(out.note).toBe(
      `from ${hashIp("10.1.2.3")} then ${hashIp("10.9.8.7")}`,
    );
    expect(out.v6).toBe(
      `2026-11-01T10:00:00Z from ${hashIp("2600:380::1")} and ${hashIp("2607:fb90::9")}`,
    );
    expect(containsUnhashedIp(out)).toBe(false);
  });

  test("the backstop flags a second raw IP, an IPv6 and a raw IP-named field", () => {
    expect(containsUnhashedIp(`x ${hashIp("10.1.2.3")} then 10.9.8.7`)).toBe(
      true,
    );
    expect(containsUnhashedIp({ note: "via 2600:380::1" })).toBe(true);
    expect(containsUnhashedIp({ IPAddress: "not-hashed" })).toBe(true);
    expect(containsUnhashedIp({ IPAddress: hashIp("10.1.2.3") })).toBe(false);
    expect(containsUnhashedIp({ ip: "" })).toBe(false);
  });

  test("assertNoRawIp throws a named F402AnalyzeError", () => {
    expect(() => assertNoRawIp("a 10.1.2.3 b 10.9.8.7", "link")).toThrow(
      F402AnalyzeError,
    );
    expect(() =>
      assertNoRawIp(hashIpsDeep("a 10.1.2.3 b 10.9.8.7"), "link"),
    ).not.toThrow();
  });

  test("CLI csv output hashes IPs in csv rows too", async () => {
    const root = plantedTree();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const code = await analyzeMain(["link", "--in", root, "--format", "csv"]);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const text = logs.join("\n");
    expect(text).not.toContain("203.0.113.10");
    expect(containsUnhashedIp(text)).toBe(false);
  });
});

describe("property tests", () => {
  test("hashIp is deterministic, not the raw IP, and survives a deep walk", () => {
    const ips = [
      "203.0.113.10",
      "8.8.8.8",
      "198.51.100.9",
      "127.0.0.1",
      "10.0.0.2",
      "192.168.1.20",
      "255.255.255.255",
    ];
    for (const ip of ips) {
      const hashed = hashIp(ip);
      expect(hashed).toBe(hashIp(ip));
      expect(hashed).not.toBe(ip);
      expect(hashed.startsWith("ip:")).toBe(true);
      expect(hashed).not.toContain(ip);
      expect(containsUnhashedIp(hashed)).toBe(false);
      expect(
        containsUnhashedIp(
          hashIpsDeep({ ip, IPAddress: ip, note: `from ${ip}` }),
        ),
      ).toBe(false);
    }
  });

  test("ip rarity is monotone in the number of accounts sharing the IP", () => {
    for (const total of [4, 8, 16, 32, 100]) {
      let previous = 1;
      for (let n = 2; n <= total; n += 1) {
        const rarity = ipRarity(n, total);
        expect(rarity).toBeGreaterThanOrEqual(0);
        expect(rarity).toBeLessThanOrEqual(1);
        expect(rarity).toBeLessThanOrEqual(previous + 1e-12);
        previous = rarity;
      }
      expect(ipRarity(total, total)).toBe(0);
      expect(ipRarity(1, total)).toBe(0);
    }
  });

  test("combined evidence scores stay in [0, 1] and increase with added evidence", () => {
    const samples = [
      [],
      [0],
      [1],
      [0.2, 0.3],
      [0.9, 0.9, 0.9],
      [0.5, 0.5, 0.5, 0.5],
      [0.01, 0.99],
    ];
    for (const scores of samples) {
      const combined = combineEvidenceScores(scores);
      expect(combined).toBeGreaterThanOrEqual(0);
      expect(combined).toBeLessThanOrEqual(1);
      if (scores.length >= 2) {
        expect(combined + 1e-12).toBeGreaterThanOrEqual(
          combineEvidenceScores(scores.slice(0, -1)),
        );
      }
    }
  });

  test("T/U matcher recovers unique-amount pairs and ignores amount decoys", () => {
    const transfers: SynthLedgerRow[] = [];
    let doc = 1;
    const amounts = [1100, 2200, 3300, 4400, 5500, 6600];
    for (const [index, amount] of amounts.entries()) {
      const hour = 10 + index;
      transfers.push({
        DocumentNumber: doc++,
        TranCode: "D",
        TranType: "U",
        Amount: amount,
        Balance: 10000,
        Description: "Transfer out",
        TranDateTime: `2026-11-01 ${String(hour).padStart(2, "0")}:00:00`,
        EnteredBy: "clerk",
      });
      transfers.push({
        DocumentNumber: doc++,
        TranCode: "C",
        TranType: "T",
        Amount: amount,
        Balance: 20000,
        Description: "Transfer in",
        TranDateTime: `2026-11-01 ${String(hour).padStart(2, "0")}:03:00`,
        EnteredBy: "clerk",
      });
    }
    const aliceRows = transfers.filter((_, i) => i % 2 === 0);
    const bobRows = transfers.filter((_, i) => i % 2 === 1);
    const decoy: SynthLedgerRow = {
      DocumentNumber: 99,
      TranCode: "C",
      TranType: "E",
      Amount: 1100,
      Balance: 1100,
      Description: "Deposit",
      TranDateTime: "2026-11-01 10:05:00",
      EnteredBy: "cashier",
    };
    const root = writeSyntheticPull(tempDir("f402-xfer-"), {
      snapshots: [
        {
          id: "2026-11-01",
          players: [
            { customerID: "ALICE", Login: "alice", Agent: "SUB1" },
            { customerID: "BOB", Login: "bob", Agent: "SUB1" },
            { customerID: "GUS", Login: "gus", Agent: "SUB1" },
          ],
        },
      ],
      ledger: { ALICE: aliceRows, BOB: bobRows, GUS: [decoy] },
      weblog: {},
    });
    const report = linkAccounts(ingestPullDirectory(root), { hashIp });
    const transferEdges = report.edges.filter((edge) =>
      edge.evidence.some((item) => item.type === "transfer"),
    );
    expect(transferEdges).toHaveLength(1);
    expect(transferEdges[0]?.a).toBe("ALICE");
    expect(transferEdges[0]?.b).toBe("BOB");
    expect(
      transferEdges[0]?.evidence.filter((e) => e.type === "transfer"),
    ).toHaveLength(amounts.length);
    expect(
      report.edges.some(
        (edge) =>
          (edge.a === "GUS" || edge.b === "GUS") &&
          edge.evidence.some((item) => item.type === "transfer"),
      ),
    ).toBe(false);
  });

  test("a longer inactivity gap raises the activity_gaps signal", () => {
    const nowMs = Date.parse("2026-11-14T00:00:00.000Z");
    const regular: SynthLedgerRow[] = [];
    for (let day = 1; day <= 10; day += 1) {
      const stamp = `2026-11-${String(day).padStart(2, "0")} 12:00:00`;
      regular.push({
        DocumentNumber: day,
        TranCode: "D",
        TranType: "A",
        Amount: 1000,
        Balance: 10000 - day * 100,
        Description: "Placed",
        TranDateTime: stamp,
        EnteredBy: "system",
      });
    }
    const quiet = regular.slice(0, 5);
    const root = writeSyntheticPull(tempDir("f402-gap-"), {
      snapshots: [
        {
          id: "2026-11-01",
          players: [
            { customerID: "HOT", Login: "hot", Agent: "SUB1" },
            { customerID: "OK", Login: "ok", Agent: "SUB1" },
          ],
        },
      ],
      ledger: { HOT: quiet, OK: regular },
      weblog: {},
    });
    const projection = ingestPullDirectory(root);
    const hot = predictAccount(projection, "HOT", nowMs);
    const ok = predictAccount(projection, "OK", nowMs);
    const hotGap = hot.signals.find((s) => s.name === "activity_gaps");
    const okGap = ok.signals.find((s) => s.name === "activity_gaps");
    expect(hotGap?.available).toBe(true);
    expect(okGap?.available).toBe(true);
    expect(hotGap!.value!).toBeGreaterThan(okGap!.value!);
    expect(hot.score).toBeGreaterThan(ok.score);
  });
});
