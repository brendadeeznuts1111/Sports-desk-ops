import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  formatStandaloneMcpHelp,
  parseSportsdeskMcpCliArgs,
  startStandaloneMcpServer,
  type StandaloneMcpServerHandle,
} from "../cli/sportsdesk_mcp_cli.ts";
import {
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  encodeBridgeChannelPackedWord32,
  type ExtendedSignalChannelCode,
} from "../lib/bridge_and_channel_router.ts";
import {
  OriginDomainWireId,
  WriterLaneWireId,
  originDomainIdOfWireId,
  writerLaneIdOfWireId,
} from "../lib/domain-enums.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  SENTINEL_CHANNEL_REGISTRY,
  WRITER_LANE_REGISTRY,
} from "../lib/domain_venue_registry.ts";
import {
  NSH_MESSAGE_TYPE,
  packNshBinaryFrame,
} from "../lib/nsh_frame_codec.ts";
import {
  PROVENANCE_BY_CHANNEL_ORDINAL,
  auditNamingConstitutionCompliance,
} from "../lib/nsh_frame_schema.ts";
import { provenanceCssFor } from "../lib/provenance_palette.ts";
import { auditSourceCodeNamingCompliance } from "../lib/specification_naming_police.ts";
import {
  NSH_FRAME_SLIPPAGE_U8_MAX,
  SOR1_MAX_SLIPPAGE_BPS,
  SOR_DEFAULT_SOFT_LIMIT_BPS,
  SPORTSDESK_MCP_SERVER_NAME,
  createSportsdeskMcpHttpHandler,
  runCheckSorSlippageTool,
  runDecodeNshFrameTool,
  runGetActiveBetBlotterTool,
  runGetBridgeChannelCatalogTool,
  runGetChannelProvenanceTool,
  runGetLiveLineTradingBoardTool,
  runGetTradingDeskKpisAndSportTreeTool,
  verifyMcpBearerAuth,
} from "../lib/sportsdesk_mcp_server.ts";
import { createDashboardApi } from "../packages/api/src/router.ts";
import type { DashboardApiDeps } from "../packages/api/src/types.ts";
import type { WsLike } from "../packages/api/src/ws.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

const TEST_ADMIN_TOKEN = "mcp-unit-test-bearer-secret-4020";

const activeCleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (activeCleanupTasks.length > 0) {
    const fn = activeCleanupTasks.pop();
    if (fn) {
      await fn();
    }
  }
});

type AnyToolCallResult =
  CallToolResult | Awaited<ReturnType<Client["callTool"]>>;

function extractStructured<T>(result: AnyToolCallResult): T {
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) {
    return record.structuredContent as T;
  }
  const content = Array.isArray(record.content)
    ? (record.content as Array<{ type?: string; text?: string }>)
    : [];
  const firstText = content.find((c) => c.type === "text")?.text;
  if (!firstText) {
    throw new Error("Expected structuredContent or JSON text block");
  }
  return JSON.parse(firstText) as T;
}

function extractErrorJson(result: CallToolResult): {
  ok: boolean;
  errorCode: string;
  message: string;
} {
  expect(result.isError).toBe(true);
  const firstText = result.content.find((c) => c.type === "text");
  const raw =
    firstText && "text" in firstText && typeof firstText.text === "string"
      ? firstText.text
      : "";
  return JSON.parse(raw) as {
    ok: boolean;
    errorCode: string;
    message: string;
  };
}

describe("Naming Constitution compliance", () => {
  test("lib/sportsdesk_mcp_server.ts and cli/sportsdesk_mcp_cli.ts have zero naming violations", async () => {
    const serverSource = await Bun.file(
      new URL("../lib/sportsdesk_mcp_server.ts", import.meta.url),
    ).text();
    const cliSource = await Bun.file(
      new URL("../cli/sportsdesk_mcp_cli.ts", import.meta.url),
    ).text();

    expect(() =>
      auditNamingConstitutionCompliance(
        serverSource,
        "lib/sportsdesk_mcp_server.ts",
      ),
    ).not.toThrow();
    expect(() =>
      auditNamingConstitutionCompliance(cliSource, "cli/sportsdesk_mcp_cli.ts"),
    ).not.toThrow();
    expect(() =>
      auditSourceCodeNamingCompliance(
        serverSource,
        "lib/sportsdesk_mcp_server.ts",
      ),
    ).not.toThrow();
    expect(() =>
      auditSourceCodeNamingCompliance(cliSource, "cli/sportsdesk_mcp_cli.ts"),
    ).not.toThrow();
  });
});

describe("MCP Bearer authentication & HTTP security boundary", () => {
  test("verifyMcpBearerAuth enforces constant-time token check and 503/401 semantics", () => {
    const authedReq = new Request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(verifyMcpBearerAuth(authedReq, undefined)).toEqual({
      ok: false,
      status: 503,
      code: -32000,
      message: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    });

    expect(verifyMcpBearerAuth(authedReq, "   ")).toEqual({
      ok: false,
      status: 503,
      code: -32000,
      message: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    });

    const missingReq = new Request("http://127.0.0.1:4021/mcp", {
      method: "POST",
    });
    expect(verifyMcpBearerAuth(missingReq, TEST_ADMIN_TOKEN)).toEqual({
      ok: false,
      status: 401,
      code: -32000,
      message: "Missing or malformed Authorization: Bearer <token> header",
    });

    const basicReq = new Request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: { Authorization: `Basic ${TEST_ADMIN_TOKEN}` },
    });
    expect(verifyMcpBearerAuth(basicReq, TEST_ADMIN_TOKEN).ok).toBe(false);

    const wrongTokenReq = new Request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token-value" },
    });
    expect(verifyMcpBearerAuth(wrongTokenReq, TEST_ADMIN_TOKEN)).toEqual({
      ok: false,
      status: 401,
      code: -32000,
      message: "Invalid bearer token",
    });

    expect(verifyMcpBearerAuth(authedReq, TEST_ADMIN_TOKEN)).toEqual({
      ok: true,
    });
  });

  test("HTTP handler enforces CORS preflight, WWW-Authenticate on 401, and 405 Method Not Allowed", async () => {
    const handler = createSportsdeskMcpHttpHandler({
      stateless: true,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
      allowedOrigins: ["https://ops.example.test"],
    });
    activeCleanupTasks.push(() => handler.closeAll());

    const optionsRes = await handler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://ops.example.test" },
      }),
    );
    expect(optionsRes.status).toBe(204);
    expect(optionsRes.headers.get("access-control-allow-origin")).toBe(
      "https://ops.example.test",
    );
    expect(optionsRes.headers.get("access-control-expose-headers")).toContain(
      "Mcp-Session-Id",
    );

    const untrustedOriginRes = await handler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.test" },
      }),
    );
    expect(untrustedOriginRes.status).toBe(204);
    expect(
      untrustedOriginRes.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const unauthRes = await handler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", { method: "POST" }),
    );
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers.get("www-authenticate")).toContain("Bearer");

    const methodRes = await handler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(methodRes.status).toBe(405);
    expect(methodRes.headers.get("allow")).toBe("POST");

    const statefulHandler = createSportsdeskMcpHttpHandler({
      stateless: false,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
      allowedOrigins: ["https://ops.example.test"],
    });
    activeCleanupTasks.push(() => statefulHandler.closeAll());

    const statefulPutRes = await statefulHandler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(statefulPutRes.status).toBe(405);
    expect(statefulPutRes.headers.get("allow")).toBe("GET, POST, DELETE");

    // Non-allowlisted cross-origin POST is rejected with 403 even with a valid token
    const badOriginPost = await statefulHandler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(badOriginPost.status).toBe(403);

    // Unauthenticated loopback mode (--no-auth) blocks DNS rebinding Host and cross-origin Origin
    const noAuthHandler = createSportsdeskMcpHttpHandler({
      stateless: true,
      requireAuth: false,
    });
    activeCleanupTasks.push(() => noAuthHandler.closeAll());

    const dnsRebindRes = await noAuthHandler.handleRequest(
      new Request("http://attacker.rebind.test:4021/mcp", {
        method: "POST",
        headers: {
          Host: "attacker.rebind.test:4021",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(dnsRebindRes.status).toBe(403);

    const crossOriginNoAuthRes = await noAuthHandler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:4021",
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(crossOriginNoAuthRes.status).toBe(403);
  });
});

describe("Direct TypeScript spine MCP tools (unit & edge cases)", () => {
  test("get_channel_provenance resolves palette colors, writer lanes, and malformed inputs", () => {
    const gsliveColorCss = extractStructured<{
      matchedChannel: { colorHexInt: number; colorCss: string } | null;
    }>(runGetChannelProvenanceTool({ channelCode: "GSLIVE" }));
    expect(gsliveColorCss.matchedChannel).not.toBeNull();
    const expectedHexInt = gsliveColorCss.matchedChannel!.colorHexInt;
    const expectedCss = gsliveColorCss.matchedChannel!.colorCss;

    const full = extractStructured<{
      channels: Array<{
        channelCode: string;
        colorHexInt: number;
        slaKind: string;
      }>;
      matchedChannel: { channelCode: string } | null;
      writerResolution: {
        writerLaneId: string | null;
        writerChannelId: string;
        provenanceLabel: string;
        venueId: string;
      } | null;
      colorLookup: {
        colorHexInt: number;
        colorCss: string;
        matchedChannelCode: string | null;
      } | null;
      originDomains: Array<{ originDomainId: string }>;
    }>(
      runGetChannelProvenanceTool({
        writer: "partner118",
        color: expectedCss,
      }),
    );

    expect(full.channels).toHaveLength(11);
    expect(full.writerResolution?.writerLaneId).toBe("gslive");
    expect(full.writerResolution?.provenanceLabel).toBe("GSLIVE");
    expect(full.writerResolution?.venueId).toBe("gslive_partner118");
    expect(full.colorLookup).toEqual({
      colorHexInt: expectedHexInt,
      colorCss: expectedCss,
      matchedChannelCode: "GSLIVE",
    });
    expect(full.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(full.originDomains.length).toBeGreaterThanOrEqual(4);

    const unknownColor = extractStructured<{
      colorLookup: { matchedChannelCode: string | null } | null;
    }>(runGetChannelProvenanceTool({ color: 0x123456 }));
    expect(unknownColor.colorLookup?.matchedChannelCode).toBeNull();

    const badColor = extractErrorJson(
      runGetChannelProvenanceTool({ color: "#not-hex" }),
    );
    expect(badColor.ok).toBe(false);
    expect(badColor.errorCode).toBe("invalid_provenance_query");
  });

  test("get_bridge_channel_catalog inspects 10 bridges, 16 channels, route bitmasks, demux, and sentinel errors", () => {
    const word = encodeBridgeChannelPackedWord32(
      "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
      "GSLIVE",
    );

    const catalog = extractStructured<{
      bridges: Array<{ bridgeId: string; permittedChannels: string[] }>;
      channels: Array<{ channelCode: string; permittedBridges: string[] }>;
      decodedWord: {
        bridgeOrdinal4: number;
        channelOrdinal5: number;
      } | null;
      demuxedEnvelope: {
        channelCode: string;
        canonicalVolumeCents: number;
      } | null;
    }>(
      runGetBridgeChannelCatalogTool({
        packedRouteWord32: word as number,
        envelope: {
          transportBridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
          amountWageredCents: 25_000,
          ticketWriterToken: "GSLIVE",
          wagerTypeCode: "M",
          rawBoardRotationNumber: 501,
        },
      }),
    );

    expect(catalog.bridges).toHaveLength(10);
    expect(catalog.channels).toHaveLength(16);
    expect(catalog.decodedWord?.bridgeOrdinal4).toBe(3);
    expect(catalog.demuxedEnvelope?.channelCode).toBe("GSLIVE");
    expect(catalog.demuxedEnvelope?.canonicalVolumeCents).toBe(25_000);

    const forbidden = extractStructured<{
      routeCheck: {
        bridgeId: string;
        channelCode: string;
        permitted: boolean;
        packedRouteWord32: number | null;
        routeMetadata: unknown;
      } | null;
    }>(
      runGetBridgeChannelCatalogTool({
        bridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
        channelCode: "CSLEVEL2",
      }),
    );
    expect(forbidden.routeCheck).toEqual({
      bridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
      channelCode: "CSLEVEL2",
      permitted: false,
      packedRouteWord32: null,
      routeMetadata: null,
    });

    const sentinelErr = extractErrorJson(
      runGetBridgeChannelCatalogTool({ packedRouteWord32: 0xffffffff }),
    );
    expect(sentinelErr.errorCode).toBe("invalid_channel_id");

    const gateErr = extractErrorJson(
      runGetBridgeChannelCatalogTool({
        envelope: {
          transportBridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
          amountWageredCents: 10_000,
          ticketWriterToken: "GSLIVE",
          rawBoardRotationNumber: 2_000_000,
        },
      }),
    );
    expect(gateErr.errorCode).toBe("GATE_03_SEC_ROTATION_20BIT_NON_ALIASING");

    const bitmaskGateErr = extractErrorJson(
      runGetBridgeChannelCatalogTool({
        envelope: {
          transportBridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
          amountWageredCents: 10_000,
          ticketWriterToken: "Internet",
        },
      }),
    );
    expect(bitmaskGateErr.errorCode).toMatch(/^GATE_0/);
  });

  test("check_sor_slippage enforces sport tiers, SOR-1 200 bps ceiling, NSH u8 max, and ask-book walks", () => {
    const nbaPass = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      tierMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
      sor1Compliant: boolean;
      fitsNshFrameU8: boolean;
    }>(runCheckSorSlippageTool({ league: "NBA", slippageBps: 120 }, {}));
    expect(nbaPass.allowed).toBe(true);
    expect(nbaPass.blockReason).toBeNull();
    expect(nbaPass.tierMaxSlippageBps).toBe(150);
    expect(nbaPass.effectiveMaxSlippageBps).toBe(150);
    expect(nbaPass.sor1Compliant).toBe(true);
    expect(nbaPass.fitsNshFrameU8).toBe(true);

    // CFB tier allows 300 bps, but SOR-1 caps at 200 bps by default.
    const cfbSor1Blocked = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      tierMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
      sor1Compliant: boolean;
      fitsNshFrameU8: boolean;
    }>(runCheckSorSlippageTool({ league: "CFB", slippageBps: 240 }, {}));
    expect(cfbSor1Blocked.allowed).toBe(false);
    expect(cfbSor1Blocked.blockReason).toBe("exceeds_sor1_ceiling");
    expect(cfbSor1Blocked.tierMaxSlippageBps).toBe(300);
    expect(cfbSor1Blocked.effectiveMaxSlippageBps).toBe(SOR1_MAX_SLIPPAGE_BPS);
    expect(cfbSor1Blocked.sor1Compliant).toBe(false);
    expect(cfbSor1Blocked.fitsNshFrameU8).toBe(true);

    // Even when SOR-1 ceiling is relaxed, >255 bps overflows the NSH u8 slot.
    const cfbU8Overflow = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      fitsNshFrameU8: boolean;
    }>(
      runCheckSorSlippageTool(
        {
          league: "CFB",
          slippageBps: NSH_FRAME_SLIPPAGE_U8_MAX + 10,
          enforceSor1Ceiling: false,
        },
        {},
      ),
    );
    expect(cfbU8Overflow.allowed).toBe(false);
    expect(cfbU8Overflow.blockReason).toBe("exceeds_nsh_frame_u8");
    expect(cfbU8Overflow.fitsNshFrameU8).toBe(false);

    // Ask-book walk: deep book passes, thin book fails with insufficient_depth, empty book fails with no_book.
    const deepWalk = extractStructured<{
      allowed: boolean;
      observedSlippageBps: number;
      bookWalk: { fullyCovered: boolean; contracts: number } | null;
    }>(
      runCheckSorSlippageTool(
        {
          league: "NFL",
          budgetUsd: 500,
          asks: [
            { price: 0.5, size: 800 },
            { price: 0.505, size: 800 },
          ],
        },
        {},
      ),
    );
    expect(deepWalk.allowed).toBe(true);
    expect(deepWalk.bookWalk?.fullyCovered).toBe(true);
    expect(deepWalk.observedSlippageBps).toBeLessThanOrEqual(100);

    const thinWalk = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      bookWalk: { fullyCovered: boolean } | null;
    }>(
      runCheckSorSlippageTool(
        {
          league: "NFL",
          budgetUsd: 1_000,
          asks: [{ price: 0.5, size: 100 }],
        },
        {},
      ),
    );
    expect(thinWalk.allowed).toBe(false);
    expect(thinWalk.blockReason).toBe("insufficient_depth");
    expect(thinWalk.bookWalk?.fullyCovered).toBe(false);

    const emptyBook = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
    }>(
      runCheckSorSlippageTool({ league: "NBA", budgetUsd: 100, asks: [] }, {}),
    );
    expect(emptyBook.allowed).toBe(false);
    expect(emptyBook.blockReason).toBe("no_book");

    const missingInput = extractErrorJson(
      runCheckSorSlippageTool({ league: "NBA" }, {}),
    );
    expect(missingInput.errorCode).toBe("missing_slippage_input");

    // Fractional negative (-0.4) fails closed with negative_slippage_invalid (-1, never -0)
    const negFractional = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      observedSlippageBps: number;
    }>(runCheckSorSlippageTool({ league: "CFB", slippageBps: -0.4 }, {}));
    expect(negFractional.allowed).toBe(false);
    expect(negFractional.blockReason).toBe("negative_slippage_invalid");
    expect(negFractional.observedSlippageBps).toBe(-1);

    // Fractional over-ceiling (200.4 > 200) fails closed via ceiling quantization (201)
    const overCeilingFractional = extractStructured<{
      allowed: boolean;
      blockReason: string | null;
      observedSlippageBps: number;
      sor1Compliant: boolean;
    }>(runCheckSorSlippageTool({ league: "CFB", slippageBps: 200.4 }, {}));
    expect(overCeilingFractional.allowed).toBe(false);
    expect(overCeilingFractional.blockReason).toBe("exceeds_sor1_ceiling");
    expect(overCeilingFractional.observedSlippageBps).toBe(201);
    expect(overCeilingFractional.sor1Compliant).toBe(false);
  });

  test("decode_nsh_frame decodes 64B hex & base64 frames with u64 precision and rejects corrupt frames", () => {
    const maxU64 = 0xffffffffffffffffn;
    const raw = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.TICKER_MATCH,
      channelId: 5,
      slaDivide10Ms: 25,
      rowIndex: 42_424,
      betGroupId: maxU64,
      stakeUsdc: 1250.5,
      bookOdds: 1.91,
      polyAvgPrice: 0.52,
      liabilityDelta: -640.25,
      timestampMs: 1_762_992_000_000,
      originDomainWireId: OriginDomainWireId.GSLIVE_118,
      writerLaneWireId: WriterLaneWireId.GSLIVE,
      flags: 0x0003,
      slippageBps: 85,
    });

    const hexPayload = `0x${Buffer.from(raw).toString("hex")}`;
    const b64Payload = Buffer.from(raw).toString("base64");

    const decodedHex = extractStructured<{
      byteLength: number;
      messageTypeName: string;
      betGroupId: string;
      betGroupTag: string;
      originDomainWireId: number;
      originDomainId: string;
      writerLaneWireId: number;
      writerLaneId: string | null;
      writerChannelId: string;
      slippageBps: number;
      sor1Compliant: boolean;
      handle: {
        channelId4: number;
        slaDivide10Ms8: number;
        slaMs: number;
        rowIndex20: number;
      };
    }>(runDecodeNshFrameTool({ payload: hexPayload }));

    expect(decodedHex.byteLength).toBe(64);
    expect(decodedHex.messageTypeName).toBe("TICKER_MATCH");
    expect(decodedHex.betGroupId).toBe("18446744073709551615");
    expect(decodedHex.betGroupTag).toBe("M.G18446744073709551615");
    expect(decodedHex.originDomainWireId).toBe(OriginDomainWireId.GSLIVE_118);
    expect(decodedHex.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    );
    expect(decodedHex.writerLaneWireId).toBe(WriterLaneWireId.GSLIVE);
    expect(decodedHex.writerLaneId).toBe("gslive");
    expect(decodedHex.slippageBps).toBe(85);
    expect(decodedHex.sor1Compliant).toBe(true);
    expect(decodedHex.handle).toEqual({
      channelId4: 5,
      slaDivide10Ms8: 25,
      slaMs: 250,
      rowIndex20: 42_424,
    });

    const decodedB64 = extractStructured<{
      betGroupId: string;
      originDomainId: string;
      writerChannelId: string;
    }>(runDecodeNshFrameTool({ payload: b64Payload }));
    expect(decodedB64.betGroupId).toBe("18446744073709551615");
    expect(decodedB64.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    );
    expect(decodedB64.writerChannelId).toBe("gslive");

    // 63B short frame
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({
          payload: Buffer.from(raw.subarray(0, 63)).toString("hex"),
        }),
      ).errorCode,
    ).toBe("short_frame");

    // 65B oversized frame
    const oversized = new Uint8Array(65);
    oversized.set(raw, 0);
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({
          payload: Buffer.from(oversized).toString("hex"),
        }),
      ).errorCode,
    ).toBe("oversized_frame");

    // Corrupt magic byte
    const badMagic = new Uint8Array(raw);
    badMagic[0] = 0x00;
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({
          payload: Buffer.from(badMagic).toString("hex"),
        }),
      ).errorCode,
    ).toBe("invalid_magic");

    // Deprecated v5 version byte
    const badVersion = new Uint8Array(raw);
    badVersion[1] = 0x05;
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({
          payload: Buffer.from(badVersion).toString("hex"),
        }),
      ).errorCode,
    ).toBe("invalid_version");

    // Non-zero reserved byte at offset 62
    const dirtyReserved = new Uint8Array(raw);
    dirtyReserved[62] = 0x01;
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({
          payload: Buffer.from(dirtyReserved).toString("hex"),
        }),
      ).errorCode,
    ).toBe("invalid_reserved");

    // Malformed odd-length hex
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({ payload: "0xabc", encoding: "hex" }),
      ).errorCode,
    ).toBe("invalid_encoding");

    // Malformed length-3 padded base64 ("AA=")
    expect(
      extractErrorJson(
        runDecodeNshFrameTool({ payload: "AA=", encoding: "base64" }),
      ).errorCode,
    ).toBe("invalid_encoding");

    // Unpadded 86-char base64url valid frame auto-detects and decodes cleanly
    const b64UrlPayload = Buffer.from(raw).toString("base64url");
    expect(b64UrlPayload).toHaveLength(86);
    const decodedB64Url = extractStructured<{
      byteLength: number;
      betGroupId: string;
    }>(runDecodeNshFrameTool({ payload: b64UrlPayload }));
    expect(decodedB64Url.byteLength).toBe(64);
    expect(decodedB64Url.betGroupId).toBe("18446744073709551615");

    // Unpadded 86-char base64url whose characters happen to be [0-9a-fA-F] ("A" * 86 = 64 zero bytes)
    // is decoded as 64B base64 (invalid_magic), not 43B hex (short_frame)
    const hexAlphabetB64Url = "A".repeat(86);
    expect(hexAlphabetB64Url).toHaveLength(86);
    expect(/^[0-9a-fA-F]+$/.test(hexAlphabetB64Url)).toBe(true);
    expect(
      extractErrorJson(runDecodeNshFrameTool({ payload: hexAlphabetB64Url }))
        .errorCode,
    ).toBe("invalid_magic");

    // Valid frame with Number.MAX_SAFE_INTEGER timestampMs (> ECMA Date max 8.64e15) returns timestampIso: null instead of RangeError
    const maxSafeTsFrame = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.TICKER_MATCH,
      channelId: 5,
      slaDivide10Ms: 25,
      rowIndex: 1,
      betGroupId: 42n,
      stakeUsdc: 100,
      bookOdds: 2.0,
      polyAvgPrice: 0.5,
      liabilityDelta: 50,
      timestampMs: Number.MAX_SAFE_INTEGER,
      originDomainWireId: OriginDomainWireId.GSLIVE_118,
      writerLaneWireId: WriterLaneWireId.GSLIVE,
      flags: 0,
      slippageBps: 10,
    });
    const decodedMaxTs = extractStructured<{
      timestampMs: number;
      timestampIso: string | null;
    }>(
      runDecodeNshFrameTool({
        payload: Buffer.from(maxSafeTsFrame).toString("hex"),
      }),
    );
    expect(decodedMaxTs.timestampMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodedMaxTs.timestampIso).toBeNull();
  });

  test("get_channel_provenance resolves 4-bit channelOrdinal 0..15, 16 ExtendedSignalChannelCode values, and bridgeOrdinal 0..9", () => {
    type ProvenancePayload = {
      channels: Array<{ channelCode: string; colorHexInt: number }>;
      matchedChannel: {
        channelCode: string;
        colorHexInt: number;
        colorCss: string;
      } | null;
      routingChannel: {
        channelOrdinal: number;
        channelCode: ExtendedSignalChannelCode;
        provenanceChannelCode: string;
        colorHexInt: number;
        colorCss: string;
        neuronTokenIdentifier: string;
        permittedBridges: string[];
        permittedOriginDomains: Array<{
          originDomainId: string;
          venueId: string;
          brandColorHex: string;
        }>;
      } | null;
      bridgeResolution: {
        bridgeOrdinal: number;
        bridgeId: string;
        originDomainId: string;
        venueId: string;
        sourceBridgePrefix: string;
        bridgeQualifiedChannelCode: string | null;
        packedRouteWord32: number | null;
      } | null;
      resolvedOriginDomain: {
        originDomainId: string;
        venueId: string;
        brandColorHex: string;
      } | null;
    };

    // Empty query returns full 11-entry ingestion palette and null per-query resolutions
    const empty = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({}),
    );
    expect(empty.channels).toHaveLength(11);
    expect(empty.matchedChannel).toBeNull();
    expect(empty.routingChannel).toBeNull();
    expect(empty.bridgeResolution).toBeNull();
    expect(empty.resolvedOriginDomain).toBeNull();

    // Turn 1 examples: ordinal 5 -> GSLIVE, ordinal 7 -> LIVE_CWS -> GSLIVE, ordinal 14 -> CROSS_VENUE_RFQ_COMBO_LAYOFF -> GSLIVE
    const ord5 = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 5 }),
    );
    expect(ord5.routingChannel?.channelOrdinal).toBe(5);
    expect(ord5.routingChannel?.channelCode).toBe("GSLIVE");
    expect(ord5.routingChannel?.provenanceChannelCode).toBe("GSLIVE");
    expect(ord5.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(ord5.routingChannel?.colorCss).toBe(ord5.matchedChannel?.colorCss);
    expect(
      ord5.routingChannel?.permittedOriginDomains.map((d) => d.originDomainId),
    ).toEqual([
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      "ORIGIN_SPORTSBOOK_FANTASY402",
    ]);
    // Multi-origin channel without bridgeOrdinal leaves resolvedOriginDomain null
    expect(ord5.resolvedOriginDomain).toBeNull();

    const ord7 = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 7 }),
    );
    expect(ord7.routingChannel?.channelOrdinal).toBe(7);
    expect(ord7.routingChannel?.channelCode).toBe("LIVE_CWS");
    expect(ord7.routingChannel?.provenanceChannelCode).toBe("GSLIVE");
    expect(ord7.matchedChannel?.channelCode).toBe("GSLIVE");
    // LIVE_CWS only permits F402 bridges (1 and 2) -> unambiguous single origin domain
    expect(ord7.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_FANTASY402",
    );
    expect(ord7.resolvedOriginDomain?.venueId).toBe("f402");

    const ord14 = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 14 }),
    );
    expect(ord14.routingChannel?.channelOrdinal).toBe(14);
    expect(ord14.routingChannel?.channelCode).toBe(
      "CROSS_VENUE_RFQ_COMBO_LAYOFF",
    );
    expect(ord14.routingChannel?.provenanceChannelCode).toBe("GSLIVE");
    expect(ord14.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(
      ord14.routingChannel?.permittedOriginDomains.map((d) => d.originDomainId),
    ).toEqual([
      "ORIGIN_EXCHANGE_POLYMARKET_CTF",
      "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    ]);
    expect(ord14.resolvedOriginDomain).toBeNull();

    // Extended channelCode string lookup matches channelOrdinal lookup
    const byExtendedCode = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({
        channelCode: "CROSS_VENUE_RFQ_COMBO_LAYOFF",
      }),
    );
    expect(byExtendedCode.routingChannel).toEqual(ord14.routingChannel);
    expect(byExtendedCode.matchedChannel).toEqual(ord14.matchedChannel);

    // Exhaustive sweep over all 16 channelOrdinal (0..15) and all 16 ExtendedSignalChannelCode values
    const specsByOrdinal = Object.values(
      SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
    ).sort((a, b) => a.channelOrdinal5 - b.channelOrdinal5);
    expect(specsByOrdinal).toHaveLength(16);

    for (let ordinal = 0; ordinal < 16; ordinal++) {
      const expectedSpec = specsByOrdinal[ordinal]!;
      const expectedProvenance = PROVENANCE_BY_CHANNEL_ORDINAL[ordinal]!;

      const resByOrd = extractStructured<ProvenancePayload>(
        runGetChannelProvenanceTool({ channelOrdinal: ordinal }),
      );
      const resByCode = extractStructured<ProvenancePayload>(
        runGetChannelProvenanceTool({ channelCode: expectedSpec.channelCode }),
      );
      const resConsistentBoth = extractStructured<ProvenancePayload>(
        runGetChannelProvenanceTool({
          channelOrdinal: ordinal,
          channelCode: expectedSpec.channelCode,
        }),
      );

      expect(resByOrd.routingChannel?.channelOrdinal).toBe(ordinal);
      expect(resByOrd.routingChannel?.channelCode).toBe(
        expectedSpec.channelCode,
      );
      expect(resByOrd.routingChannel?.provenanceChannelCode).toBe(
        expectedProvenance,
      );
      expect(resByOrd.matchedChannel?.channelCode).toBe(expectedProvenance);
      expect(resByOrd.channels).toHaveLength(1);
      expect(resByOrd.channels[0]?.channelCode).toBe(expectedProvenance);
      expect(resByCode.routingChannel).toEqual(resByOrd.routingChannel);
      expect(resConsistentBoth.routingChannel).toEqual(resByOrd.routingChannel);
    }

    // Bridge-pinned origin resolution: ordinal 14 + bridgeOrdinal 9 (Kalshi) vs bridgeOrdinal 6 (Polymarket)
    const ord14Kalshi = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 14, bridgeOrdinal: 9 }),
    );
    expect(ord14Kalshi.bridgeResolution).toMatchObject({
      bridgeOrdinal: 9,
      bridgeId: "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM",
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      venueId: "kalshi",
      sourceBridgePrefix: "KALSHI_REGULATED",
      bridgeQualifiedChannelCode:
        "KALSHI_REGULATED_CROSS_VENUE_RFQ_COMBO_LAYOFF",
    });
    expect(ord14Kalshi.bridgeResolution?.packedRouteWord32).toBeNumber();
    expect(ord14Kalshi.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    );

    const ord5Partner118 = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 5, bridgeOrdinal: 3 }),
    );
    expect(ord5Partner118.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    );
    expect(ord5Partner118.bridgeResolution?.bridgeQualifiedChannelCode).toBe(
      "PARTNER_118_GSLIVE",
    );

    const ord5F402 = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ channelOrdinal: 5, bridgeOrdinal: 1 }),
    );
    expect(ord5F402.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_FANTASY402",
    );
    expect(ord5F402.bridgeResolution?.bridgeQualifiedChannelCode).toBe(
      "FANTASY_402_GSLIVE",
    );

    // Standalone bridgeOrdinal without channelOrdinal/channelCode resolves bridge origin metadata
    const standaloneBridge = extractStructured<ProvenancePayload>(
      runGetChannelProvenanceTool({ bridgeOrdinal: 0 }),
    );
    expect(standaloneBridge.routingChannel).toBeNull();
    expect(standaloneBridge.bridgeResolution?.bridgeId).toBe(
      "BRIDGE_00_GSLIVE_WAGERS_BY_STATE",
    );
    expect(
      standaloneBridge.bridgeResolution?.bridgeQualifiedChannelCode,
    ).toBeNull();
    expect(standaloneBridge.bridgeResolution?.packedRouteWord32).toBeNull();
    expect(standaloneBridge.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    );

    // Error paths: unpermitted bridge+channel pair, conflicting ordinal+code, and out-of-range ordinals
    const unpermittedSportsbookBridge = extractErrorJson(
      runGetChannelProvenanceTool({ channelOrdinal: 14, bridgeOrdinal: 3 }),
    );
    expect(unpermittedSportsbookBridge.errorCode).toBe("invalid_channel_id");
    expect(unpermittedSportsbookBridge.message).toContain(
      "ERR_BRIDGE_CHANNEL_MISMATCH",
    );

    const unpermittedPmDataBridge = extractErrorJson(
      runGetChannelProvenanceTool({ channelOrdinal: 14, bridgeOrdinal: 8 }),
    );
    expect(unpermittedPmDataBridge.errorCode).toBe("invalid_channel_id");

    const conflictingPair = extractErrorJson(
      runGetChannelProvenanceTool({
        channelOrdinal: 14,
        channelCode: "Internet",
      }),
    );
    expect(conflictingPair.errorCode).toBe("invalid_provenance_query");
    expect(conflictingPair.message).toContain("Conflicting");

    expect(
      extractErrorJson(runGetChannelProvenanceTool({ channelOrdinal: -1 }))
        .errorCode,
    ).toBe("invalid_provenance_query");
    expect(
      extractErrorJson(runGetChannelProvenanceTool({ channelOrdinal: 16 }))
        .errorCode,
    ).toBe("invalid_provenance_query");
    expect(
      extractErrorJson(runGetChannelProvenanceTool({ bridgeOrdinal: -1 }))
        .errorCode,
    ).toBe("invalid_provenance_query");
    expect(
      extractErrorJson(runGetChannelProvenanceTool({ bridgeOrdinal: 10 }))
        .errorCode,
    ).toBe("invalid_provenance_query");
  });

  test("check_sor_slippage incorporates EXECUTION_MAX_SLIPPAGE_BPS policyEnv and 25 bps soft-limit PASS/WARN/REJECT metadata", () => {
    type SorSlippagePayload = {
      allowed: boolean;
      status: "PASS" | "WARN" | "REJECT";
      blockReason: string | null;
      warningReason: string | null;
      observedSlippageBps: number | null;
      softLimitBps: number;
      softLimitExceeded: boolean;
      tierMaxSlippageBps: number;
      policyMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
      tier: {
        minEdgeBps: number;
        maxSlippageBps: number;
        maxOrderUsd: number;
      };
      availableSportTiers: Record<
        string,
        { minEdgeBps: number; maxSlippageBps: number; maxOrderUsd: number }
      >;
      bookWalk: { budgetUsd: number; fullyCovered: boolean } | null;
    };

    expect(SOR_DEFAULT_SOFT_LIMIT_BPS).toBe(25);

    // Boundary checks around the 25 bps default soft limit
    const atZero = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool({ league: "NBA", slippageBps: 0 }, {}),
    );
    expect(atZero.allowed).toBe(true);
    expect(atZero.status).toBe("PASS");
    expect(atZero.softLimitBps).toBe(25);
    expect(atZero.softLimitExceeded).toBe(false);
    expect(atZero.warningReason).toBeNull();
    expect(atZero.policyMaxSlippageBps).toBe(200);

    const atSoftBoundary = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool({ league: "NBA", slippageBps: 25 }, {}),
    );
    expect(atSoftBoundary.allowed).toBe(true);
    expect(atSoftBoundary.status).toBe("PASS");
    expect(atSoftBoundary.softLimitExceeded).toBe(false);
    expect(atSoftBoundary.warningReason).toBeNull();

    // Fractional 25.1 bps quantizes fail-closed to 26 bps -> WARN
    const justOverSoft = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool({ league: "NBA", slippageBps: 25.1 }, {}),
    );
    expect(justOverSoft.observedSlippageBps).toBe(26);
    expect(justOverSoft.allowed).toBe(true);
    expect(justOverSoft.status).toBe("WARN");
    expect(justOverSoft.softLimitExceeded).toBe(true);
    expect(justOverSoft.warningReason).toBe("exceeds_soft_limit");
    expect(justOverSoft.blockReason).toBeNull();

    // Custom softLimitBps override (e.g. 50 bps) allows 40 bps as PASS
    const customSoft = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        { league: "NBA", slippageBps: 40, softLimitBps: 50 },
        {},
      ),
    );
    expect(customSoft.status).toBe("PASS");
    expect(customSoft.softLimitBps).toBe(50);
    expect(customSoft.softLimitExceeded).toBe(false);

    // EXECUTION_MAX_SLIPPAGE_BPS=100 tightens NBA (tier 150 bps) down to effectiveMaxSlippageBps=100
    const policyEnv100 = { EXECUTION_MAX_SLIPPAGE_BPS: "100" };
    const nbaRejectedByGlobalPolicy = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        { league: "NBA", slippageBps: 120 },
        policyEnv100,
      ),
    );
    expect(nbaRejectedByGlobalPolicy.allowed).toBe(false);
    expect(nbaRejectedByGlobalPolicy.status).toBe("REJECT");
    expect(nbaRejectedByGlobalPolicy.blockReason).toBe(
      "slippage_exceeds_policy",
    );
    expect(nbaRejectedByGlobalPolicy.warningReason).toBeNull();
    expect(nbaRejectedByGlobalPolicy.tierMaxSlippageBps).toBe(150);
    expect(nbaRejectedByGlobalPolicy.policyMaxSlippageBps).toBe(100);
    expect(nbaRejectedByGlobalPolicy.effectiveMaxSlippageBps).toBe(100);
    expect(nbaRejectedByGlobalPolicy.softLimitExceeded).toBe(true);

    const nbaWarnUnderGlobalPolicy = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool({ league: "NBA", slippageBps: 90 }, policyEnv100),
    );
    expect(nbaWarnUnderGlobalPolicy.allowed).toBe(true);
    expect(nbaWarnUnderGlobalPolicy.status).toBe("WARN");
    expect(nbaWarnUnderGlobalPolicy.effectiveMaxSlippageBps).toBe(100);

    // Explicit maxSlippageBpsOverride overrides both tier and global policy (while still bounded by SOR-1 unless enforceSor1Ceiling=false)
    const explicitOverride = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        {
          league: "NBA",
          slippageBps: 120,
          maxSlippageBpsOverride: 130,
        },
        policyEnv100,
      ),
    );
    expect(explicitOverride.allowed).toBe(true);
    expect(explicitOverride.status).toBe("WARN");
    expect(explicitOverride.effectiveMaxSlippageBps).toBe(130);

    // EXECUTION_MAX_SLIPPAGE_BPS=250 with enforceSor1Ceiling=false allows CFB (tier 300) up to 250 bps
    const relaxedSor1Policy250 = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        { league: "CFB", slippageBps: 230, enforceSor1Ceiling: false },
        { EXECUTION_MAX_SLIPPAGE_BPS: "250" },
      ),
    );
    expect(relaxedSor1Policy250.allowed).toBe(true);
    expect(relaxedSor1Policy250.status).toBe("WARN");
    expect(relaxedSor1Policy250.policyMaxSlippageBps).toBe(250);
    expect(relaxedSor1Policy250.effectiveMaxSlippageBps).toBe(250);

    // Boundary EXECUTION_MAX_SLIPPAGE_BPS=0 allows 0 bps and rejects 1 bps
    const zeroPolicyPass = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        { league: "NBA", slippageBps: 0 },
        { EXECUTION_MAX_SLIPPAGE_BPS: "0" },
      ),
    );
    expect(zeroPolicyPass.allowed).toBe(true);
    expect(zeroPolicyPass.status).toBe("PASS");
    expect(zeroPolicyPass.effectiveMaxSlippageBps).toBe(0);

    const zeroPolicyReject = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        { league: "NBA", slippageBps: 1 },
        { EXECUTION_MAX_SLIPPAGE_BPS: "0" },
      ),
    );
    expect(zeroPolicyReject.allowed).toBe(false);
    expect(zeroPolicyReject.status).toBe("REJECT");
    expect(zeroPolicyReject.blockReason).toBe("slippage_exceeds_policy");

    // Per-sport env override (EXECUTION_SPORT_NBA_MAX_SLIPPAGE_BPS) and global EXECUTION_MAX_ORDER_USD
    const sportAndOrderEnv = {
      EXECUTION_SPORT_NBA_MAX_SLIPPAGE_BPS: "80",
      EXECUTION_MAX_ORDER_USD: "250",
    };
    const askWalkClamped = extractStructured<SorSlippagePayload>(
      runCheckSorSlippageTool(
        {
          league: "NBA",
          asks: [{ price: 0.5, size: 1_000 }],
        },
        sportAndOrderEnv,
      ),
    );
    expect(askWalkClamped.allowed).toBe(true);
    expect(askWalkClamped.status).toBe("PASS");
    expect(askWalkClamped.availableSportTiers.NBA?.maxSlippageBps).toBe(80);
    expect(askWalkClamped.effectiveMaxSlippageBps).toBe(80);
    expect(askWalkClamped.bookWalk?.budgetUsd).toBe(250);

    // Invalid negative softLimitBps or maxSlippageBpsOverride returns structured error
    expect(
      extractErrorJson(
        runCheckSorSlippageTool(
          { league: "NBA", slippageBps: 10, softLimitBps: -1 },
          {},
        ),
      ).errorCode,
    ).toBe("invalid_slippage_policy");
    expect(
      extractErrorJson(
        runCheckSorSlippageTool(
          { league: "NBA", slippageBps: 10, maxSlippageBpsOverride: -5 },
          {},
        ),
      ).errorCode,
    ).toBe("invalid_slippage_policy");
  });

  test("decode_nsh_frame includes self-contained routing channel, provenance palette, and venue/writer registry metadata across golden fixtures", async () => {
    type EnrichedDecodePayload = {
      handle: {
        channelId4: number;
        slaDivide10Ms8: number;
        slaMs: number;
        rowIndex20: number;
      };
      channelCode: ExtendedSignalChannelCode;
      provenanceChannelCode: string;
      channelColorHexInt: number;
      channelColorCss: string;
      channelNeuronToken: string;
      originDomainId: string;
      venueId: string;
      originBrandColorHex: string;
      originDomain: {
        originDomainId: string;
        venueId: string;
        displayLabel: string;
        brandColorHex: string;
        defaultTokenCode: string;
      };
      writerLaneId: string | null;
      writerChannelId: string;
      writerBrandColorHex: string;
      writerLane: {
        writerLaneId: string;
        originDomainId: string;
        venueId: string;
        tokenProvenanceCode: string;
        provenanceLabel: string;
        brandColorHex: string;
      };
    };

    // Cross-venue frame on channel 14 (CROSS_VENUE_RFQ_COMBO_LAYOFF -> GSLIVE) with Kalshi origin and GSLIVE writer lane
    const crossVenueFrame = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.ORDERBOOK_DELTA,
      channelId: 14,
      slaDivide10Ms: 25,
      rowIndex: 777,
      betGroupId: 123_456n,
      stakeUsdc: 500,
      bookOdds: 2.1,
      polyAvgPrice: 0.48,
      liabilityDelta: -250,
      timestampMs: 1_762_992_000_000,
      originDomainWireId: OriginDomainWireId.KALSHI_REGULATED,
      writerLaneWireId: WriterLaneWireId.GSLIVE,
      flags: 0x0001,
      slippageBps: 18,
    });

    const decodedCrossVenue = extractStructured<EnrichedDecodePayload>(
      runDecodeNshFrameTool({
        payload: Buffer.from(crossVenueFrame).toString("hex"),
      }),
    );
    expect(decodedCrossVenue.handle).toEqual({
      channelId4: 14,
      slaDivide10Ms8: 25,
      slaMs: 250,
      rowIndex20: 777,
    });
    expect(decodedCrossVenue.channelCode).toBe("CROSS_VENUE_RFQ_COMBO_LAYOFF");
    expect(decodedCrossVenue.provenanceChannelCode).toBe("GSLIVE");
    expect(decodedCrossVenue.channelColorCss).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(decodedCrossVenue.channelNeuronToken).toBe(
      SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE.CROSS_VENUE_RFQ_COMBO_LAYOFF
        .neuronTokenIdentifier,
    );
    expect(decodedCrossVenue.venueId).toBe(
      ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED.venueId,
    );
    expect(decodedCrossVenue.originBrandColorHex).toBe(
      ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED.brandColorHex,
    );
    expect(decodedCrossVenue.originDomain).toEqual({
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      venueId: ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED.venueId,
      displayLabel:
        ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED.displayLabel,
      brandColorHex:
        ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED.brandColorHex,
      defaultTokenCode:
        ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_KALSHI_REGULATED
          .defaultTokenCode,
    });
    expect(decodedCrossVenue.writerBrandColorHex).toBe(
      WRITER_LANE_REGISTRY.gslive.brandColorHex,
    );
    expect(decodedCrossVenue.writerLane.writerLaneId).toBe("gslive");

    // Verify all committed golden NSH frame fixtures in tests/fixtures/nsh_frames/golden.lock.json decode cleanly with self-contained metadata
    const fixtureDir = new URL("./fixtures/nsh_frames/", import.meta.url);
    const goldenLock = (await Bun.file(
      new URL("golden.lock.json", fixtureDir),
    ).json()) as Record<string, { hex: string }>;
    const fixtureNames = Object.keys(goldenLock);
    expect(fixtureNames.length).toBeGreaterThanOrEqual(3);

    for (const name of fixtureNames) {
      const hex = (
        await Bun.file(new URL(`${name}.hex`, fixtureDir)).text()
      ).trim();
      const decodedFixture = extractStructured<EnrichedDecodePayload>(
        runDecodeNshFrameTool({ payload: hex }),
      );
      const expectedProvenance =
        PROVENANCE_BY_CHANNEL_ORDINAL[decodedFixture.handle.channelId4]!;
      expect(decodedFixture.provenanceChannelCode).toBe(expectedProvenance);
      expect(decodedFixture.channelColorCss).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(decodedFixture.originBrandColorHex).toBe(
        ORIGIN_DOMAIN_REGISTRY[
          decodedFixture.originDomainId as keyof typeof ORIGIN_DOMAIN_REGISTRY
        ].brandColorHex,
      );
      // A golden fixture may carry a sentinel byte; the payload resolves the
      // colour from the lane when one exists, else from the sentinel class.
      const fixtureChannel = decodedFixture.writerChannelId as
        | keyof typeof WRITER_LANE_REGISTRY
        | keyof typeof SENTINEL_CHANNEL_REGISTRY;
      const expectedWriterColor =
        (WRITER_LANE_REGISTRY as Record<string, { brandColorHex: string }>)[
          fixtureChannel
        ]?.brandColorHex ??
        (
          SENTINEL_CHANNEL_REGISTRY as Record<string, { brandColorHex: string }>
        )[fixtureChannel]?.brandColorHex;
      expect(decodedFixture.writerBrandColorHex).toBe(expectedWriterColor!);
    }
  });
});

describe("StreamableHTTP stateful Mcp-Session-Id & --stateless transports", () => {
  test("stateful StreamableHTTP lifecycle: SDK Client initialize, listTools, callTool, SSE GET, DELETE, and maxSessions eviction", async () => {
    const handle: StandaloneMcpServerHandle = startStandaloneMcpServer({
      port: 0,
      hostname: "127.0.0.1",
      stateless: false,
      maxSessions: 2,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => handle.stop(true));

    const mcpUrl = new URL("/mcp", handle.url);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      },
    });
    const client = new Client({
      name: "sportsdesk-test-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(async () => {
      await client.close();
    });

    await client.connect(transport);
    expect(transport.sessionId).toBeString();
    const firstSessionId = transport.sessionId!;
    expect(handle.mcpHandler.getActiveSessionCount()).toBe(1);
    expect(handle.mcpHandler.hasSession(firstSessionId)).toBe(true);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      "check_sor_slippage",
      "decode_nsh_frame",
      "get_active_bet_blotter",
      "get_bridge_channel_catalog",
      "get_channel_provenance",
      "get_liability_and_polymarket_liquidity",
      "get_live_line_trading_board",
      "get_trading_desk_kpis_and_sport_tree",
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }

    const provResult = await client.callTool({
      name: "get_channel_provenance",
      arguments: { channelCode: "GSLIVE" },
    });
    const provData = extractStructured<{
      matchedChannel: { channelCode: string; colorCss: string } | null;
    }>(provResult);
    expect(provData.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(provData.matchedChannel?.colorCss).toMatch(/^#[0-9a-fA-F]{6}$/);

    const sorResult = await client.callTool({
      name: "check_sor_slippage",
      arguments: { league: "NBA", slippageBps: 95 },
    });
    const sorData = extractStructured<{ allowed: boolean }>(sorResult);
    expect(sorData.allowed).toBe(true);

    // Missing Mcp-Session-Id on GET returns 400 (with Accept: text/event-stream) or 406 without Accept
    const missingAcceptGet = await fetch(mcpUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(missingAcceptGet.status).toBe(406);

    const missingSessionGet = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
      },
    });
    expect(missingSessionGet.status).toBe(400);

    // Unknown Mcp-Session-Id returns 404
    const unknownSessionPost = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "00000000-0000-4000-8000-000000000000",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
      }),
    });
    expect(unknownSessionPost.status).toBe(404);

    // Connect two additional clients to trigger maxSessions=2 eviction of firstSessionId
    const client2 = new Client({ name: "c2", version: "1.0.0" });
    const transport2 = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
    });
    await client2.connect(transport2);
    activeCleanupTasks.push(() => client2.close());

    await Bun.sleep(5);

    const client3 = new Client({ name: "c3", version: "1.0.0" });
    const transport3 = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
    });
    await client3.connect(transport3);
    activeCleanupTasks.push(() => client3.close());

    expect(handle.mcpHandler.getActiveSessionCount()).toBe(2);
    expect(handle.mcpHandler.hasSession(firstSessionId)).toBe(false);
    expect(handle.mcpHandler.hasSession(transport3.sessionId!)).toBe(true);

    // Explicit DELETE session termination removes session and subsequent POST gets 404
    const sessionToDelete = transport3.sessionId!;
    await transport3.terminateSession();
    expect(handle.mcpHandler.hasSession(sessionToDelete)).toBe(false);

    const afterDeleteRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionToDelete,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(afterDeleteRes.status).toBe(404);
  });

  test("GET /mcp flushes SSE 200 headers immediately on Bun.serve, propagates client cancel for reconnect, and expires idle sessions", async () => {
    const handle = startStandaloneMcpServer({
      port: 0,
      hostname: "127.0.0.1",
      stateless: false,
      sessionIdleTtlMs: 80,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => handle.stop(true));

    const mcpUrl = new URL("/mcp", handle.url);
    const initRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "sse-ttfb-probe", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    await initRes.text();
    const sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeString();

    // GET /mcp must flush HTTP 200 headers in well under 500ms (not wait 8,000ms for keepAliveMs)
    const abort1 = new AbortController();
    const t0 = performance.now();
    const sse1 = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      signal: abort1.signal,
    });
    const ttfbMs = performance.now() - t0;
    expect(sse1.status).toBe(200);
    expect(sse1.headers.get("content-type")).toContain("text/event-stream");
    expect(ttfbMs).toBeLessThan(500);

    const reader1 = sse1.body!.getReader();
    const firstChunk = await reader1.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toContain(": keepalive");
    reader1.releaseLock();

    // Aborting the client stream must propagate cancel upstream so a second GET /mcp does not 409
    abort1.abort();
    await Bun.sleep(25);

    const abort2 = new AbortController();
    const sse2 = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      signal: abort2.signal,
    });
    expect(sse2.status).toBe(200);
    abort2.abort();

    // Wait past sessionIdleTtlMs (80ms) -> session expires and subsequent POST returns 404
    await Bun.sleep(110);
    expect(handle.mcpHandler.hasSession(sessionId)).toBe(false);
    expect(handle.mcpHandler.getActiveSessionCount()).toBe(0);

    const expiredPost = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(expiredPost.status).toBe(404);
  });

  test("stateless mode handles SDK Client connect, concurrent POST /mcp, 405 on GET/DELETE, and premature client abort without server leaks", async () => {
    const handle = startStandaloneMcpServer({
      port: 0,
      hostname: "127.0.0.1",
      stateless: true,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => handle.stop(true));

    const mcpUrl = new URL("/mcp", handle.url);

    // GET and DELETE in stateless mode must return 405 with Allow: POST (no orphaned McpServer)
    const getRes = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
      },
    });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("allow")).toBe("POST");

    const delRes = await fetch(mcpUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(delRes.status).toBe(405);
    expect(delRes.headers.get("allow")).toBe("POST");

    // Official MCP SDK Client + StreamableHTTPClientTransport connects cleanly against stateless mode
    const sdkTransport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
    });
    const sdkClient = new Client({
      name: "stateless-sdk-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => sdkClient.close());
    await sdkClient.connect(sdkTransport);
    expect(sdkTransport.sessionId).toBeUndefined();

    const tools = await sdkClient.listTools();
    expect(tools.tools).toHaveLength(8);

    // Corrupt NaN wire float frame called over MCP protocol returns structured tool error (not -32602 output validation crash)
    const nanFrame = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.TICKER_MATCH,
      channelId: 5,
      slaDivide10Ms: 25,
      rowIndex: 1,
      betGroupId: 7n,
      stakeUsdc: 10,
      bookOdds: 2.0,
      polyAvgPrice: 0.5,
      liabilityDelta: 5,
      timestampMs: 1_762_992_000_000,
      originDomainWireId: OriginDomainWireId.GSLIVE_118,
      writerLaneWireId: WriterLaneWireId.GSLIVE,
      flags: 0,
      slippageBps: 10,
    });
    new DataView(
      nanFrame.buffer,
      nanFrame.byteOffset,
      nanFrame.byteLength,
    ).setFloat64(16, Number.NaN, true);

    const nanToolRes = await sdkClient.callTool({
      name: "decode_nsh_frame",
      arguments: { payload: Buffer.from(nanFrame).toString("hex") },
    });
    expect(nanToolRes.isError).toBe(true);
    const nanErr = extractErrorJson(nanToolRes as CallToolResult);
    expect(nanErr.errorCode).toBe("invalid_number");

    // Fire 6 concurrent stateless SSE POST requests without Mcp-Session-Id
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        fetch(mcpUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: idx + 1,
            method: "tools/call",
            params: {
              name: "check_sor_slippage",
              arguments: { league: "NBA", slippageBps: 50 + idx * 10 },
            },
          }),
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const bodyText = await res.text();
      expect(bodyText).toContain('"allowed":true');
    }

    // Premature client abort on SSE POST cleans up activeStatelessServers
    const abortCtrl = new AbortController();
    const abortedRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/list",
      }),
      signal: abortCtrl.signal,
    });
    expect(abortedRes.status).toBe(200);
    abortCtrl.abort();
    await Bun.sleep(25);

    expect(handle.mcpHandler.getActiveSessionCount()).toBe(0);
    expect(handle.mcpHandler.getActiveStatelessCount()).toBe(0);
  });
});

describe("Mounted /mcp route on :4020 webview server and @sportsdesk-ops/api router", () => {
  test("services/sportsdesk_webview_server.ts mounts guarded /mcp with stateful sessions", async () => {
    const server = startServer({
      port: 0,
      mcpAuthToken: TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => {
      server.stop(true);
    });

    const mcpUrl = new URL("/mcp", `http://127.0.0.1:${server.port}`);

    // Unauthenticated call must be rejected with 401
    const unauth = await fetch(mcpUrl, { method: "POST" });
    expect(unauth.status).toBe(401);

    // Authenticated MCP SDK client works end-to-end on the mounted /mcp route
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      },
    });
    const client = new Client({
      name: "webview-mounted-mcp-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => client.close());

    await client.connect(transport);
    expect(transport.sessionId).toBeString();

    const frameBuf = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.LIABILITY_UPDATE,
      channelId: 4,
      slaDivide10Ms: 50,
      rowIndex: 7,
      betGroupId: 9001n,
      stakeUsdc: 250,
      bookOdds: 2.0,
      polyAvgPrice: 0.5,
      liabilityDelta: 125,
      timestampMs: 1_762_992_100_000,
      originDomainWireId: OriginDomainWireId.F402,
      writerLaneWireId: WriterLaneWireId.GSBUILDER,
      flags: 0x0004,
      slippageBps: 40,
    });

    const decodeRes = await client.callTool({
      name: "decode_nsh_frame",
      arguments: { payload: Buffer.from(frameBuf).toString("base64") },
    });
    const decoded = extractStructured<{
      messageTypeName: string;
      betGroupTag: string;
      originDomainId: string;
      writerLaneId: string;
    }>(decodeRes);
    expect(decoded.messageTypeName).toBe("LIABILITY_UPDATE");
    expect(decoded.betGroupTag).toBe("M.G9001");
    expect(decoded.originDomainId).toBe("ORIGIN_SPORTSBOOK_FANTASY402");
    expect(decoded.writerLaneId).toBe("gsbuilder");
  });

  test("mounted :4020 GET /mcp SSE keepalive survives >12.5s past Bun.serve default socket idleTimeout", async () => {
    const server = startServer({
      port: 0,
      mcpAuthToken: TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => {
      server.stop(true);
    });

    const mcpUrl = new URL("/mcp", `http://127.0.0.1:${server.port}`);
    const initRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "idle-soak-client", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    await initRes.text();
    const sessionId = initRes.headers.get("mcp-session-id")!;

    const abortCtrl = new AbortController();
    const sseRes = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      signal: abortCtrl.signal,
    });
    expect(sseRes.status).toBe(200);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let keepAliveCount = 0;
    const soakDeadline = Date.now() + 12_600;
    while (Date.now() < soakDeadline) {
      const remainingMs = Math.max(100, soakDeadline - Date.now());
      const readResult = await Promise.race([
        reader.read(),
        Bun.sleep(remainingMs).then(() => "timeout" as const),
      ]);
      if (readResult === "timeout") break;
      expect(readResult.done).toBe(false);
      if (decoder.decode(readResult.value).includes(": keepalive")) {
        keepAliveCount += 1;
      }
    }
    // Initial flush (: keepalive) at ~0s + first 8s interval tick (: keepalive) >= 2 frames, zero ECONNRESET
    expect(keepAliveCount).toBeGreaterThanOrEqual(2);
    reader.releaseLock();
    abortCtrl.abort();
  }, 20_000);

  test("packages/api createDashboardApi routes /mcp when handleMcp is wired", async () => {
    const mcpHandler = createSportsdeskMcpHttpHandler({
      stateless: true,
      enableJsonResponse: true,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => mcpHandler.closeAll());

    const stubDeps = {
      state: {},
      auth: {
        requireAdmin: () => null,
        login: () => Response.json({ ok: true }),
        logout: () => Response.json({ ok: true }),
        me: () => Response.json({ authenticated: false }),
      },
      alertDispatcher: {
        getStats: () => ({}),
        getRecent: () => [],
      },
      getTaxonomyCatalog: () => ({}),
      runShadowPricing: async () => ({}),
      executeTerminal: async () => ({ output: "" }),
      getBuildMatrix: async () => [],
      handleMcp: (req: Request) => mcpHandler.handleRequest(req),
    } as unknown as DashboardApiDeps;

    const api = createDashboardApi(stubDeps, { clients: new Set<WsLike>() });
    const mcpRoute = api.routes["/mcp"] as {
      POST: (req: Request) => Promise<Response>;
    };
    expect(mcpRoute).toBeDefined();

    const postRes = await mcpRoute.POST(
      new Request("http://127.0.0.1:4020/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "api-router-test", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(postRes.status).toBe(200);
    const json = (await postRes.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(json.result?.serverInfo?.name).toBe(SPORTSDESK_MCP_SERVER_NAME);

    // PUT /mcp on @sportsdesk-ops/api enforces Bearer auth first (401) and JSON-RPC 405 when authed
    const unauthPut = await api.fetch(
      new Request("http://127.0.0.1:4020/mcp", { method: "PUT" }),
    );
    expect(unauthPut.status).toBe(401);
    expect(unauthPut.headers.get("www-authenticate")).toContain("Bearer");

    const authedPut = await api.fetch(
      new Request("http://127.0.0.1:4020/mcp", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(authedPut.status).toBe(405);
    expect(authedPut.headers.get("allow")).toBe("POST");
  });

  test("SSE /mcp responses emit X-Accel-Buffering: no across stateful GET/POST, stateless POST, and mounted :4020 while omitting it on JSON/204/error responses", async () => {
    // 1. Stateful standalone SSE server
    const statefulHandle = startStandaloneMcpServer({
      port: 0,
      hostname: "127.0.0.1",
      stateless: false,
      enableJsonResponse: false,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => statefulHandle.stop(true));
    const statefulUrl = new URL("/mcp", statefulHandle.url);

    // Non-SSE responses (OPTIONS 204, 401, 404) must NOT emit X-Accel-Buffering
    const optRes = await fetch(statefulUrl, { method: "OPTIONS" });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get("x-accel-buffering")).toBeNull();

    const unauthRes = await fetch(statefulUrl, { method: "POST" });
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers.get("x-accel-buffering")).toBeNull();

    const notFoundRes = await fetch(statefulUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "00000000-0000-4000-8000-999999999999",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers.get("x-accel-buffering")).toBeNull();

    // Stateful POST initialize (text/event-stream) -> X-Accel-Buffering: no
    const initRes = await fetch(statefulUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "nginx-unbuffer-test", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("content-type")).toContain("text/event-stream");
    expect(initRes.headers.get("x-accel-buffering")).toBe("no");
    await initRes.text();
    const sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeString();

    // Stateful GET /mcp SSE stream -> X-Accel-Buffering: no
    const getAbort = new AbortController();
    const getSseRes = await fetch(statefulUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      signal: getAbort.signal,
    });
    expect(getSseRes.status).toBe(200);
    expect(getSseRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(getSseRes.headers.get("x-accel-buffering")).toBe("no");
    getAbort.abort();

    // Stateful POST tools/call (text/event-stream) -> X-Accel-Buffering: no
    const postCallRes = await fetch(statefulUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_channel_provenance",
          arguments: { channelOrdinal: 5 },
        },
      }),
    });
    expect(postCallRes.status).toBe(200);
    expect(postCallRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(postCallRes.headers.get("x-accel-buffering")).toBe("no");
    await postCallRes.text();

    // 2. Stateless SSE POST -> X-Accel-Buffering: no, whereas JSON response mode omits it
    const statelessSseHandler = createSportsdeskMcpHttpHandler({
      stateless: true,
      enableJsonResponse: false,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => statelessSseHandler.closeAll());

    const statelessSseRes = await statelessSseHandler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(statelessSseRes.status).toBe(200);
    expect(statelessSseRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(statelessSseRes.headers.get("x-accel-buffering")).toBe("no");
    await statelessSseRes.text();

    const statelessJsonHandler = createSportsdeskMcpHttpHandler({
      stateless: true,
      enableJsonResponse: true,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => statelessJsonHandler.closeAll());

    const statelessJsonRes = await statelessJsonHandler.handleRequest(
      new Request("http://127.0.0.1:4021/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(statelessJsonRes.status).toBe(200);
    expect(statelessJsonRes.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(statelessJsonRes.headers.get("x-accel-buffering")).toBeNull();
    await statelessJsonRes.json();

    // 3. Mounted :4020 webview server SSE POST + GET -> X-Accel-Buffering: no
    const mountedServer = startServer({
      port: 0,
      mcpAuthToken: TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => {
      mountedServer.stop(true);
    });
    const mountedUrl = new URL(
      "/mcp",
      `http://127.0.0.1:${mountedServer.port}`,
    );
    const mountedInit = await fetch(mountedUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mounted-nginx-probe", version: "1.0.0" },
        },
      }),
    });
    expect(mountedInit.status).toBe(200);
    expect(mountedInit.headers.get("x-accel-buffering")).toBe("no");
    await mountedInit.text();
    const mountedSid = mountedInit.headers.get("mcp-session-id")!;

    const mountedAbort = new AbortController();
    const mountedGet = await fetch(mountedUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": mountedSid,
      },
      signal: mountedAbort.signal,
    });
    expect(mountedGet.status).toBe(200);
    expect(mountedGet.headers.get("x-accel-buffering")).toBe("no");
    mountedAbort.abort();
  });

  test("MCP SDK Client over mounted :4020 validates outputSchema for channelOrdinal/bridgeOrdinal provenance, EXECUTION_MAX_SLIPPAGE_BPS + soft-limit status, and enriched frame decode", async () => {
    const server = startServer({
      port: 0,
      mcpAuthToken: TEST_ADMIN_TOKEN,
      executionEnv: {
        EXECUTION_MAX_SLIPPAGE_BPS: "100",
      },
    });
    activeCleanupTasks.push(() => {
      server.stop(true);
    });

    const mcpUrl = new URL("/mcp", `http://127.0.0.1:${server.port}`);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      },
    });
    const client = new Client({
      name: "round2-sdk-e2e-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => client.close());
    await client.connect(transport);

    // 1. get_channel_provenance over SDK Client with channelOrdinal=14, bridgeOrdinal=9, and extended channelCode="LIVE_CWS"
    const ord14Unpinned = extractStructured<{
      matchedChannel: { channelCode: string } | null;
      routingChannel: {
        channelOrdinal: number;
        channelCode: string;
        provenanceChannelCode: string;
      } | null;
      resolvedOriginDomain: { originDomainId: string } | null;
    }>(
      await client.callTool({
        name: "get_channel_provenance",
        arguments: { channelOrdinal: 14 },
      }),
    );
    expect(ord14Unpinned.routingChannel).toMatchObject({
      channelOrdinal: 14,
      channelCode: "CROSS_VENUE_RFQ_COMBO_LAYOFF",
      provenanceChannelCode: "GSLIVE",
    });
    expect(ord14Unpinned.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(ord14Unpinned.resolvedOriginDomain).toBeNull();

    const ord14PinnedKalshi = extractStructured<{
      bridgeResolution: {
        bridgeOrdinal: number;
        originDomainId: string;
        bridgeQualifiedChannelCode: string | null;
      } | null;
      resolvedOriginDomain: { originDomainId: string; venueId: string } | null;
    }>(
      await client.callTool({
        name: "get_channel_provenance",
        arguments: { channelOrdinal: 14, bridgeOrdinal: 9 },
      }),
    );
    expect(ord14PinnedKalshi.bridgeResolution).toMatchObject({
      bridgeOrdinal: 9,
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      bridgeQualifiedChannelCode:
        "KALSHI_REGULATED_CROSS_VENUE_RFQ_COMBO_LAYOFF",
    });
    expect(ord14PinnedKalshi.resolvedOriginDomain).toMatchObject({
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      venueId: "kalshi",
    });

    const liveCwsByCode = extractStructured<{
      routingChannel: {
        channelOrdinal: number;
        channelCode: string;
        provenanceChannelCode: string;
      } | null;
      resolvedOriginDomain: { originDomainId: string } | null;
    }>(
      await client.callTool({
        name: "get_channel_provenance",
        arguments: { channelCode: "LIVE_CWS" },
      }),
    );
    expect(liveCwsByCode.routingChannel).toMatchObject({
      channelOrdinal: 7,
      channelCode: "LIVE_CWS",
      provenanceChannelCode: "GSLIVE",
    });
    expect(liveCwsByCode.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_SPORTSBOOK_FANTASY402",
    );

    // 2. check_sor_slippage over SDK Client with mounted executionEnv EXECUTION_MAX_SLIPPAGE_BPS=100
    const sorPass = extractStructured<{
      allowed: boolean;
      status: string;
      softLimitBps: number;
      softLimitExceeded: boolean;
      policyMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { league: "NBA", slippageBps: 20 },
      }),
    );
    expect(sorPass).toMatchObject({
      allowed: true,
      status: "PASS",
      softLimitBps: 25,
      softLimitExceeded: false,
      policyMaxSlippageBps: 100,
      effectiveMaxSlippageBps: 100,
    });

    const sorWarn = extractStructured<{
      allowed: boolean;
      status: string;
      warningReason: string | null;
      softLimitExceeded: boolean;
      effectiveMaxSlippageBps: number;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { league: "NBA", slippageBps: 60 },
      }),
    );
    expect(sorWarn).toMatchObject({
      allowed: true,
      status: "WARN",
      warningReason: "exceeds_soft_limit",
      softLimitExceeded: true,
      effectiveMaxSlippageBps: 100,
    });

    const sorReject = extractStructured<{
      allowed: boolean;
      status: string;
      blockReason: string | null;
      warningReason: string | null;
      tierMaxSlippageBps: number;
      policyMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { league: "NBA", slippageBps: 120 },
      }),
    );
    expect(sorReject).toMatchObject({
      allowed: false,
      status: "REJECT",
      blockReason: "slippage_exceeds_policy",
      warningReason: null,
      tierMaxSlippageBps: 150,
      policyMaxSlippageBps: 100,
      effectiveMaxSlippageBps: 100,
    });

    // 3. decode_nsh_frame over SDK Client returns self-contained channel & venue hex metadata
    const liveCwsFrame = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.TICKER_MATCH,
      channelId: 7,
      slaDivide10Ms: 25,
      rowIndex: 99,
      betGroupId: 55_555n,
      stakeUsdc: 300,
      bookOdds: 1.95,
      polyAvgPrice: 0.51,
      liabilityDelta: -150,
      timestampMs: 1_762_992_200_000,
      originDomainWireId: OriginDomainWireId.POLYMARKET_CTF,
      writerLaneWireId: WriterLaneWireId.CSLEVEL2,
      flags: 0x0002,
      slippageBps: 22,
    });
    const decodedViaSdk = extractStructured<{
      channelCode: string;
      provenanceChannelCode: string;
      channelColorCss: string;
      venueId: string;
      originBrandColorHex: string;
      writerBrandColorHex: string;
      originDomain: { originDomainId: string };
      writerLane: { writerLaneId: string };
    }>(
      await client.callTool({
        name: "decode_nsh_frame",
        arguments: { payload: Buffer.from(liveCwsFrame).toString("hex") },
      }),
    );
    expect(decodedViaSdk).toMatchObject({
      channelCode: "LIVE_CWS",
      provenanceChannelCode: "GSLIVE",
      venueId: ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_POLYMARKET_CTF.venueId,
      originBrandColorHex:
        ORIGIN_DOMAIN_REGISTRY.ORIGIN_EXCHANGE_POLYMARKET_CTF.brandColorHex,
      writerBrandColorHex: WRITER_LANE_REGISTRY.cslevel2.brandColorHex,
      originDomain: { originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF" },
      writerLane: { writerLaneId: "cslevel2" },
    });
    expect(decodedViaSdk.channelColorCss).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("Standalone CLI cli/sportsdesk_mcp_cli.ts", () => {
  test("parseSportsdeskMcpCliArgs validates flags and refuses --no-auth on non-loopback hosts", () => {
    expect(formatStandaloneMcpHelp()).toContain("--stateless");

    const helpCfg = parseSportsdeskMcpCliArgs(["--help"], {});
    expect(helpCfg.help).toBe(true);

    const statelessCfg = parseSportsdeskMcpCliArgs(
      ["--port", "0", "--stateless", "--json-response", "--no-auth"],
      {},
    );
    expect(statelessCfg.stateless).toBe(true);
    expect(statelessCfg.enableJsonResponse).toBe(true);
    expect(statelessCfg.requireAuth).toBe(false);
    expect(statelessCfg.hostname).toBe("127.0.0.1");

    expect(() =>
      parseSportsdeskMcpCliArgs(["--hostname", "0.0.0.0", "--no-auth"], {}),
    ).toThrow(/Refusing --no-auth on non-loopback bind host/);

    expect(() => parseSportsdeskMcpCliArgs(["--port", "70000"], {})).toThrow(
      /Invalid --port/,
    );

    expect(() =>
      parseSportsdeskMcpCliArgs(["--max-sessions", "0"], {}),
    ).toThrow(/Invalid --max-sessions/);
  });

  test("spawns cli/sportsdesk_mcp_cli.ts --stateless --json-response --json and serves /health + /mcp", async () => {
    const cliPath = new URL("../cli/sportsdesk_mcp_cli.ts", import.meta.url)
      .pathname;
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "--port",
        "0",
        "--stateless",
        "--json-response",
        "--json",
      ],
      {
        env: {
          ...process.env,
          SPORTSDESK_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    activeCleanupTasks.push(async () => {
      try {
        proc.kill("SIGTERM");
        await proc.exited;
      } catch {
        // already exited
      }
    });

    const reader = proc.stdout.getReader();
    let buffered = "";
    const deadline = Date.now() + 8_000;
    while (!buffered.includes("\n") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();

    const firstLine = buffered.trim().split("\n")[0] ?? "";
    const ready = JSON.parse(firstLine) as {
      status: string;
      url: string;
      mcpEndpoint: string;
      port: number;
      mode: string;
      authRequired: boolean;
    };
    expect(ready.status).toBe("listening");
    expect(ready.mode).toBe("stateless");
    expect(ready.authRequired).toBe(true);
    expect(ready.port).toBeGreaterThan(0);

    const healthRes = await fetch(new URL("/health", ready.url));
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      status: string;
      mode: string;
    };
    expect(healthJson.status).toBe("ok");
    expect(healthJson.mode).toBe("stateless");

    const callRes = await fetch(ready.mcpEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_channel_provenance",
          arguments: { channelCode: "Internet" },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    const callJson = (await callRes.json()) as {
      result?: {
        structuredContent?: { matchedChannel?: { channelCode?: string } };
      };
    };
    expect(
      callJson.result?.structuredContent?.matchedChannel?.channelCode,
    ).toBe("Internet");

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});

describe("Adversarial Round 2 regression hardening", () => {
  test("runCheckSorSlippageTool fails closed on NaN, Infinity, out-of-range inputs, and stale slippageBps with asks", () => {
    for (const badSlippage of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const res = runCheckSorSlippageTool({ slippageBps: badSlippage }, {});
      const err = extractErrorJson(res);
      expect(err.ok).toBe(false);
      expect(err.errorCode).toBe("invalid_slippage_policy");
    }

    for (const badBudget of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1_000_001,
    ]) {
      const res = runCheckSorSlippageTool(
        { budgetUsd: badBudget, asks: [{ price: 0.5, size: 100 }] },
        {},
      );
      expect(extractErrorJson(res).errorCode).toBe("invalid_slippage_policy");
    }

    for (const badMid of [Number.NaN, 0, 1, -0.5, 1.5]) {
      const res = runCheckSorSlippageTool(
        {
          budgetUsd: 50,
          midPrice: badMid,
          asks: [{ price: 0.5, size: 100 }],
        },
        {},
      );
      expect(extractErrorJson(res).errorCode).toBe("invalid_slippage_policy");
    }

    for (const badAsk of [
      { price: Number.NaN, size: 10 },
      { price: 0, size: 10 },
      { price: 1, size: 10 },
      { price: 0.5, size: Number.NaN },
      { price: 0.5, size: 0 },
      { price: 0.5, size: 1e15 },
    ]) {
      const res = runCheckSorSlippageTool(
        { budgetUsd: 50, asks: [badAsk] },
        {},
      );
      expect(extractErrorJson(res).errorCode).toBe("invalid_slippage_policy");
    }

    // When asks is provided, empty asks / zero budget must not leak a stale slippageBps
    const emptyAsksWithStaleBps = extractStructured<{
      allowed: boolean;
      status: string;
      blockReason: string | null;
      observedSlippageBps: number | null;
    }>(runCheckSorSlippageTool({ slippageBps: 500, asks: [] }, {}));
    expect(emptyAsksWithStaleBps).toMatchObject({
      allowed: false,
      status: "REJECT",
      blockReason: "no_book",
      observedSlippageBps: null,
    });

    const zeroBudgetWithStaleBps = extractStructured<{
      allowed: boolean;
      status: string;
      blockReason: string | null;
      observedSlippageBps: number | null;
    }>(
      runCheckSorSlippageTool(
        {
          slippageBps: 500,
          budgetUsd: 0,
          asks: [{ price: 0.5, size: 100 }],
        },
        {},
      ),
    );
    expect(zeroBudgetWithStaleBps).toMatchObject({
      allowed: false,
      status: "REJECT",
      blockReason: "zero_budget",
      observedSlippageBps: null,
    });
  });

  test("check_sor_slippage over MCP SDK Client handles extreme floats, tiny midPrice, and malformed policyEnv without -32602 crashes", async () => {
    const server = await startStandaloneMcpServer({
      hostname: "127.0.0.1",
      port: 0,
      stateless: false,
      enableJsonResponse: false,
      requireAuth: true,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
      policyEnv: {
        EXECUTION_MAX_SLIPPAGE_BPS: "1e25",
        EXECUTION_SPORT_NBA_MAX_SLIPPAGE_BPS: "1e25",
        EXECUTION_SPORT_NFL_MAX_SLIPPAGE_BPS: "NaN",
        EXECUTION_SPORT_CFB_MAX_SLIPPAGE_BPS: "-50",
        EXECUTION_MAX_ORDER_USD: "1e309",
      },
    });
    activeCleanupTasks.push(() => server.stop());

    const transport = new StreamableHTTPClientTransport(
      new URL("/mcp", server.url),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        },
      },
    );
    const client = new Client({
      name: "extreme-sor-sdk-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => client.close());
    await client.connect(transport);

    // Overflowing policyEnv integers fall back safely to contract defaults (200 global, 150 NBA)
    const defaultCheck = extractStructured<{
      allowed: boolean;
      status: string;
      policyMaxSlippageBps: number;
      tierMaxSlippageBps: number;
      effectiveMaxSlippageBps: number;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { league: "NBA", slippageBps: 20 },
      }),
    );
    expect(defaultCheck).toMatchObject({
      allowed: true,
      status: "PASS",
      policyMaxSlippageBps: 200,
      tierMaxSlippageBps: 150,
      effectiveMaxSlippageBps: 150,
    });

    // Huge positive slippageBps clamps to MAX_SAFE_INTEGER and cleanly REJECTs
    const hugePos = extractStructured<{
      allowed: boolean;
      status: string;
      blockReason: string | null;
      observedSlippageBps: number;
      fitsNshFrameU8: boolean;
      sor1Compliant: boolean;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { slippageBps: 1e25 },
      }),
    );
    expect(hugePos).toMatchObject({
      allowed: false,
      status: "REJECT",
      blockReason: "exceeds_nsh_frame_u8",
      observedSlippageBps: Number.MAX_SAFE_INTEGER,
      fitsNshFrameU8: false,
      sor1Compliant: false,
    });

    // Huge negative slippageBps clamps to MIN_SAFE_INTEGER and cleanly REJECTs
    const hugeNeg = extractStructured<{
      allowed: boolean;
      status: string;
      blockReason: string | null;
      observedSlippageBps: number;
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: { slippageBps: -1e25 },
      }),
    );
    expect(hugeNeg).toMatchObject({
      allowed: false,
      status: "REJECT",
      blockReason: "negative_slippage_invalid",
      observedSlippageBps: Number.MIN_SAFE_INTEGER,
    });

    // Subnormal/tiny midPrice whose relative division overflows MAX_SAFE_INTEGER / Infinity
    for (const tinyMid of [1e-300, 1e-310]) {
      const tinyMidRes = extractStructured<{
        allowed: boolean;
        status: string;
        blockReason: string | null;
        observedSlippageBps: number;
      }>(
        await client.callTool({
          name: "check_sor_slippage",
          arguments: {
            budgetUsd: 10,
            midPrice: tinyMid,
            asks: [{ price: 0.5, size: 100 }],
          },
        }),
      );
      expect(tinyMidRes).toMatchObject({
        allowed: false,
        status: "REJECT",
        blockReason: "exceeds_nsh_frame_u8",
        observedSlippageBps: Number.MAX_SAFE_INTEGER,
      });
    }

    // Multi-level max-depth asks (1e12) sum cleanly without overflowing to Infinity
    const deepBook = extractStructured<{
      allowed: boolean;
      status: string;
      bookWalk: { depthContracts: number };
    }>(
      await client.callTool({
        name: "check_sor_slippage",
        arguments: {
          budgetUsd: 100,
          asks: [
            { price: 0.5, size: 1_000_000_000_000 },
            { price: 0.6, size: 1_000_000_000_000 },
          ],
        },
      }),
    );
    expect(deepBook.allowed).toBe(true);
    expect(deepBook.status).toBe("PASS");
    expect(deepBook.bookWalk.depthContracts).toBe(2_000_000_000_000);
  });

  test("unauthenticated loopback mode rejects spoofed Host and Origin DNS-rebinding suffixes", async () => {
    const handler = createSportsdeskMcpHttpHandler({
      stateless: true,
      enableJsonResponse: true,
      requireAuth: false,
    });
    activeCleanupTasks.push(() => handler.closeAll());

    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "host-probe", version: "1.0.0" },
      },
    });

    const spoofedHosts = [
      "[::1].attacker.test",
      "[::1]:4021@attacker.test",
      "[::1]:0",
      "[::1]:70000",
      "localhost:evil",
      "localhost:4020:evil",
      "127.0.0.1:4021@attacker.test",
      "127.0.0.1.attacker.test",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "::1.attacker.test",
    ];
    for (const badHost of spoofedHosts) {
      const res = await handler.handleRequest(
        new Request("http://127.0.0.1:4021/mcp", {
          method: "POST",
          headers: {
            Host: badHost,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: initBody,
        }),
      );
      expect(res.status).toBe(403);
    }

    const validLoopbackHosts = [
      "127.0.0.1",
      "127.0.0.1:4021",
      "localhost",
      "localhost:4021",
      "[::1]",
      "[::1]:4021",
      "::1",
    ];
    for (const goodHost of validLoopbackHosts) {
      const res = await handler.handleRequest(
        new Request("http://127.0.0.1:4021/mcp", {
          method: "POST",
          headers: {
            Host: goodHost,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: initBody,
        }),
      );
      expect(res.status).toBe(200);
    }
  });

  test("validates whitespace writer, multi-filter provenance, canonical packedRouteWord32 bits, 0..255 frame wire bytes, concurrent maxSessions=1 eviction, and HEAD /mcp auth", async () => {
    // 1. Whitespace-only writer is rejected instead of silently matching BLOCKED
    const blankWriterRes = runGetChannelProvenanceTool({ writer: "   " });
    expect(extractErrorJson(blankWriterRes).errorCode).toBe(
      "invalid_provenance_query",
    );

    // 2. Simultaneous multi-filter provenance query populates all views coherently
    const multi = extractStructured<{
      matchedChannel: { channelCode: string } | null;
      routingChannel: {
        channelOrdinal: number;
        channelCode: string;
        provenanceChannelCode: string;
      } | null;
      bridgeResolution: {
        bridgeOrdinal: number;
        venueId: string;
        packedRouteWord32: number | null;
      } | null;
      resolvedOriginDomain: { originDomainId: string } | null;
      writerResolution: { writerLaneId: string } | null;
      colorLookup: { matchedChannelCode: string | null } | null;
    }>(
      runGetChannelProvenanceTool({
        channelOrdinal: 14,
        channelCode: "CROSS_VENUE_RFQ_COMBO_LAYOFF",
        bridgeOrdinal: 6,
        writer: "polymarket",
        color: provenanceCssFor("GSLIVE"),
      }),
    );
    expect(multi.routingChannel).toMatchObject({
      channelOrdinal: 14,
      channelCode: "CROSS_VENUE_RFQ_COMBO_LAYOFF",
      provenanceChannelCode: "GSLIVE",
    });
    expect(multi.matchedChannel?.channelCode).toBe("GSLIVE");
    expect(multi.bridgeResolution).toMatchObject({
      bridgeOrdinal: 6,
      venueId: "polymarket",
    });
    expect(multi.resolvedOriginDomain?.originDomainId).toBe(
      "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    );
    expect(multi.writerResolution?.writerLaneId).toBe("cslevel2");
    expect(multi.colorLookup?.matchedChannelCode).toBe("GSLIVE");

    // 3. Canonical packedRouteWord32 validation rejects dirty upper bits [14..31], corrupted behavior flags, and non-uint32 values
    const canonicalWord = encodeBridgeChannelPackedWord32(
      "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
      "GSLIVE",
    ) as number;
    for (const invalidWord of [
      canonicalWord | (1 << 14),
      canonicalWord ^ (1 << 9),
      -1,
      83.7,
      Number.NaN,
      0x1_0000_0053,
    ]) {
      const badCatalog = runGetBridgeChannelCatalogTool({
        packedRouteWord32: invalidWord,
      });
      expect(extractErrorJson(badCatalog).errorCode).toBe("invalid_channel_id");
    }

    // 4. Full 0..255 wire ID sweep on bytes 56 & 57 over MCP SDK Client + HEAD /mcp router auth + concurrent maxSessions=1 eviction
    const server = await startStandaloneMcpServer({
      hostname: "127.0.0.1",
      port: 0,
      stateless: false,
      enableJsonResponse: true,
      requireAuth: true,
      maxSessions: 1,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
    });
    activeCleanupTasks.push(() => server.stop());

    // Fire 6 concurrent initialize requests at maxSessions=1
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "evict-race", version: "1.0.0" },
      },
    });
    const mcpUrl = new URL("/mcp", server.url);
    const concurrentResponses = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(mcpUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: initPayload,
        }),
      ),
    );
    const issuedIds: string[] = [];
    for (const res of concurrentResponses) {
      expect(res.status).toBe(200);
      await res.text();
      const sid = res.headers.get("mcp-session-id");
      expect(sid).toBeString();
      issuedIds.push(sid!);
    }
    expect(server.mcpHandler.getActiveSessionCount()).toBe(1);
    const activeSurvivors = issuedIds.filter((sid) =>
      server.mcpHandler.hasSession(sid),
    );
    expect(activeSurvivors).toHaveLength(1);

    // Connect MCP SDK Client (evicts the survivor cleanly) and sweep 0..255 wire IDs on decode_nsh_frame
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      },
    });
    const client = new Client({
      name: "wire-sweep-sdk-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => client.close());
    await client.connect(transport);

    const baseFrame = packNshBinaryFrame({
      messageType: NSH_MESSAGE_TYPE.TICKER_MATCH,
      channelId: 5,
      slaDivide10Ms: 50,
      rowIndex: 1,
      betGroupId: 1n,
      stakeUsdc: 10,
      bookOdds: 2.0,
      polyAvgPrice: 0.5,
      liabilityDelta: -10,
      timestampMs: 1_762_992_000_000,
      originDomainWireId: OriginDomainWireId.F402,
      writerLaneWireId: WriterLaneWireId.GSLIVE,
      flags: 0,
      slippageBps: 10,
    });

    for (let byte56 = 0; byte56 <= 255; byte56++) {
      const mutated = new Uint8Array(baseFrame);
      mutated[56] = byte56;
      const res = await client.callTool({
        name: "decode_nsh_frame",
        arguments: { payload: Buffer.from(mutated).toString("hex") },
      });
      if (originDomainIdOfWireId(byte56) !== null) {
        expect(res.isError).toBeUndefined();
      } else {
        expect(res.isError).toBe(true);
      }
    }

    for (let byte57 = 0; byte57 <= 255; byte57++) {
      const mutated = new Uint8Array(baseFrame);
      mutated[57] = byte57;
      const res = await client.callTool({
        name: "decode_nsh_frame",
        arguments: { payload: Buffer.from(mutated).toString("hex") },
      });
      if (writerLaneIdOfWireId(byte57) !== null) {
        expect(res.isError).toBeUndefined();
      } else {
        expect(res.isError).toBe(true);
      }
    }

    // HEAD /mcp on @sportsdesk-ops/api enforces Bearer auth (401 WWW-Authenticate) rather than bypassing handleMcp
    const stubDeps = {
      state: {},
      auth: {
        requireAdmin: () => null,
        login: () => Response.json({ ok: true }),
        logout: () => Response.json({ ok: true }),
        me: () => Response.json({ authenticated: false }),
      },
      alertDispatcher: { getStats: () => ({}), getRecent: () => [] },
      getTaxonomyCatalog: () => ({}),
      runShadowPricing: async () => ({}),
      executeTerminal: async () => ({ output: "" }),
      getBuildMatrix: async () => [],
      handleMcp: (req: Request) => server.mcpHandler.handleRequest(req),
    } as unknown as DashboardApiDeps;
    const api = createDashboardApi(stubDeps, { clients: new Set<WsLike>() });

    const unauthHead = await api.fetch(
      new Request("http://127.0.0.1:4020/mcp", { method: "HEAD" }),
    );
    expect(unauthHead.status).toBe(401);
    expect(unauthHead.headers.get("www-authenticate")).toContain("Bearer");

    const authedHead = await api.fetch(
      new Request("http://127.0.0.1:4020/mcp", {
        method: "HEAD",
        headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(authedHead.status).toBe(405);
    expect(authedHead.headers.get("allow")).toBe("GET, POST, DELETE");
  });
});

describe("Trading Terminal read-only snapshot MCP tools", () => {
  test("get_trading_desk_kpis_and_sport_tree preserves null-honest unmeasured KPIs and builds Sport View live tree", () => {
    const empty = extractStructured<{
      readOnlySnapshot: boolean;
      mutationActionsAvailable: boolean;
      dataBasis: string;
      kpis: Record<string, number | null>;
      sportTreeSummary: { totalGames: number; liveGames: number };
      sportTree: unknown[];
    }>(runGetTradingDeskKpisAndSportTreeTool({}));

    expect(empty.readOnlySnapshot).toBe(true);
    expect(empty.mutationActionsAvailable).toBe(false);
    expect(empty.dataBasis).toBe("none");
    expect(empty.kpis).toEqual({
      marginBasisPoints: null,
      marginPct: null,
      ggrCents: null,
      ggrUsd: null,
      heldPct: null,
      activeBetsCount: null,
      wageredUsd: null,
      toWinUsd: null,
      polymarketAvailableLiquidityUsd: null,
    });
    expect(empty.sportTreeSummary.totalGames).toBe(0);
    expect(empty.sportTree).toEqual([]);

    const populated = extractStructured<{
      dataBasis: string;
      kpis: {
        marginBasisPoints: number | null;
        marginPct: number | null;
        ggrUsd: number | null;
        heldPct: number | null;
        activeBetsCount: number | null;
        polymarketAvailableLiquidityUsd: number | null;
      };
      sportTreeSummary: {
        totalGames: number;
        liveGames: number;
        scheduledGames: number;
        finalGames: number;
        activeBetsCount: number;
        totalHandleUsd: number;
      };
      sportTree: Array<{
        sport: string;
        liveCount: number;
        activeBetsCount: number;
        leagues: Array<{ league: string; liveCount: number }>;
      }>;
    }>(
      runGetTradingDeskKpisAndSportTreeTool({
        dataBasis: "live",
        kpisSnapshot: {
          wageredCents: 10_000_000,
          settledNetCents: 625_000,
          theoreticalHoldBasisPoints: 515,
          polymarketAsks: [
            { price: 0.52, size: 50_000 },
            { price: 0.54, size: 20_000 },
          ],
        },
        games: [
          {
            gameId: "NBA-540",
            league: "NBA",
            status: "live",
            activeBetsCount: 41,
            handleUsd: 28_500,
          },
          {
            gameId: "NFL-201",
            league: "NFL",
            status: "live",
            activeBetsCount: 64,
            handleUsd: 54_000,
          },
          {
            gameId: "CFB-310",
            league: "CFB",
            status: "scheduled",
            activeBetsCount: 18,
            handleUsd: 11_200,
          },
        ],
      }),
    );

    expect(populated.dataBasis).toBe("live");
    expect(populated.kpis).toMatchObject({
      marginBasisPoints: 515,
      marginPct: 5.15,
      ggrUsd: 6250,
      heldPct: 6.25,
      activeBetsCount: 123,
      polymarketAvailableLiquidityUsd: 36800,
    });
    expect(populated.sportTreeSummary).toEqual({
      totalGames: 3,
      liveGames: 2,
      scheduledGames: 1,
      finalGames: 0,
      activeBetsCount: 123,
      totalHandleUsd: 93700,
    });
    expect(populated.sportTree.map((s) => s.sport)).toEqual([
      "Football",
      "Basketball",
    ]);
    expect(populated.sportTree[0]?.leagues.map((l) => l.league)).toEqual([
      "NFL",
      "CFB",
    ]);

    // liveOnly filter excludes scheduled CFB game
    const liveFiltered = extractStructured<{
      sportTreeSummary: { totalGames: number; liveGames: number };
    }>(
      runGetTradingDeskKpisAndSportTreeTool({
        liveOnly: true,
        games: [
          { gameId: "NFL-201", league: "NFL", status: "live" },
          { gameId: "CFB-310", league: "CFB", status: "scheduled" },
        ],
      }),
    );
    expect(liveFiltered.sportTreeSummary).toMatchObject({
      totalGames: 1,
      liveGames: 1,
    });

    // Rejects invalid ask levels
    expect(
      extractErrorJson(
        runGetTradingDeskKpisAndSportTreeTool({
          kpisSnapshot: { polymarketAsks: [{ price: 1.2, size: 10 }] },
        }),
      ).errorCode,
    ).toBe("invalid_kpi_snapshot");
  });

  test("get_live_line_trading_board detects key-number crossings, SHARP_STILL_BETTER layoff risks, and invalid inputs", () => {
    const board = extractStructured<{
      readOnlySnapshot: boolean;
      mutationActionsAvailable: boolean;
      summary: {
        totalMatches: number;
        liveMatches: number;
        layoffRiskAlertsCount: number;
      };
      selectedMatch: {
        gameNum: number;
        spread: {
          openerDeltaHundredths: number | null;
          keyNumberCrossed: number | null;
          betterVenue: string;
          layoffRiskAlert: string | null;
          team1HandleSharePct: number | null;
          team2HandleSharePct: number | null;
        } | null;
      } | null;
    }>(
      runGetLiveLineTradingBoardTool({
        selectedGameNum: 204,
        matches: [
          {
            gameNum: 204,
            league: "NFL",
            status: "live",
            clock: "Q3 08:14",
            teams: ["Rams", "Chargers"],
            score: [21, 17],
            moneyline: {
              team1DecimalOdds: 1.72,
              team2DecimalOdds: 2.18,
              openerTeam1DecimalOdds: 1.85,
              openerTeam2DecimalOdds: 2.02,
            },
            spread: {
              lineHundredths: -750,
              openerLineHundredths: -650,
              polymarketLineHundredths: -650,
              team1AmericanPrice: -110,
              team2AmericanPrice: -110,
              team1HandleUsd: 60_000,
              team2HandleUsd: 40_000,
            },
            total: {
              lineHundredths: 4750,
              openerLineHundredths: 4650,
              polymarketLineHundredths: 4600,
              overAmericanPrice: -108,
              underAmericanPrice: -112,
            },
            pointSeries: [
              { tickLabel: "Q1", team1Score: 7, team2Score: 3 },
              { tickLabel: "Q2", team1Score: 14, team2Score: 10 },
              { tickLabel: "Q3", team1Score: 21, team2Score: 17 },
            ],
            historicOddsSeries: [
              {
                tickLabel: "Open",
                bookImpliedProb: 0.54,
                polymarketMidProb: 0.55,
              },
              {
                tickLabel: "Live",
                bookImpliedProb: 0.58,
                polymarketMidProb: 0.61,
              },
            ],
          },
        ],
      }),
    );

    expect(board.readOnlySnapshot).toBe(true);
    expect(board.mutationActionsAvailable).toBe(false);
    expect(board.summary).toEqual({
      totalMatches: 1,
      liveMatches: 1,
      layoffRiskAlertsCount: 1,
    });
    expect(board.selectedMatch?.gameNum).toBe(204);
    expect(board.selectedMatch?.spread).toMatchObject({
      openerDeltaHundredths: -100,
      keyNumberCrossed: 7,
      betterVenue: "polymarket",
      team1HandleSharePct: 60,
      team2HandleSharePct: 40,
    });
    expect(board.selectedMatch?.spread?.layoffRiskAlert).toContain(
      "SHARP_STILL_BETTER",
    );
    expect(board.selectedMatch?.spread?.layoffRiskAlert).toContain(
      "crosses key 7",
    );

    expect(
      extractErrorJson(
        runGetLiveLineTradingBoardTool({
          matches: [
            {
              gameNum: 2_000_000,
              league: "NBA",
              status: "live",
              clock: "Q1",
              teams: ["LAL", "BOS"],
              score: [0, 0],
            },
          ],
        }),
      ).errorCode,
    ).toBe("invalid_board_input");
  });

  test("get_active_bet_blotter attaches RGB provenance, excludes ALERT/BLOCKED noise from volume, filters unhedged, and keeps OTC snapshots strictly read-only", () => {
    const blotter = extractStructured<{
      readOnlySnapshot: boolean;
      mutationActionsAvailable: boolean;
      summary: {
        totalRows: number;
        excludedNoiseRows: number;
        canonicalStakeCents: number;
        canonicalLiabilityCents: number;
        unhedgedLiabilityCents: number;
        flaggedRowsCount: number;
      };
      rows: Array<{
        ticketKey: string;
        provenanceChannelCode: string;
        provenanceColorCss: string;
        volumeExcludedNoise: boolean;
        unhedgedLiabilityCents: number;
        riskStatus: string;
        hedgeStatus: string;
        hedgeExecutionEnabled: boolean;
      }>;
      otcSnapshots: Array<{
        quoteId: string;
        advisoryStatus: string;
        approvalActionsEnabled: boolean;
      }>;
    }>(
      runGetActiveBetBlotterTool({
        tickets: [
          {
            ticketKey: "T-1001",
            timestampIso: "2026-11-13T15:00:00.000Z",
            customerHandle: "mj102",
            league: "NBA",
            marketLabel: "Celtics -4.5",
            writer: "GSLIVE",
            bookDecimalOdds: 1.91,
            polymarketMidProb: 0.56,
            stakeCents: 200_000,
            hedgedCents: 50_000,
          },
          {
            ticketKey: "T-1002-ALERT",
            timestampIso: "2026-11-13T15:00:02.000Z",
            customerHandle: "mj102",
            league: "NBA",
            marketLabel: "Celtics -4.5 (ALERT mirror)",
            writer: "ALERT",
            bookDecimalOdds: 1.91,
            stakeCents: 200_000,
          },
          {
            ticketKey: "T-1003-BLOCKED",
            timestampIso: "2026-11-13T15:00:05.000Z",
            customerHandle: "bot99",
            league: "NFL",
            marketLabel: "Rams ML",
            writer: "BLOCKED",
            bookDecimalOdds: 2.0,
            stakeCents: 500_000,
          },
          {
            ticketKey: "T-1004-HEDGED",
            timestampIso: "2026-11-13T15:01:00.000Z",
            customerHandle: "dk121",
            league: "NFL",
            marketLabel: "Lions -3",
            writer: "Internet",
            bookDecimalOdds: 2.0,
            stakeCents: 100_000,
            liabilityCents: 100_000,
            hedgedCents: 100_000,
          },
        ],
        otcQuoteSnapshots: [
          {
            quoteId: "OTC-77",
            observedAtIso: "2026-11-13T15:02:00.000Z",
            customerHandle: "whale77",
            league: "NBA",
            matchup: "Lakers @ Celtics",
            selectionLabel: "Celtics -4.5",
            requestedStakeCents: 2_500_000,
            requestedDecimalOdds: 1.95,
            bookDecimalOdds: 1.91,
            polymarketFairProb: 0.54,
          },
        ],
      }),
    );

    expect(blotter.readOnlySnapshot).toBe(true);
    expect(blotter.mutationActionsAvailable).toBe(false);
    expect(blotter.summary.totalRows).toBe(4);
    expect(blotter.summary.excludedNoiseRows).toBe(2);
    // Only T-1001 ($2,000) and T-1004 ($1,000) count toward canonical stake; ALERT & BLOCKED are excluded!
    expect(blotter.summary.canonicalStakeCents).toBe(300_000);
    expect(blotter.summary.canonicalLiabilityCents).toBe(182_000 + 100_000);
    expect(blotter.summary.unhedgedLiabilityCents).toBe(132_000);
    expect(blotter.summary.flaggedRowsCount).toBe(1);
    expect(blotter.rows[0]?.provenanceChannelCode).toBe("GSLIVE");
    expect(blotter.rows[0]?.provenanceColorCss).toBe(
      provenanceCssFor("GSLIVE"),
    );
    expect(blotter.rows[0]?.hedgeExecutionEnabled).toBe(false);
    expect(blotter.rows[1]?.volumeExcludedNoise).toBe(true);
    expect(blotter.rows[2]?.volumeExcludedNoise).toBe(true);
    expect(blotter.otcSnapshots[0]?.approvalActionsEnabled).toBe(false);
    expect(blotter.otcSnapshots[0]?.advisoryStatus).toBe("edge_favorable");

    // unhedgedOnly retains only T-1001 (excludes hedged T-1004 and noise rows)
    const unhedgedOnlyRes = extractStructured<{
      rows: Array<{ ticketKey: string }>;
    }>(
      runGetActiveBetBlotterTool({
        unhedgedOnly: true,
        tickets: [
          {
            ticketKey: "T-1001",
            timestampIso: "2026-11-13T15:00:00.000Z",
            customerHandle: "mj102",
            league: "NBA",
            marketLabel: "Celtics -4.5",
            writer: "GSLIVE",
            bookDecimalOdds: 1.91,
            stakeCents: 200_000,
            hedgedCents: 50_000,
          },
          {
            ticketKey: "T-1004-HEDGED",
            timestampIso: "2026-11-13T15:01:00.000Z",
            customerHandle: "dk121",
            league: "NFL",
            marketLabel: "Lions -3",
            writer: "Internet",
            bookDecimalOdds: 2.0,
            stakeCents: 100_000,
            liabilityCents: 100_000,
            hedgedCents: 100_000,
          },
        ],
      }),
    );
    expect(unhedgedOnlyRes.rows.map((r) => r.ticketKey)).toEqual(["T-1001"]);
  });

  test("get_liability_and_polymarket_liquidity evaluates Book Liability vs Polymarket Liquidity, Liability Monitor matrix, and SOR-1 over MCP SDK Client", async () => {
    const server = startStandaloneMcpServer({
      hostname: "127.0.0.1",
      port: 0,
      stateless: false,
      resolveAuthToken: () => TEST_ADMIN_TOKEN,
      policyEnv: { EXECUTION_MAX_SLIPPAGE_BPS: "150" },
    });
    activeCleanupTasks.push(() => server.stop());

    const transport = new StreamableHTTPClientTransport(
      new URL("/mcp", server.url),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        },
      },
    );
    const client = new Client({
      name: "terminal-tools-e2e-client",
      version: "1.0.0",
    });
    activeCleanupTasks.push(() => client.close());
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    // Verify strictly read-only: zero approval/hedge mutation tools exist
    expect(names.some((n) => /approve|decline|execute_hedge/i.test(n))).toBe(
      false,
    );
    for (const t of listed.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }

    const liab = extractStructured<{
      readOnlySnapshot: boolean;
      hedgeExecutionEnabled: boolean;
      effectiveMaxSlippageBps: number;
      totals: {
        totalWageredUsd: number;
        projectedHoldUsd: number | null;
        grossLiabilityUsd: number;
        hedgedLiabilityUsd: number;
        netUnhedgedRiskUsd: number;
        polymarketAvailableLiquidityUsd: number;
        overallCoveragePct: number | null;
      };
      rows: Array<{
        marketId: string;
        sor1SlippageStatus: string;
        sor1Compliant: boolean;
        fullyCovered: boolean;
      }>;
    }>(
      await client.callTool({
        name: "get_liability_and_polymarket_liquidity",
        arguments: {
          league: "NBA",
          unhedgedOnly: true,
          exposures: [
            {
              marketId: "NBA-BOS-SPREAD",
              outcomeLabel: "Celtics -4.5",
              wageredCents: 1_500_000,
              grossLiabilityCents: 1_200_000,
              hedgedLiabilityCents: 400_000,
              holdBasisPoints: 480,
              midPrice: 0.52,
              polymarketAsks: [
                { price: 0.52, size: 15_000 },
                { price: 0.525, size: 15_000 },
              ],
            },
            {
              marketId: "NBA-MIL-TOTAL",
              outcomeLabel: "Bucks Over 224.5",
              wageredCents: 600_000,
              grossLiabilityCents: 500_000,
              hedgedLiabilityCents: 0,
              holdBasisPoints: 500,
              midPrice: 0.5,
              polymarketAsks: [
                { price: 0.5, size: 2_000 },
                { price: 0.505, size: 10_000 },
              ],
            },
            {
              marketId: "NBA-DEN-ML-THIN",
              outcomeLabel: "Nuggets ML",
              wageredCents: 400_000,
              grossLiabilityCents: 300_000,
              hedgedLiabilityCents: 0,
              holdBasisPoints: 450,
              midPrice: 0.5,
              polymarketAsks: [{ price: 0.5, size: 1_000 }],
            },
            {
              marketId: "NBA-LAL-ML-HEDGED",
              outcomeLabel: "Lakers ML",
              wageredCents: 500_000,
              grossLiabilityCents: 450_000,
              hedgedLiabilityCents: 450_000,
              holdBasisPoints: 500,
              polymarketAsks: [{ price: 0.45, size: 10_000 }],
            },
          ],
        },
      }),
    );

    expect(liab.readOnlySnapshot).toBe(true);
    expect(liab.hedgeExecutionEnabled).toBe(false);
    expect(liab.effectiveMaxSlippageBps).toBe(150);
    // Fully hedged NBA-LAL-ML-HEDGED is filtered out when unhedgedOnly=true
    expect(liab.rows).toHaveLength(3);
    expect(liab.rows[0]).toMatchObject({
      marketId: "NBA-BOS-SPREAD",
      sor1SlippageStatus: "PASS",
      sor1Compliant: true,
      fullyCovered: true,
    });
    expect(liab.rows[1]).toMatchObject({
      marketId: "NBA-MIL-TOTAL",
      sor1SlippageStatus: "WARN",
      sor1Compliant: true,
      fullyCovered: true,
    });
    expect(liab.rows[2]).toMatchObject({
      marketId: "NBA-DEN-ML-THIN",
      sor1SlippageStatus: "REJECT",
      sor1Compliant: false,
      fullyCovered: false,
    });
    expect(liab.totals).toMatchObject({
      totalWageredUsd: 25000,
      projectedHoldUsd: 1200,
      grossLiabilityUsd: 20000,
      hedgedLiabilityUsd: 4000,
      netUnhedgedRiskUsd: 16000,
    });
  });
});
