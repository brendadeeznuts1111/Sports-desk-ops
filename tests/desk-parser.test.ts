import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  onTestFinished,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AmericanOdds as CanonicalAmericanOdds,
  BasisPoints as CanonicalBasisPoints,
  Cents as CanonicalCents,
  EpochMs as CanonicalEpochMs,
  LineHundredths as CanonicalLineHundredths,
  SettledCents as CanonicalSettledCents,
} from "../design/domain-branded-types.ts";
import { readAuditEntries } from "../lib/audit_log.ts";
import {
  type AmericanOdds,
  assertSanitizedDeskPayload,
  type BasisPoints,
  type Cents,
  coerceAmericanOdds,
  coerceCents,
  compressDeskPayload,
  type CustomerDesk,
  type DeskDiagnostic,
  type DeskR2WriteClient,
  type DeskRiskProvenance,
  type EpochMs,
  evaluateDeskRisk,
  formatDeskForPeer,
  getLatestDeskRiskTelemetry,
  INVALID_AMERICAN_ODDS,
  type LineHundredths,
  parseAsEpochMs,
  parseDesk,
  parseDeskStream,
  publishDeskRiskSnapshotToR2,
  recordDeskRiskEvaluation,
  resetDeskRiskTelemetryForTests,
  riskPendingAtMax,
  sanitizeCustomerDesk,
  type SettledCents,
  ZERO_CENTS,
} from "../lib/desk-parser.ts";

const prevAuditDir = Bun.env.SPORTSDESK_AUDIT_DIR;
const auditTempDirs: string[] = [];

function setAuditEnv(value: string | undefined): void {
  if (value === undefined)
    Reflect.deleteProperty(Bun.env, "SPORTSDESK_AUDIT_DIR");
  else Reflect.set(Bun.env, "SPORTSDESK_AUDIT_DIR", value);
}

afterEach(() => {
  resetDeskRiskTelemetryForTests();
  setAuditEnv(prevAuditDir);
  while (auditTempDirs.length > 0) {
    rmSync(auditTempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Zero-float Cents & AmericanOdds coercion", () => {
  test("parses exact decimal cents without IEEE-754 drift and enforces AmericanOdds bounds", () => {
    const xml = `
      <desk>
        <customer id="C-700" name="ExactMath" tier="A" />
        <limits max_stake="19.99" currency="USD" />
        <positions>
          <position id="W-7001" market="Arsenal -0.5" stake="19.99" price="+145" status="pending" day="2026-11-14">Home</position>
          <position id="W-7002" market="Chelsea ML" stake="10.5" price="-110" status="pending" day="2026-11-14">Away</position>
        </positions>
      </desk>
    `;

    const desk = parseDesk(xml, "xml");
    // "19.99" * 100 in float would be 1998.9999999999998; BigInt string math yields exact 1999
    expect(desk.limits.max_stake).toBe(1999 as typeof desk.limits.max_stake);
    expect(desk.positions[0]?.stake).toBe(1999 as typeof desk.limits.max_stake);
    expect(desk.positions[0]?.price).toBe(
      145 as NonNullable<(typeof desk.positions)[0]>["price"],
    );
    expect(desk.positions[1]?.stake).toBe(1050 as typeof desk.limits.max_stake);
    expect(desk.positions[1]?.price).toBe(
      -110 as NonNullable<(typeof desk.positions)[1]>["price"],
    );

    const risk = evaluateDeskRisk(desk);
    expect(risk.pendingAtMax.map((p) => p.id)).toEqual(["W-7001"]);
    expect(risk.requiresArsenalAlert).toBe(true);
    expect(riskPendingAtMax(desk).map((p) => p.id)).toEqual(["W-7001"]);
  });

  test("rejects sub-cent precision, float odds, and out-of-range odds (-99..99) with diagnostics", () => {
    const json = JSON.stringify({
      customer: { id: "C-701", name: "BadInputs", tier: "B" },
      limits: { max_stake: 5000, currency: "USD" },
      positions: [
        {
          id: "W-8001",
          market: "Arsenal Over 2.5",
          side: "Over",
          stake: "10.123",
          price: "-110",
          status: "pending",
          day: "2026-11-14",
        },
        {
          id: "W-8002",
          market: "Spurs ML",
          side: "Home",
          stake: "250",
          price: "-50",
          status: "pending",
          day: "2026-11-14",
        },
        {
          id: "W-8003",
          market: "Villa ML",
          side: "Away",
          stake: "250",
          price: "-110.5",
          status: "pending",
          day: "2026-11-14",
        },
      ],
    });

    const desk = parseDesk(json, "json");
    expect(desk.limits.max_stake).toBe(500000 as typeof desk.limits.max_stake);

    expect(desk.positions[0]?.stake).toBe(ZERO_CENTS);
    expect(desk.positions[0]?.hasCoercionError).toBe(true);
    expect(
      desk.diagnostics.some(
        (d) =>
          d.code === "COERCION_SUBCENT_PRECISION" && d.ticketId === "W-8001",
      ),
    ).toBe(true);

    expect(desk.positions[1]?.price).toBe(INVALID_AMERICAN_ODDS);
    expect(desk.positions[1]?.hasCoercionError).toBe(true);

    expect(desk.positions[2]?.price).toBe(INVALID_AMERICAN_ODDS);
    expect(desk.positions[2]?.hasCoercionError).toBe(true);

    const risk = evaluateDeskRisk(desk);
    expect(risk.degradedPending.map((p) => p.id)).toEqual([
      "W-8001",
      "W-8002",
      "W-8003",
    ]);
    expect(risk.requiresArsenalAlert).toBe(true);
  });
});

describe("Branded type invariants and zero-float edge cases", () => {
  test("enforces nominal Cents and AmericanOdds isolation at the type level", () => {
    expectTypeOf<number>().not.toMatchTypeOf<Cents>();
    expectTypeOf<number>().not.toMatchTypeOf<AmericanOdds>();
    expectTypeOf<Cents>().not.toMatchTypeOf<AmericanOdds>();
    expectTypeOf<AmericanOdds>().not.toMatchTypeOf<Cents>();
    expectTypeOf<Cents>().toMatchTypeOf<number>();
    expectTypeOf<AmericanOdds>().toMatchTypeOf<number>();
  });

  test("handles -0.00 normalization, sub-cent exponents, odds boundaries, and safe integer overflow", () => {
    const diags: DeskDiagnostic[] = [];

    const negZero = coerceCents("-0.00", "stake", diags, "p");
    expect(negZero.ok).toBe(true);
    expect(Object.is(negZero.value, 0)).toBe(true);

    const tinyExp = coerceCents(1e-7, "stake", diags, "p", "T-EXP");
    expect(tinyExp.ok).toBe(false);
    expect(tinyExp.value).toBe(ZERO_CENTS);
    expect(diags.at(-1)?.code).toBe("COERCION_SUBCENT_PRECISION");

    const maxSafe = coerceCents("90071992547409.91", "stake", diags, "p");
    expect(maxSafe.ok).toBe(true);
    expect(maxSafe.value).toBe(Number.MAX_SAFE_INTEGER as Cents);

    const overflow = coerceCents(
      "90071992547409.92",
      "stake",
      diags,
      "p",
      "T-OVF",
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.value).toBe(ZERO_CENTS);
    expect(diags.at(-1)?.code).toBe("COERCION_INVALID_CENTS");

    expect(coerceAmericanOdds(-100, "price", diags, "p").ok).toBe(true);
    expect(coerceAmericanOdds("+100", "price", diags, "p").ok).toBe(true);
    expect(coerceAmericanOdds(99, "price", diags, "p").ok).toBe(false);
    expect(coerceAmericanOdds("-99", "price", diags, "p").ok).toBe(false);
    expect(coerceAmericanOdds(0, "price", diags, "p").ok).toBe(false);
  });

  test("source contract: lib/desk-parser.ts avoids Number(), parseFloat(), parseInt(), and * 100", async () => {
    const rawSource = await Bun.file(
      new URL("../lib/desk-parser.ts", import.meta.url),
    ).text();
    const executableCode = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(executableCode).not.toMatch(/\bNumber\s*\(/);
    expect(executableCode).not.toMatch(/\bparseFloat\s*\(/);
    expect(executableCode).not.toMatch(/\bparseInt\s*\(/);
    expect(executableCode).not.toMatch(/\*\s*100\b/);
  });
});

describe("Bun 1.4 YAML cyclic anchors and number-like string preservation", () => {
  test("breaks cyclic YAML wrapper aliases with CYCLIC_DOCUMENT_REFERENCE without stack overflow", () => {
    const yaml = `
desk: &self
  customer:
    id: C-900
    name: CyclicUser
    tier: A
  limits:
    max_stake: "500.00"
    currency: USD
  desk: *self
  positions:
    - id: W-9001
      market: Arsenal ML
      side: Home
      stake: "500.00"
      price: "+120"
      status: pending
      day: "2026-11-14"
`;

    const desk = parseDesk(yaml, "yaml");
    expect(desk.customer).toEqual({
      id: "C-900",
      name: "CyclicUser",
      tier: "A",
    });
    expect(desk.limits.max_stake).toBe(50000 as Cents);
    expect(desk.positions).toHaveLength(1);
    expect(desk.positions[0]?.id).toBe("W-9001");
    expect(
      desk.diagnostics.some((d) => d.code === "CYCLIC_DOCUMENT_REFERENCE"),
    ).toBe(true);
  });

  test("handles cyclic YAML scalar value in stake without crashing diagnostic formatting", () => {
    const yaml = `
customer:
  id: C-901
  name: CyclicScalar
  tier: B
limits:
  max_stake: "250.00"
  currency: USD
positions:
  - id: W-9002
    market: Chelsea ML
    side: Away
    stake: &bad
      loop: *bad
    price: "-115"
    status: pending
    day: "2026-11-14"
`;

    const desk = parseDesk(yaml, "yaml");
    expect(desk.positions[0]?.stake).toBe(ZERO_CENTS);
    expect(desk.positions[0]?.hasCoercionError).toBe(true);
    expect(
      desk.diagnostics.some(
        (d) => d.code === "COERCION_INVALID_CENTS" && d.ticketId === "W-9002",
      ),
    ).toBe(true);
  });

  test("permits non-cyclic shared YAML anchors and preserves number-like IDs via Bun.YAML.stringify", () => {
    const yaml = Bun.YAML.stringify({
      customer: {
        id: "0123",
        name: "StringyIds",
        tier: "A",
      },
      limits: {
        max_stake: "100.00",
        currency: "USD",
      },
      positions: [
        {
          id: "0e6836",
          market: "Liverpool ML",
          side: "Home",
          stake: "50.00",
          price: "+105",
          status: "pending",
          day: "2026-11-14",
        },
      ],
    });

    const roundtripped = parseDesk(yaml, "yaml");
    expect(roundtripped.customer.id).toBe("0123");
    expect(roundtripped.positions[0]?.id).toBe("0e6836");

    const dagYaml = `
customer:
  id: "0123"
  name: SharedAnchorDag
  tier: A
limits:
  max_stake: "100.00"
  currency: USD
positions:
  - &shared_pos
    id: "0e6836"
    market: Liverpool ML
    side: Home
    stake: "50.00"
    price: "+105"
    status: pending
    day: "2026-11-14"
  - *shared_pos
`;
    const dagDesk = parseDesk(dagYaml, "yaml");
    expect(dagDesk.positions).toHaveLength(2);
    expect(
      dagDesk.diagnostics.some((d) => d.code === "CYCLIC_DOCUMENT_REFERENCE"),
    ).toBe(false);
  });
});

describe("Bun 1.4 streaming decompression and incremental JSONL parsing", () => {
  const sampleJsonl = [
    JSON.stringify({
      customer: { id: "C-950", name: "StreamDesk", tier: "VIP" },
      limits: { max_stake: "250.00", currency: "USD" },
    }),
    JSON.stringify({ type: "heartbeat", ts: "2026-11-14T13:00:00Z" }),
    JSON.stringify({
      position: {
        id: "W-9501",
        market: "Bayern München — Arsenal 🔥",
        side: "Away",
        stake: "120.00",
        price: "+150",
        status: "pending",
        day: "2026-11-14",
      },
    }),
    JSON.stringify({
      position: {
        id: "W-9501",
        market: "Bayern München — Arsenal 🔥",
        side: "Away",
        stake: "250.00",
        price: "+155",
        status: "pending",
        day: "2026-11-14",
      },
    }),
  ].join("\n");

  function chunkBytes(bytes: Uint8Array, size = 5): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    });
  }

  test("parses zstd and gzip chunked JSONL streams identically to parseDesk", async () => {
    const expected = parseDesk(sampleJsonl, "jsonl");

    for (const compression of ["zstd", "gzip"] as const) {
      const compressed = await compressDeskPayload(sampleJsonl, compression);
      const stream = chunkBytes(compressed, 5);
      const streamed = await parseDeskStream(stream, "jsonl", { compression });

      expect(Bun.deepEquals(streamed, expected)).toBe(true);
      expect(streamed.positions[0]?.market).toBe("Bayern München — Arsenal 🔥");
      expect(streamed.positions[0]?.stake).toBe(25000 as Cents);
      expect(streamed.positions[0]?.price).toBe(155 as AmericanOdds);
    }
  });

  test("rejects truncated trailing JSONL and reports EMPTY_JSONL_STREAM on empty compressed payloads", async () => {
    const truncated = `${sampleJsonl}\n{"position":{"id":"W-9502"`;
    const truncatedStream = chunkBytes(new TextEncoder().encode(truncated), 7);
    await expect(parseDeskStream(truncatedStream, "jsonl")).rejects.toThrow(
      SyntaxError,
    );

    const emptyZstd = await compressDeskPayload("", "zstd");
    const emptyDesk = await parseDeskStream(emptyZstd, "jsonl", {
      compression: "zstd",
    });
    expect(emptyDesk.positions).toEqual([]);
    expect(
      emptyDesk.diagnostics.some((d) => d.code === "EMPTY_JSONL_STREAM"),
    ).toBe(true);
  });
});

describe("Bun 1.4 test runner ergonomics: using spyOn and onTestFinished", () => {
  test("restores Bun.JSONL.parseChunk automatically with using spy = spyOn(...)", async () => {
    const originalParseChunk = Bun.JSONL.parseChunk;
    const jsonl = [
      JSON.stringify({
        customer: { id: "C-960", name: "SpyTest", tier: "A" },
        limits: { max_stake: "100.00", currency: "USD" },
      }),
      JSON.stringify({
        position: {
          id: "W-9601",
          market: "Arsenal ML",
          side: "Home",
          stake: "100.00",
          price: "-110",
          status: "pending",
          day: "2026-11-14",
        },
      }),
    ].join("\n");

    const compressed = await compressDeskPayload(jsonl, "zstd");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const half = Math.floor(compressed.byteLength / 2);
        controller.enqueue(compressed.subarray(0, half));
        controller.enqueue(compressed.subarray(half));
        controller.close();
      },
    });

    {
      using parseChunkSpy = spyOn(Bun.JSONL, "parseChunk");
      const desk = await parseDeskStream(stream, "jsonl", {
        compression: "zstd",
      });
      expect(desk.positions[0]?.id).toBe("W-9601");
      expect(parseChunkSpy).toHaveBeenCalled();
    }

    expect(Bun.JSONL.parseChunk).toBe(originalParseChunk);
  });

  test("parses compressed .jsonl.zst file stream and cleans up with onTestFinished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-parser-zstd-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    const jsonl = [
      JSON.stringify({
        customer: { id: "C-970", name: "FileStream", tier: "A" },
        limits: { max_stake: "300.00", currency: "USD" },
      }),
      JSON.stringify({
        position: {
          id: "W-9701",
          market: "Arsenal -1.0",
          side: "Home",
          stake: "300.00",
          price: "+135",
          status: "pending",
          day: "2026-11-14",
        },
      }),
    ].join("\n");

    const filePath = join(dir, "desk.jsonl.zst");
    const compressed = await compressDeskPayload(jsonl, "zstd");
    await Bun.write(filePath, compressed);

    const desk = await parseDeskStream(Bun.file(filePath).stream(), "jsonl", {
      compression: "zstd",
    });

    expect(desk.customer.name).toBe("FileStream");
    expect(desk.limits.max_stake).toBe(30000 as Cents);
    expect(desk.positions[0]?.stake).toBe(30000 as Cents);
    expect(desk.positions[0]?.price).toBe(135 as AmericanOdds);
  });
});

describe("Pass 2 canonical brands, PII sanitization & telemetry", () => {
  test("unifies Cents, SettledCents, AmericanOdds, BasisPoints, LineHundredths, and EpochMs with canonical domain brands", () => {
    expectTypeOf<Cents>().toEqualTypeOf<CanonicalCents>();
    expectTypeOf<SettledCents>().toEqualTypeOf<CanonicalSettledCents>();
    expectTypeOf<AmericanOdds>().toEqualTypeOf<CanonicalAmericanOdds>();
    expectTypeOf<BasisPoints>().toEqualTypeOf<CanonicalBasisPoints>();
    expectTypeOf<LineHundredths>().toEqualTypeOf<CanonicalLineHundredths>();
    expectTypeOf<EpochMs>().toEqualTypeOf<CanonicalEpochMs>();
  });

  const makeRawDesk = (): CustomerDesk => ({
    customer: { id: "H1716-RAW", name: "Alice Sharp", tier: "A" },
    limits: {
      max_stake: 50000 as Cents,
      currency: "USD",
      hasValidMaxStake: true,
    },
    positions: [
      {
        id: "TICKET-RAW-1001",
        market: "Arsenal vs Chelsea",
        side: "Arsenal -0.5",
        stake: 50000 as Cents,
        price: -110 as AmericanOdds,
        status: "pending",
        day: null,
        hasCoercionError: false,
      },
      {
        id: "TICKET-RAW-1002",
        market: "Bad Coercion Game",
        side: "Away",
        stake: 10000 as Cents,
        price: INVALID_AMERICAN_ODDS,
        status: "pending",
        day: null,
        hasCoercionError: true,
      },
    ],
    diagnostics: [
      {
        code: "COERCION_INVALID_AMERICAN_ODDS",
        severity: "error",
        path: "$.positions[1].price",
        ticketId: "TICKET-RAW-1002",
        message: "Rejected input from 198.51.100.9 and 2001:db8:85a3::1",
        rawValue: "bad-odds-secret",
      },
    ],
  });

  test("sanitizeCustomerDesk and assertSanitizedDeskPayload enforce PII stripping and IP scrubbing", () => {
    const rawDesk = makeRawDesk();
    const sanitized = sanitizeCustomerDesk(rawDesk);

    expect(sanitized.customer.id).toMatch(/^cust_[0-9a-f]{12}$/);
    expect(sanitized.customer.name).toBe("[REDACTED]");
    expect(sanitized.customer.tier).toBe("A");
    expect(sanitized.positions[0]?.id).toMatch(/^tkt_[0-9a-f]{12}$/);
    expect(sanitized.diagnostics[0]?.ticketId).toMatch(/^tkt_[0-9a-f]{12}$/);
    expect(sanitized.diagnostics[0]?.rawValue).toBeUndefined();
    expect(sanitized.diagnostics[0]?.message).not.toContain("198.51.100.9");
    expect(sanitized.diagnostics[0]?.message).not.toContain("2001:db8:85a3::1");
    expect(sanitized.diagnostics[0]?.message).toContain("[REDACTED_IP]");

    const encoded = assertSanitizedDeskPayload(sanitized);
    const decoded = new TextDecoder().decode(encoded);
    expect(decoded).not.toContain("H1716-RAW");
    expect(decoded).not.toContain("Alice Sharp");
    expect(decoded).not.toContain("TICKET-RAW-1001");
    expect(decoded).not.toContain("bad-odds-secret");

    expect(() => assertSanitizedDeskPayload(rawDesk)).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        customer: { ...sanitized.customer, name: "Leaked Name" },
      }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        positions: [{ ...sanitized.positions[0], id: "RAW-POS-1" }],
      }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        diagnostics: [{ ...sanitized.diagnostics[0], rawValue: "leak" }],
      }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        diagnostics: [{ ...sanitized.diagnostics[0], ticketId: "RAW-TKT-9" }],
      }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({ ...sanitized, customerID: "H1716" }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({ ...sanitized, login: "H1716" }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({ ...sanitized, ipAddress: "203.0.113.5" }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        note: "peer 203.0.113.5",
      }),
    ).toThrow();
    expect(() =>
      assertSanitizedDeskPayload({
        ...sanitized,
        note: "peer 2001:db8::42",
      }),
    ).toThrow();
  });

  test("formatDeskForPeer returns raw desk on trusted loopback and sanitized desk otherwise", () => {
    const rawDesk = makeRawDesk();
    expect(formatDeskForPeer(rawDesk, true)).toBe(rawDesk);
    const peerSafe = formatDeskForPeer(rawDesk, false);
    expect(peerSafe.customer.id).toMatch(/^cust_[0-9a-f]{12}$/);
    expect(peerSafe.customer.name).toBe("[REDACTED]");
  });

  test("publishDeskRiskSnapshotToR2 sanitizes desk+risk, checks dual-clock lineage, and signs R2 metadata", async () => {
    const rawDesk = makeRawDesk();
    const risk = evaluateDeskRisk(rawDesk);
    const writes: Array<{
      key: string;
      body: Uint8Array | string;
      options:
        | {
            readonly type?: string;
            readonly metadata?: Readonly<Record<string, string>>;
          }
        | undefined;
    }> = [];
    const fakeClient: DeskR2WriteClient = {
      async writeWithMetadata(key, data, options) {
        writes.push({ key, body: data, options });
        return typeof data === "string"
          ? Buffer.byteLength(data)
          : data.byteLength;
      },
    };
    const provenance: DeskRiskProvenance = {
      sourceKind: "live",
      dataWindowMaxEpochMs: parseAsEpochMs(1_763_120_000_000),
      r2PublishedAtEpochMs: parseAsEpochMs(1_763_120_010_000),
    };

    const bytesWritten = await publishDeskRiskSnapshotToR2({
      client: fakeClient,
      key: "desk-risk/latest.json",
      desk: rawDesk,
      risk,
      provenance,
    });

    expect(bytesWritten).toBeGreaterThan(0);
    expect(writes.length).toBe(1);
    const call = writes[0]!;
    expect(call.key).toBe("desk-risk/latest.json");
    expect(call.options?.type).toBe("application/json");
    expect(call.options?.metadata).toEqual({
      pii: "none",
      "schema-version": "1",
      "source-kind": "live",
      "data-window-max-epoch-ms": "1763120000000",
      "r2-published-at-epoch-ms": "1763120010000",
    });

    const jsonText =
      typeof call.body === "string"
        ? call.body
        : new TextDecoder().decode(call.body);
    expect(jsonText).not.toContain("H1716-RAW");
    expect(jsonText).not.toContain("Alice Sharp");
    expect(jsonText).not.toContain("TICKET-RAW-1001");
    expect(jsonText).not.toContain("bad-odds-secret");
    expect(jsonText).not.toContain("198.51.100.9");
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe("desk-risk-snapshot");
    expect(parsed.data_window_max_epoch_ms).toBe(1_763_120_000_000);
    expect(parsed.r2_published_at_epoch_ms).toBe(1_763_120_010_000);
    expect(parsed.provenance).toEqual(provenance);
  });

  test("recordDeskRiskEvaluation updates latest telemetry and emits audit_log.ts wager entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-risk-audit-"));
    auditTempDirs.push(dir);
    setAuditEnv(dir);

    const rawDesk = makeRawDesk();
    const provenance: DeskRiskProvenance = {
      sourceKind: "capture",
      dataWindowMaxEpochMs: parseAsEpochMs(1_763_110_000_000),
      r2PublishedAtEpochMs: null,
    };

    const { evaluation, telemetry } = recordDeskRiskEvaluation(
      rawDesk,
      provenance,
      2500n,
    );
    expect(evaluation.pendingAtMax.length).toBe(1);
    expect(evaluation.degradedPending.length).toBe(1);
    expect(evaluation.requiresArsenalAlert).toBe(true);
    expect(getLatestDeskRiskTelemetry()).toEqual(telemetry);
    expect(telemetry.pendingAtMaxCount).toBe(1);
    expect(telemetry.degradedPendingCount).toBe(1);
    expect(telemetry.unresolvedGapCentsTotal).toBe("2500");
    expect(telemetry.provenance).toEqual(provenance);

    const entries = readAuditEntries({ category: "wager" });
    expect(entries.length).toBe(1);
    expect(entries[0]?.action).toBe("desk_risk_evaluated");
    expect(entries[0]?.details).toEqual({
      pendingAtMaxCount: 1,
      degradedPendingCount: 1,
      requiresArsenalAlert: true,
      unresolvedGapCentsTotal: "2500",
      sourceKind: "capture",
      dataWindowMaxEpochMs: 1_763_110_000_000,
      r2PublishedAtEpochMs: null,
    });
  });
});
