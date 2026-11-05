import { describe, expect, test } from "bun:test";
import {
  MANAGER_BOOT_OPS,
  PROBE_OPS,
  buildInstallRequestSnifferExpression,
  buildJsonProbeBody,
  buildProbeExpression,
  buildProbeBody,
  buildReadRequestSnifferExpression,
  isProbeReadOnlyConfirmed,
  parseProbePageResult,
  parseSniffedTemplates,
  padLogWriteCustomerId,
  probeSummary,
  probeUrl,
  probeVerdict,
  selectProbeOps,
} from "../lib/f402_probe.ts";

describe("f402 probe plan", () => {
  test("excludes the unconfirmed mutation by default and selects manager-boot / all suites", () => {
    const ops = selectProbeOps(false);
    expect(ops.map((op) => op.operation)).not.toContain("PendingDelete");
    // Excluded by default: the 4 mutations (`readOnly:false`) plus the 4 source-extracted
    // customer reads (`readOnly:true, unconfirmed:true`). The two axes are distinct: `readOnly`
    // is the write-contract flag, `unconfirmed` is the evidence flag.
    const unconfirmed = PROBE_OPS.filter(
      (op) => !op.readOnly || op.unconfirmed === true,
    ).length;
    expect(unconfirmed).toBe(8);
    expect(ops).toHaveLength(PROBE_OPS.length - unconfirmed);
    expect(selectProbeOps(true)).toHaveLength(PROBE_OPS.length);

    // A source-extracted read is readOnly but NOT "read-only confirmed" until a capture exists.
    for (const name of [
      "Get_LeagueLines",
      "Get_LeagueLines2",
      "Get_SportsLeagues",
      "verifyLeagues",
    ]) {
      const op = PROBE_OPS.find((o) => o.operation === name);
      expect(op?.readOnly).toBe(true);
      expect(op?.unconfirmed).toBe(true);
      expect(op === undefined ? false : isProbeReadOnlyConfirmed(op)).toBe(
        false,
      );
    }
    // The mutation set the docs admit to is unchanged.
    expect(
      PROBE_OPS.filter((op) => !op.readOnly)
        .map((op) => op.operation)
        .sort(),
    ).toEqual(
      [
        "PendingDelete",
        "renewToken",
        "updateReportConfigCustomerAdmin",
        "write",
      ].sort(),
    );

    const bootOps = selectProbeOps(false, "manager-boot");
    expect(bootOps).toHaveLength(9);
    expect(bootOps.map((op) => op.operation)).toEqual([
      "getAccountInfoOwner",
      "getConfigWebReports",
      "getConfigWebReportsPending",
      "getSportsType",
      "getAuthorizations",
      "getMessage",
      "getNewEmailsCount",
      "getWeeklyFigureByAgentLite",
      "getListAgenstByAgent",
    ]);

    const allReadOnly = selectProbeOps(false, "all");
    // 25 read-only report/module ops + 8 unique manager-boot ops (getListAgenstByAgent is shared) = 33
    expect(allReadOnly).toHaveLength(37);
  });

  test("builds URLs from the observed route prefix", () => {
    const op = PROBE_OPS[0]!;
    expect(probeUrl("https://fantasy402.com", op)).toBe(
      "https://fantasy402.com/cloud/api/Manager/Pending",
    );
    expect(probeUrl("https://fantasy402.com", op, "/cloud/api/Report")).toBe(
      "https://fantasy402.com/cloud/api/Report/Pending",
    );
    expect(probeUrl("https://fantasy402.com/base/", op)).toBe(
      "https://fantasy402.com/base/cloud/api/Manager/Pending",
    );
    expect(() => probeUrl("file:///tmp/x", op)).toThrow("http(s)");
    expect(() => probeUrl("https://fantasy402.com", op, "cloud")).toThrow(
      "start with /",
    );
  });

  test("builds the source-observed customer league catalog body and URLs", () => {
    const leagues = PROBE_OPS.find((o) => o.operation === "Get_SportsLeagues");
    if (leagues === undefined) throw new Error("Get_SportsLeagues missing");
    const body = new URLSearchParams(
      buildProbeBody(leagues, "BILLY666", "CCC107"),
    );
    expect([...body.keys()]).toEqual([
      "customerID",
      "token",
      "wagerType",
      "office",
      "placeLateFlag",
      "operation",
      "RRO",
    ]);
    expect(body.get("operation")).toBe("Get_SportsLeagues");
    expect(body.get("office")).toBe("BILLY666");
    expect(body.get("wagerType")).toBe("Straight");
    expect(body.get("placeLateFlag")).toBe("false");

    // League reads live under /cloud/api/League/, not the Manager prefix.
    expect(
      probeUrl("https://fantasy402.com", leagues, "/cloud/api/League"),
    ).toBe("https://fantasy402.com/cloud/api/League/Get_SportsLeagues");
    const verify = PROBE_OPS.find((o) => o.operation === "verifyLeagues");
    if (verify === undefined) throw new Error("verifyLeagues missing");
    expect(
      probeUrl("https://fantasy402.com", verify, "/cloud/api/League"),
    ).toBe("https://fantasy402.com/cloud/api/League/verifyLeagues");
  });

  test("builds the source-observed customer front-end lines body", () => {
    const op = PROBE_OPS.find((o) => o.operation === "Get_LeagueLines");
    if (op === undefined)
      throw new Error("Get_LeagueLines missing from PROBE_OPS");
    const body = new URLSearchParams(buildProbeBody(op, "BILLY666", "CCC107"));
    // Every field the customer bundle posts in `customer/line/line.js` (source-observed).
    expect([...body.keys()]).toEqual([
      "customerID",
      "token",
      "operation",
      "propDescription",
      "sportType",
      "sportSubType",
      "period",
      "hourFilter",
      "wagerType",
      "office",
      "keyword",
      "correlationID",
      "periodNumber",
      "periods",
      "rotOrder",
      "placeLateFlag",
      "RRO",
    ]);
    expect(body.get("operation")).toBe("Get_LeagueLines");
    expect(body.get("customerID")).toBe("CCC107");
    expect(body.get("office")).toBe("BILLY666");
    expect(body.get("period")).toBe("Game");
    expect(body.get("periodNumber")).toBe("0");
    expect(body.get("wagerType")).toBe("Straight");
    expect(body.get("sportType")).toBe(".");
    expect(body.get("placeLateFlag")).toBe("false");
    expect(body.get("RRO")).toBe("1");

    // Operator-reported variant carries the same source-derived body but its own operation.
    const variant = PROBE_OPS.find((o) => o.operation === "Get_LeagueLines2");
    if (variant === undefined) throw new Error("Get_LeagueLines2 missing");
    expect(
      new URLSearchParams(buildProbeBody(variant, "BILLY666", "CCC107")).get(
        "operation",
      ),
    ).toBe("Get_LeagueLines2");
  });

  test("builds the client envelope from customer/report/report.js and app/manager/manager.js", () => {
    const pending = new URLSearchParams(
      buildProbeBody(PROBE_OPS[0]!, "agent-118", "cust-9"),
    );
    expect([...pending.keys()]).toEqual(["customerID", "token", "operation"]);
    expect(pending.get("customerID")).toBe("cust-9");
    // Security.token is empty in the browser session; the edge accepts the bearer instead.
    expect(pending.get("token")).toBe("");
    expect(pending.get("operation")).toBe("Pending");

    const tx = new URLSearchParams(
      buildProbeBody(
        PROBE_OPS.find((op) => op.operation === "getTransactions")!,
        "agent-118",
      ),
    );
    expect([...tx.keys()]).toEqual([
      "customerID",
      "date",
      "token",
      "operation",
    ]);
    expect(tx.get("customerID")).toBe("__CUSTOMER_ID__");
    expect(tx.get("date")).toBe("__DATE__");

    const infoPlayer = PROBE_OPS.find(
      (op) => op.operation === "getInfoPlayer",
    )!;
    const infoBody = new URLSearchParams(
      buildProbeBody(infoPlayer, "BILLY666", "BILLY666"),
    );
    expect([...infoBody.keys()]).toEqual([
      "customerID",
      "agentID",
      "operation",
      "RRO",
      "agentOwner",
    ]);
    expect(infoBody.get("operation")).toBe("getInfoPlayer");
    expect(infoBody.get("RRO")).toBe("0");
    expect(infoBody.toString()).toBe(
      "customerID=BILLY666&agentID=BILLY666&operation=getInfoPlayer&RRO=0&agentOwner=BILLY666",
    );
    expect(padLogWriteCustomerId("BILLY666")).toBe("BILLY666  ");

    const customerAdmin = PROBE_OPS.find(
      (op) => op.operation === "getCustomerAdmin",
    );
    if (!customerAdmin)
      throw new Error("getCustomerAdmin missing from PROBE_OPS");
    expect(
      new URLSearchParams(buildProbeBody(customerAdmin, "BILLY666")).toString(),
    ).toBe(
      "agentID=BILLY666&sortCustom=1&operation=getCustomerAdmin&RRO=1&agentOwner=BILLY666",
    );
    expect(
      new URLSearchParams(
        buildProbeBody(customerAdmin, "BILLY666", undefined, {
          agentOwner: "CUB22HR",
          sortCustom: "2",
        }),
      ).toString(),
    ).toBe(
      "agentID=BILLY666&sortCustom=2&operation=getCustomerAdmin&RRO=1&agentOwner=CUB22HR",
    );

    const configReportsAdmin = PROBE_OPS.find(
      (op) => op.operation === "getConfigWebReportsCustomerAdmin",
    );
    if (!configReportsAdmin)
      throw new Error(
        "getConfigWebReportsCustomerAdmin missing from PROBE_OPS",
      );
    expect(
      new URLSearchParams(
        buildProbeBody(configReportsAdmin, "BILLY666"),
      ).toString(),
    ).toBe(
      "agentID=BILLY666&operation=getConfigWebReportsCustomerAdmin&RRO=1&agentOwner=BILLY666",
    );

    const sportsAdmin = PROBE_OPS.find(
      (op) => op.operation === "getSportsCustomerAdmin",
    );
    if (!sportsAdmin)
      throw new Error("getSportsCustomerAdmin missing from PROBE_OPS");
    expect(
      new URLSearchParams(buildProbeBody(sportsAdmin, "BILLY666")).toString(),
    ).toBe(
      "operation=getSportsCustomerAdmin&RRO=1&agentID=BILLY666&agentOwner=BILLY666",
    );

    const vig = PROBE_OPS.find((op) => op.operation === "getSportsVigSetup")!;
    expect(
      new URLSearchParams(
        buildProbeBody(vig, "BILLY666", "BILLY666", { sportType: "Football" }),
      ).toString(),
    ).toBe(
      "customerID=*&agentID=BILLY666&sportType=Football&operation=getSportsVigSetup&RRO=1&agentOwner=BILLY666",
    );

    const teaser = PROBE_OPS.find((op) => op.operation === "getTeaserProfile")!;
    expect(
      new URLSearchParams(
        buildProbeBody(teaser, "BILLY666", "BILLY666"),
      ).toString(),
    ).toBe(
      "acc=BILLY666&operation=getTeaserProfile&RRO=1&agentID=BILLY666&agentOwner=BILLY666",
    );

    // PendingDelete sends sentinel ticketNumber=-1 by default
    const pendingDelete = new URLSearchParams(
      buildProbeBody(
        PROBE_OPS.find((op) => op.operation === "PendingDelete")!,
        "agent-118",
      ),
    );
    expect(pendingDelete.get("ticketNumber")).toBe("-1");

    const pendingDeletePlayer = new URLSearchParams(
      buildProbeBody(
        PROBE_OPS.find((op) => op.operation === "PendingDelete")!,
        "agent-118",
        "PH1009",
        { ticketNumber: "1073143417" },
      ),
    );
    expect(pendingDeletePlayer.get("customerID")).toBe("PH1009");
    expect(pendingDeletePlayer.get("ticketNumber")).toBe("1073143417");

    // JSON wire bodies for getAccountInfoOwner (manager.js:31200) & getDailyFiguresByCustomer (report.js:25633)
    const acctOwnerOp = MANAGER_BOOT_OPS.find(
      (op) => op.operation === "getAccountInfoOwner",
    )!;
    expect(acctOwnerOp.wireContentType).toBe("application/json");
    expect(JSON.parse(buildJsonProbeBody(acctOwnerOp, "MILLER500"))).toEqual({
      agentID: "MILLER500",
      operation: "getAccountInfoOwner",
      agentOwner: "MILLER500",
    });

    const dailyFigOp = PROBE_OPS.find(
      (op) => op.operation === "getDailyFiguresByCustomer",
    )!;
    expect(dailyFigOp.wireContentType).toBe("application/json");
    expect(
      JSON.parse(buildJsonProbeBody(dailyFigOp, "MILLER500", "H1716")),
    ).toEqual({
      agentID: "MILLER500",
      customerID: "H1716",
      week: "__WEEK__",
      operation: "getDailyFiguresByCustomer",
    });
  });

  test("validates the page result before it is treated as evidence", () => {
    const ok = {
      status: 200,
      contentType: "application/json",
      bytes: 12,
      preview: "{}",
    };
    // The parser normalizes the payload kind: text results carry isBinary: false.
    expect(parseProbePageResult(ok)).toEqual({ ...ok, isBinary: false });
    expect(() => parseProbePageResult(null)).toThrow("no object");
    expect(() => parseProbePageResult({ ...ok, status: 0 })).toThrow("status");
    expect(() => parseProbePageResult({ ...ok, bytes: -1 })).toThrow(
      "byte count",
    );
    expect(() => parseProbePageResult({ ...ok, preview: 1 })).toThrow(
      "preview",
    );
  });

  test("classifies statuses with the same vocabulary the plan uses", () => {
    expect(probeVerdict(200)).toBe("exists");
    expect(probeVerdict(401)).toBe("denied");
    expect(probeVerdict(403)).toBe("denied");
    expect(probeVerdict(404)).toBe("missing");
    expect(probeVerdict(405)).toBe("missing");
    expect(probeVerdict(500)).toBe("error");
    expect(
      probeSummary(PROBE_OPS[0]!, {
        status: 404,
        contentType: "text/html",
        bytes: 0,
        preview: "",
        isBinary: false,
      }),
    ).toEqual({
      operation: "Pending",
      verdict: "missing",
      status: 404,
      bytes: 0,
    });
  });
});

describe("probe expression", () => {
  test("resolves markers in-page and sends the bearer", () => {
    const expression = buildProbeExpression({
      operation: "getTransactions",
      url: "https://fantasy402.com/cloud/api/Report/getTransactions",
      body: "customerID=__CUSTOMER_ID__&date=__DATE__&token=&operation=getTransactions",
    });
    expect(expression).toContain('replaceAll("__CUSTOMER_ID__"');
    expect(expression).toContain('replaceAll("__DATE__"');
    expect(expression).toContain('authorization = "Bearer " + token');
    expect(expression).toContain("sessionStorage.getItem");
    expect(expression).toContain('sessionStorage.getItem("customerID")');
    // The markers are plain text so URL encoding cannot turn them into %7B…%7D.
    expect(expression).not.toContain("%7B");
  });

  test("supports contentType: application/json without URL-encoding JSON string values", () => {
    const expression = buildProbeExpression({
      operation: "getAccountInfoOwner",
      url: "https://fantasy402.com/cloud/api/Manager/getAccountInfoOwner",
      body: '{"agentID":"MILLER500","operation":"getAccountInfoOwner"}',
      contentType: "application/json",
    });
    expect(expression).toContain('"content-type": "application/json"');
    expect(expression).toContain('.replaceAll("__CUSTOMER_ID__", customerID)');
  });

  test("a supplied week value overrides the default week index", () => {
    const expression = buildProbeExpression(
      {
        operation: "getDailyFiguresByCustomer",
        url: "https://fantasy402.com/cloud/api/Report/getDailyFiguresByCustomer",
        body: "agentID=1&customerID=__CUSTOMER_ID__&week=__WEEK__&token=&operation=getDailyFiguresByCustomer",
      },
      2_000,
      "3",
    );
    // The override is carried into the page as a JSON string (never interpolated raw).
    expect(expression).toContain('const weekOverride = "3";');
    expect(expression).toContain(
      'replaceAll("__WEEK__", encodeURIComponent(weekValueResolved))',
    );
    // The default (yesterday's date) is still computed for the __DATE__ marker.
    expect(expression).toContain("const mdy =");
  });

  test("wraps binary responses in a Blob instead of decoding garbage", () => {
    const expression = buildProbeExpression({
      operation: "getTicketDetailPrint",
      url: "https://fantasy402.com/cloud/api/Report/getTicketDetailPrint",
      body: "token=&operation=getTicketDetailPrint",
    });
    expect(expression).toContain("new Blob([buffer]");
    expect(expression).toContain("isBinaryResp");
    expect(expression).toContain("isBinary: isBinaryResp");
    expect(expression).toContain("blobType: blobTypeOut");
    expect(expression).toContain("blobSize: blobSizeOut");
  });

  test("parseProbePageResult accepts Cloudflare challenge metadata", () => {
    const parsed = parseProbePageResult({
      status: 500,
      contentType: "text/html",
      bytes: 0,
      preview: "",
      challengePresent: true,
      cfRay: "a537f5fb4a4da5da-LAX",
    });
    expect(parsed.challengePresent).toBe(true);
    expect(parsed.cfRay).toBe("a537f5fb4a4da5da-LAX");
  });

  test("probe expression reads __CF$cv$params and cf-ray header", () => {
    const expression = buildProbeExpression({
      operation: "Pending",
      url: "https://fantasy402.com/cloud/api/Report/Pending",
      body: "operation=Pending",
    });
    expect(expression).toContain("__CF$cv$params");
    expect(expression).toContain("/cdn-cgi/");
    expect(expression).toContain('"cf-cache-status"');
    expect(expression).toContain('responseHeaders["cf-ray"]');
    expect(expression).toContain("sessionCustomerPresent");
    expect(expression).toContain("sessionCredentialsCodePresent");
    expect(expression).toContain("encodeURIComponent(token)");
  });

  test("old results without blob metadata parse as text", () => {
    const parsed = parseProbePageResult({
      status: 200,
      contentType: "application/json",
      bytes: 12,
      preview: "{}",
    });
    expect(parsed.isBinary).toBe(false);
    expect("blobType" in parsed).toBe(false);
  });

  test("a binary result without blob fields is rejected", () => {
    expect(() =>
      parseProbePageResult({
        status: 200,
        contentType: "image/png",
        bytes: 10,
        preview: "",
        isBinary: true,
      }),
    ).toThrow("blob type");
  });

  test("accepts blob metadata on the page result", () => {
    const parsed = parseProbePageResult({
      status: 200,
      contentType: "image/png",
      bytes: 1536,
      preview: "",
      bodyText: "",
      isBinary: true,
      blobType: "image/png",
      blobSize: 1536,
    });
    expect(parsed.isBinary).toBe(true);
    if (parsed.isBinary !== true) throw new Error("expected binary variant");
    expect(parsed.blobType).toBe("image/png");
    expect(parsed.blobSize).toBe(1536);
  });

  test("an empty week value keeps the default '0' index", () => {
    const expression = buildProbeExpression(
      {
        operation: "getDailyFiguresByCustomer",
        url: "https://fantasy402.com/cloud/api/Report/getDailyFiguresByCustomer",
        body: "week=__WEEK__&token=&operation=getDailyFiguresByCustomer",
      },
      2_000,
      undefined,
    );
    expect(expression).toContain('const weekOverride = "";');
  });
});

describe("request sniffer", () => {
  test("installs XHR and fetch hooks scoped to /cloud/api/", () => {
    const expression = buildInstallRequestSnifferExpression();
    expect(expression).toContain("/cdn-cgi/");
    expect(expression).toContain("XMLHttpRequest.prototype");
    expect(expression).toContain("window.fetch");
    expect(expression).toContain("/cloud/api/");
    // Only parameter names are recorded, never values.
    expect(expression).toContain("formKeys");
  });

  test("reads back the sniffed array", () => {
    expect(buildReadRequestSnifferExpression()).toContain(
      "__f402SniffedRequests",
    );
  });

  test("parseSniffedTemplates dedupes by path, method and sorted keys", () => {
    const parsed = parseSniffedTemplates([
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "post",
        formKeys: ["agentID", "RRO"],
      },
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "POST",
        formKeys: ["RRO", "agentID"],
      },
      { path: "not-a-path", method: "POST", formKeys: [] },
      { path: "/cloud/api/Manager/x", method: "POST", formKeys: [1] },
    ]);
    expect(parsed).toEqual([
      {
        path: "/cloud/api/Manager/getInfoPlayer",
        method: "POST",
        formKeys: ["RRO", "agentID"],
      },
    ]);
  });
});
