import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYSIS_REPORTS } from "../lib/analysis_filters.ts";
import { padSportField } from "../lib/f402_agent_performance_request.ts";
import {
  findSubSport,
  loadSportCatalog,
  periodsFor,
} from "../lib/sport_catalog.ts";

/**
 * Two live manager requests an operator pasted on 2026-11-01, recorded as *request* shapes only.
 *
 * This exists because both operations were previously unrecorded in this repo: getSubSportByReport
 * appeared nowhere, and getAgentPerformance was only an inferred URL with no request. Neither
 * response was observed, so nothing here may describe one.
 */
const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "fixtures/f402-report-requests-observed-2026-11-01.json",
    ),
    "utf8",
  ),
) as {
  observedAt: string;
  responsesObserved: boolean;
  agentPlaceholder: string;
  writeObservation?: string;
  writeResponse?: {
    body: { INFO: string };
    observedAt: string;
    whichCall: string;
    candidates: string[];
    interpretation: string;
    notAProof: string;
  };
  requests: Array<{
    operation: string;
    pathObserved: string | null;
    pathStatus: string;
    contentType: string;
    mutation?: boolean;
    body?: Record<string, unknown>;
    sportVariants?: Array<{
      sport: string;
      sportTrimmed: string;
      paddedLength: number;
    }>;
    caller?: {
      module: string;
      function: string;
      transport: string;
      observedFrom: string;
    };
    fields: Record<string, string>;
    filteredFields?: Record<string, string>;
  }>;
};

const catalog = loadSportCatalog(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        "fixtures/fantasy402-sport-catalog-2026-10-21.json",
      ),
      "utf8",
    ),
  ),
);
if (catalog === null) throw new Error("sport catalog fixture did not load");

/** JSON-bodied requests carry no form fields; normalise so accesses stay total. */
for (const request of fixture.requests) {
  request.fields ??= {};
}

const byOperation = (name: string) => {
  const request = fixture.requests.find((entry) => entry.operation === name);
  if (request === undefined) throw new Error(`fixture has no ${name}`);
  return request;
};

describe("observed manager requests (2026-11-01)", () => {
  test("records requests only, never a response", () => {
    expect(fixture.responsesObserved).toBe(false);
    for (const request of fixture.requests) {
      expect(Object.keys(request)).not.toContain("response");
    }
  });

  test("stores no credential material", () => {
    const raw = JSON.stringify(fixture);
    for (const forbidden of [
      "eyJ", // JWT prefix
      "Bearer",
      "cf_clearance",
      "__cf_bm",
      "authorization",
      "password",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // Identifiers are placeholders, not the pasted logins.
    for (const request of fixture.requests) {
      const agentId = request.fields.agentID ?? request.body?.agentID;
      const agentOwner = request.fields.agentOwner ?? request.body?.agentOwner;
      expect(agentId).toBe(fixture.agentPlaceholder);
      expect(agentOwner).toBe(fixture.agentPlaceholder);
    }
  });

  test("getSubSportByReport has an observed Manager path", () => {
    const request = byOperation("getSubSportByReport");
    expect(request.pathObserved).toBe("/cloud/api/Manager/getSubSportByReport");
    expect(request.pathStatus).toBe("observed");
    expect(Object.keys(request.fields)).toEqual([
      "customerID",
      "sport",
      "operation",
      "RRO",
      "agentID",
      "agentOwner",
    ]);
  });

  test("getAgentPerformance's URL is the Manager prefix, not Report/", () => {
    // This is the correction: the repo inferred Report/getAgentPerformance from the action name,
    // and an observed call goes to Manager/. The fixture records the path and why it matters.
    const request = byOperation("getAgentPerformance");
    expect(request.pathObserved).toBe("/cloud/api/Manager/getAgentPerformance");
    expect(request.pathStatus).toContain("contradicts");
    expect(request.pathObserved).not.toContain("/Report/");
    expect(Object.keys(request.fields)).toEqual([
      "start",
      "end",
      "agentID",
      "type",
      "freePlay",
      "store",
      "sport",
      "subsport",
      "period",
      "wagerType",
      "betType",
      "tipo",
      "debug",
      "operation",
      "RRO",
      "agentOwner",
    ]);
  });

  test("type=CP is a real wire value, matching the Analysis filter vocabulary", () => {
    const cp = ANALYSIS_REPORTS.find((entry) => entry.value === "CP");
    expect(cp).toBeDefined();
    expect(byOperation("getAgentPerformance").fields.type).toBe(cp?.value);
  });

  test("sport is padded to 20 characters on the wire", () => {
    // "Football" + 12 spaces. Trimming it is correct for parsing and wrong for a replay, so the
    // padding is pinned rather than normalised away. getGrading sends no sport field at all.
    const withSport = fixture.requests.filter(
      (request) => request.fields.sport !== undefined,
    );
    expect(withSport.length).toBeGreaterThanOrEqual(2);
    for (const request of withSport) {
      const sport = request.fields.sport ?? "";
      expect(sport).toHaveLength(20);
      expect(sport.trim()).not.toBe("");
    }
  });

  test("empty filters are sent as empty strings, not omitted", () => {
    // A replay that drops subsport/wagerType/betType is not the request the portal sends.
    const fields = byOperation("getAgentPerformance").fields;
    for (const key of ["subsport", "wagerType", "betType"]) {
      expect(Object.keys(fields)).toContain(key);
      expect(fields[key]).toBe("");
    }
  });

  test("dates are M/D/YYYY in start and end", () => {
    const fields = byOperation("getAgentPerformance").fields;
    expect(fields.start).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(fields.end).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  test("the report calls are form-encoded", () => {
    // The write flow is excluded on purpose: it mixes JSON and form encoding (see its own tests).
    const reports = fixture.requests.filter(
      (request) => request.mutation !== true,
    );
    expect(reports.length).toBeGreaterThanOrEqual(3);
    for (const request of reports) {
      expect(request.contentType).toStartWith(
        "application/x-www-form-urlencoded",
      );
    }
  });
});

describe("the filtered CP request", () => {
  const request = byOperation("getAgentPerformance");
  const base = request.fields;
  const filtered = request.filteredFields;

  const variant = (): Record<string, string> => {
    if (filtered === undefined)
      throw new Error("fixture has no filtered variant");
    return filtered;
  };

  test("only the four filter fields differ from the unfiltered call", () => {
    const changed = Object.keys(base).filter(
      (key) => base[key] !== variant()[key],
    );
    expect(changed.sort()).toEqual(
      ["betType", "period", "subsport", "wagerType"].sort(),
    );
    expect(Object.keys(variant())).toEqual(Object.keys(base));
  });

  test("subsport=NFL is a real sub-sport code under Football", () => {
    // The wire sends the code, not a number; the captured catalog is the authority on which codes
    // exist, and NFL is one of Football's 28.
    const sub = findSubSport(catalog, "Football", variant().subsport ?? "");
    expect(sub).not.toBeNull();
    expect(sub?.code).toBe("NFL");
  });

  test("period=1 means 1st Half under Football, not 'first period' generically", () => {
    const periods = periodsFor(catalog, "Football");
    const period = periods.find(
      (entry) => String(entry.number) === variant().period,
    );
    expect(period?.name).toBe("1st Half");
  });

  test("wagerType and betType stay raw codes", () => {
    // M and S are carried as sent. The repo has no documented meaning for M, so nothing here may
    // translate them into "Moneyline" and "Straight".
    expect(variant().wagerType).toBe("M");
    expect(variant().betType).toBe("S");
  });

  test("the form encoding round-trips to the pasted body", () => {
    // The portal sends spaces as "+", escaped slashes and an empty-string field; building the body
    // from the recorded fields must reproduce it byte for byte, or a replay is a different request.
    // The pasted body carried the agent login where the fixture carries its placeholder, so the
    // identity is substituted on both sides and everything else must match exactly.
    const placeholder = encodeURIComponent(fixture.agentPlaceholder);
    const observed = (
      "start=10%2F21%2F2026&end=11%2F01%2F2026&agentID=<agent>&type=CP&freePlay=Y" +
      "&store=<agent>&sport=Football++++++++++++&subsport=NFL&period=1" +
      "&wagerType=M&betType=S&tipo=0&debug=0&operation=getAgentPerformance" +
      "&RRO=1&agentOwner=<agent>"
    ).replaceAll("<agent>", placeholder);

    const encoded = new URLSearchParams(
      Object.entries(variant()) as [string, string][],
    ).toString();

    expect(encoded).toBe(observed);
  });
});

describe("who calls getSubSportByReport", () => {
  test("the caller module and function are recorded", () => {
    // A browser stack trace names the caller: send -> ajax -> getSubsport -> agent-performance.js.
    // That matters because it places the sub-sport call on the same screen as the CP report.
    const caller = byOperation("getSubSportByReport").caller;
    expect(caller).toBeDefined();
    expect(caller?.module).toContain("agent-performance.js");
    expect(caller?.module).toContain("1.0.280");
    expect(caller?.function).toBe("getSubsport");
  });

  test("the transport is jQuery ajax, which explains the form encoding", () => {
    // $.ajax defaults to application/x-www-form-urlencoded with X-Requested-With, matching the
    // headers observed on the request itself.
    const caller = byOperation("getSubSportByReport").caller;
    expect(caller?.transport).toContain("jQuery");
    expect(byOperation("getSubSportByReport").contentType).toStartWith(
      "application/x-www-form-urlencoded",
    );
  });

  test("the trace is attributed, not asserted as a capture", () => {
    const caller = byOperation("getSubSportByReport").caller;
    expect(caller?.observedFrom).toContain("2026-11-01");
    expect(caller?.observedFrom).toContain("stack trace");
  });
});

describe("the sport field, from two observations", () => {
  const variants = byOperation("getSubSportByReport").sportVariants ?? [];

  test("every observed sport pads to 20 characters", () => {
    // Football, Auto Racing, Tennis — three names of different lengths, one width.
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const variant of variants) {
      expect(variant.paddedLength).toBe(20);
      expect(variant.sport).toHaveLength(20);
      expect(variant.sport.trim()).toBe(variant.sportTrimmed);
    }
  });

  test("a two-word sport pads after both words", () => {
    // "Auto Racing" + 9 spaces, so the encoded segment is Auto+Racing followed by nine "+".
    const autoRacing = variants.find(
      (variant) => variant.sportTrimmed === "Auto Racing",
    );
    expect(autoRacing).toBeDefined();
    expect(autoRacing?.sport).toBe("Auto Racing".padEnd(20, " "));
    // Two words plus 9 trailing spaces: encoded, that is one "+" between the words and nine after.
    expect(autoRacing?.sport.slice("Auto Racing".length)).toBe(" ".repeat(9));
    expect(
      new URLSearchParams([["sport", autoRacing?.sport ?? ""]]).toString(),
    ).toBe("sport=Auto+Racing+++++++++");
  });

  test("a five-character name is padded to the same width", () => {
    const tennis = variants.find(
      (variant) => variant.sportTrimmed === "Tennis",
    );
    expect(tennis).toBeDefined();
    expect(tennis?.sport).toBe("Tennis".padEnd(20, " "));
    expect(
      new URLSearchParams([["sport", tennis?.sport ?? ""]]).toString(),
    ).toBe("sport=Tennis++++++++++++++");
  });

  test("padSportField reproduces every observed sport segment", () => {
    for (const variant of variants) {
      expect(padSportField(variant.sportTrimmed)).toBe(variant.sport);
    }
  });
});

describe("the getGrading request", () => {
  const request = byOperation("getGrading");

  test("is under the Report prefix, unlike getAgentPerformance", () => {
    // Two report operations, two prefixes. A single "reports live under one prefix" rule is wrong.
    expect(request.pathObserved).toBe("/cloud/api/Report/getGrading");
    expect(byOperation("getAgentPerformance").pathObserved).toBe(
      "/cloud/api/Manager/getAgentPerformance",
    );
  });

  test("echoes its own URL path in a body field", () => {
    const path = request.pathObserved;
    if (path === null) throw new Error("getGrading path was not observed");
    expect(request.fields.path).toBe(path);
  });

  test("sends ISO dates where getAgentPerformance sends M/D/YYYY", () => {
    // Recorded because it is a trap: the same screen family uses two date formats.
    expect(request.fields.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(request.fields.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const agentPerformance = byOperation("getAgentPerformance").fields;
    expect(agentPerformance.start).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    expect(agentPerformance.start).not.toMatch(/^\d{4}-/);
  });

  test("sends empty customerID and type rather than omitting them", () => {
    expect(Object.keys(request.fields)).toContain("customerID");
    expect(request.fields.customerID).toBe("");
    expect(request.fields.type).toBe("");
  });

  test("has no token field, though the capture record stored a 3-field body", () => {
    // docs/evidence/captures/2026-11-01/getGrading.post.json records {customerID, operation, token}
    // for this operation. This observed call sends ten fields and no token, so the two shapes are
    // both real and the skeleton is not the whole contract.
    expect(Object.keys(request.fields)).not.toContain("token");
    expect(Object.keys(request.fields)).toHaveLength(10);
  });

  test("the form encoding round-trips to the pasted body", () => {
    const placeholder = encodeURIComponent(fixture.agentPlaceholder);
    const observed = (
      "path=%2Fcloud%2Fapi%2FReport%2FgetGrading&customerID=&agent=<agent>" +
      "&start=2026-11-01&end=2026-11-01&type=&operation=getGrading&RRO=1" +
      "&agentID=<agent>&agentOwner=<agent>"
    ).replaceAll("<agent>", placeholder);

    expect(
      new URLSearchParams(
        Object.entries(request.fields) as [string, string][],
      ).toString(),
    ).toBe(observed);
  });
});

describe("the vipListInsert write and its audit trail", () => {
  test("a save is three requests, and all three are mutations", () => {
    // Recorded as evidence of behaviour, never as something to replay: nothing in this repo calls
    // any of them, and production is read-only unless a task is explicitly a deploy.
    const save = ["vipListInsert", "writeDetail", "write"].map(byOperation);
    expect(save.every((request) => request.mutation === true)).toBe(true);
    // "never replayed" is about recorded requests. A probe may synthesise its own body, so the
    // fixture has to say that rather than claim no code can reach these operations.
    expect(fixture.writeObservation).toContain("never as a script");
    expect(fixture.writeObservation).toContain("readOnly:false");
    expect(fixture.writeObservation).toContain(
      "vipListInsert, Log/writeDetail and updateBetTickerConfig have no",
    );
  });

  test("the probe's writable operations are exactly the ones the docs admit to", () => {
    // Guard against a new non-readOnly probe making the docs' "no call site" claim false silently.
    const probe = readFileSync(
      resolve(import.meta.dir, "../lib/f402_probe.ts"),
      "utf8",
    );
    const writable = [...probe.matchAll(/operation: "([A-Za-z]+)"/g)]
      .filter((match) => {
        // An entry declares readOnly within a few lines of its operation name.
        const from = match.index ?? 0;
        return probe.slice(from, from + 260).includes("readOnly: false");
      })
      .map((match) => match[1] ?? "");

    expect(writable.sort()).toEqual(
      [
        "PendingDelete",
        "renewToken",
        "updateReportConfigCustomerAdmin",
        "write",
      ].sort(),
    );
    expect(writable).toContain("write");
    expect(writable).not.toContain("vipListInsert");
    expect(writable).not.toContain("updateBetTickerConfig");
  });

  test("the mutation is JSON and carries a list array", () => {
    const insert = byOperation("vipListInsert");
    expect(insert.contentType).toBe("application/json");
    const body = insert.body ?? {};
    expect(body.operation).toBe("vipListInsert");
    expect(Array.isArray(body.list)).toBe(true);
    const entry = (body.list as Array<Record<string, string>>)[0];
    expect(entry?.agentID).toBe(fixture.agentPlaceholder);
    expect(entry?.player).toBe("<player>");
  });

  test("writeDetail carries the same list as encoded JSON in a form field", () => {
    const detail = byOperation("writeDetail");
    expect(detail.contentType).toStartWith("application/x-www-form-urlencoded");
    const parsed = JSON.parse(detail.fields.data ?? "[]") as Array<
      Record<string, string>
    >;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.player).toBe("<player>");
    // ticket=0: this audit row is not attached to a wager.
    expect(detail.fields.ticket).toBe("0");
    expect(detail.fields.info).toContain("v1.0.280");
  });

  test("write names the screen it logged", () => {
    const write = byOperation("write");
    expect(write.contentType).toBe("application/json");
    expect(write.body?.description).toContain("Save Action / Vip List");
    expect(write.body?.description).toContain("v1.0.280");
  });

  test("one save flow uses two encodings", () => {
    // JSON, then form, then JSON. A client that assumes one content type for writes breaks on the
    // middle call.
    const encodings = ["vipListInsert", "writeDetail", "write"].map(
      (name) => byOperation(name).contentType.split(";")[0],
    );
    expect(encodings).toEqual([
      "application/json",
      "application/x-www-form-urlencoded",
      "application/json",
    ]);
  });

  test("identifiers are unpadded in these calls", () => {
    // This contradicts the runbook's note that Log/write pads its customerID to 10 characters:
    // every identifier observed here is the bare login.
    const detail = byOperation("writeDetail");
    for (const key of ["customerID", "agentID", "agentOwner"]) {
      expect(detail.fields[key]).toBe(fixture.agentPlaceholder);
    }
    expect(byOperation("write").body?.customerID).toBe(
      fixture.agentPlaceholder,
    );
    expect(byOperation("vipListInsert").body?.agentID).toBe(
      fixture.agentPlaceholder,
    );
  });
});

describe("writeDetail encoding, confirmed by two independent pastes", () => {
  /** The raw body exactly as the portal sent it (from the curl paste). */
  const rawBody =
    "customerID=BILLY666&data=%5B%7B%22agentID%22%3A%22BILLY666%22%2C%22player%22%3A%22G441%22%7D%5D" +
    "&ticket=0&info=+%5BSITE+%3A+fantasy402.com+v1.0.280%5D+" +
    "&operation=writeDetail&agentID=BILLY666&agentOwner=BILLY666";

  test("rebuilding the body from the fixture reproduces the raw paste", () => {
    // An operator later pasted the same call in decoded form, so this is a cross-check: encoded
    // fixture → raw body, and decoded fixture → same fields. If the JSON inside `data` is ever
    // pretty-printed or reordered, this fails.
    const fields = byOperation("writeDetail").fields;
    const encoded = new URLSearchParams(
      Object.entries(fields).map(([key, value]) => [
        key,
        value.replaceAll("<agent>", "BILLY666").replaceAll("<player>", "G441"),
      ]) as [string, string][],
    ).toString();

    expect(encoded).toBe(rawBody);
  });

  test("info keeps its leading and trailing space", () => {
    // " [SITE : …] " — a trimmed version is a different value, so it is stored verbatim.
    expect(byOperation("writeDetail").fields.info).toBe(
      " [SITE : fantasy402.com v1.0.280] ",
    );
  });

  test("data is JSON inside a form field, not a nested object", () => {
    const data = byOperation("writeDetail").fields.data ?? "";
    expect(data.startsWith("[{")).toBe(true);
    expect(JSON.parse(data)).toEqual([
      { agentID: "<agent>", player: "<player>" },
    ]);
  });
});

describe("the write acknowledgement", () => {
  const response = fixture.writeResponse;

  test("is recorded as an empty INFO string", () => {
    expect(response).toBeDefined();
    expect(response?.body).toEqual({ INFO: "" });
    expect(typeof response?.body.INFO).toBe("string");
    expect(response?.body.INFO).toBe("");
  });

  test("does not claim to be a success signal", () => {
    // The shape says "no payload". The portal acknowledges writes without inspecting results
    // elsewhere (updateBasicSettings assigns local state from the values it sent), so "INFO is
    // empty" cannot be promoted to "the write succeeded".
    expect(response?.notAProof).toContain("No success semantics");
    expect(response?.interpretation).toContain("no payload");
  });

  test("says which call it answered is unknown", () => {
    expect(response?.whichCall).toContain("not identified");
    expect(response?.candidates).toEqual([
      "vipListInsert",
      "writeDetail",
      "write",
    ]);
  });

  test("it is a different envelope from the ticker config, under the same key", () => {
    // Same key, two types: INFO as object (config) vs INFO as empty string (write ack). A parser
    // that assumes one form silently reads the other.
    expect(typeof response?.body.INFO).toBe("string");
    expect(response?.interpretation).toContain("either an object");
  });
});
