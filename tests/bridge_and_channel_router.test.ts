import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  BridgeChannelRouteColumnStore,
  DodGateFailureError,
  INGEST_ROW_FLAG_RFQ_COMBO_LAYOFF,
  INGEST_ROW_FLAG_TRACKED_SHADOW_WALLET,
  InlineCapacityList8,
  NULL_BRIDGE_CHANNEL_WORD32,
  NULL_CLV_SENTINEL,
  NULL_CUSTOMER_HANDLE32,
  NULL_CUSTOMER_HANDLE64,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  asBitSet32,
  asCents,
  encodeBridgeChannelPackedWord32,
  isTransportBridgePermittedForChannel,
  resolveSeparatedBridgeAndChannelEnvelope,
  safeClvAbsLineHundredths,
} from "../lib/bridge_and_channel_router.ts";
import {
  assertBridgeAndChannelTaxonomicSeparation,
  assertColumnStoreNamingAndUnsignedHandles,
  auditSourceCodeNamingCompliance,
} from "../lib/specification_naming_police.ts";

export async function runBridgeAndChannelNamingPoliceSuite(): Promise<void> {
  const store = new BridgeChannelRouteColumnStore(4);
  assertColumnStoreNamingAndUnsignedHandles(
    store as unknown as Record<string, unknown>,
    "BridgeChannelRouteColumnStore",
  );

  assert.throws(
    () =>
      assertColumnStoreNamingAndUnsignedHandles({
        capacity: 4,
        packedCustomerHandle32Col: new Int32Array(4),
      }),
    (err: unknown) => err instanceof DodGateFailureError && err.gate === 1,
  );

  assert.throws(
    () =>
      assertColumnStoreNamingAndUnsignedHandles({
        capacity: 4,
        stakeCol: new Int32Array(4),
      }),
    (err: unknown) => err instanceof DodGateFailureError && err.gate === 1,
  );

  assert.throws(
    () =>
      assertColumnStoreNamingAndUnsignedHandles({
        capacity: 4,
        canonicalVolumeCentsCol: new Float64Array(4),
      }),
    (err: unknown) => err instanceof DodGateFailureError && err.gate === 6,
  );

  assertBridgeAndChannelTaxonomicSeparation();

  assert.throws(
    () =>
      assertBridgeAndChannelTaxonomicSeparation(
        TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
        {
          XMKT_BAD_CHANNEL: {
            channelCode: "XMKT_BAD_CHANNEL",
            channelOrdinal5: 0,
            neuronTokenIdentifier: "L24.N2101",
          },
        },
      ),
    (err: unknown) => err instanceof DodGateFailureError && err.gate === 7,
  );

  assert.throws(
    () =>
      assertBridgeAndChannelTaxonomicSeparation(
        TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
        {
          CROSS_VENUE_VALID_NAME: {
            channelCode: "CROSS_VENUE_VALID_NAME",
            channelOrdinal5: 0,
            neuronTokenIdentifier: "L24.N2101",
            zeroCanonicalVolume: true,
          },
        },
      ),
    (err: unknown) => err instanceof DodGateFailureError && err.gate === 4,
  );

  const routerSource = await Bun.file(
    new URL("../lib/bridge_and_channel_router.ts", import.meta.url),
  ).text();
  auditSourceCodeNamingCompliance(routerSource, "bridge_and_channel_router.ts");

  for (const badSnippet of [
    "const shortDesc = 'M.G1';",
    "const cache = new Map<string, number>();",
    "const flags: boolean[] = [];",
    "const cents = parseFloat('12.34');",
    "throw new Error('untyped');",
  ]) {
    assert.throws(
      () => auditSourceCodeNamingCompliance(badSnippet, "bad-snippet.ts"),
      (err: unknown) => err instanceof DodGateFailureError && err.gate === 8,
    );
  }

  const tickerLive = resolveSeparatedBridgeAndChannelEnvelope({
    transportBridgeId: "BRIDGE_01_F402_BET_TICKER_STREAM",
    ticketWriterToken: "GSLIVE",
    shortDescriptionPrefix: "M.G318407740",
    ticketLegCount: 1,
    rawBoardRotationNumber: 9501,
    amountWageredCents: asCents(50_000),
  });
  const tallyLive = resolveSeparatedBridgeAndChannelEnvelope({
    transportBridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
    ticketWriterToken: "GSLIVE",
    shortDescriptionPrefix: "M.G318407740",
    ticketLegCount: 1,
    rawBoardRotationNumber: 9501,
    amountWageredCents: asCents(50_000),
  });

  assert.equal(tickerLive.channelSpecification.channelCode, "GSLIVE");
  assert.equal(tallyLive.channelSpecification.channelCode, "GSLIVE");
  assert.equal(
    tickerLive.bridgeSpecification.webSocketSubscriptionTopic,
    "f402-bet-ticker",
  );
  assert.equal(
    tallyLive.bridgeSpecification.webSocketSubscriptionTopic,
    "gslive-tally",
  );

  const pmLead = resolveSeparatedBridgeAndChannelEnvelope({
    transportBridgeId: "BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED",
    amountWageredCents: asCents(420_000),
    ingestRowFlagsBitSet32: asBitSet32(INGEST_ROW_FLAG_TRACKED_SHADOW_WALLET),
  });
  assert.equal(
    pmLead.channelSpecification.channelCode,
    "CROSS_VENUE_SHADOW_WALLET_LEAD",
  );

  const kalshiLayoff = resolveSeparatedBridgeAndChannelEnvelope({
    transportBridgeId: "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM",
    amountWageredCents: asCents(150_000),
    ingestRowFlagsBitSet32: asBitSet32(INGEST_ROW_FLAG_RFQ_COMBO_LAYOFF),
  });
  assert.equal(
    kalshiLayoff.channelSpecification.channelCode,
    "CROSS_VENUE_RFQ_COMBO_LAYOFF",
  );

  assert.equal(
    isTransportBridgePermittedForChannel(
      "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET",
      "PHONE",
    ),
    false,
  );
  assert.throws(
    () =>
      encodeBridgeChannelPackedWord32(
        "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET",
        "PHONE",
        42,
      ),
    (err: unknown) =>
      err instanceof DodGateFailureError && err.gate === 7 && err.rowIdx === 42,
  );

  assert.equal(store.packedRouteWord32Col[0], NULL_BRIDGE_CHANNEL_WORD32);
  assert.equal(store.packedCustomerHandle32Col[0], NULL_CUSTOMER_HANDLE32);
  assert.equal(store.loginKey64Col[0], NULL_CUSTOMER_HANDLE64);
  assert.equal(store.clvLineHundredthsCol[0], NULL_CLV_SENTINEL);
  assert.equal(safeClvAbsLineHundredths(NULL_CLV_SENTINEL), 0);

  const legBuffer = new InlineCapacityList8<number>();
  legBuffer.push(501);
  legBuffer.push(503);
  assert.equal(legBuffer.length, 2);
  assert.equal(legBuffer.at(1), 503);
}

test("bridge and channel router enforces the naming police", async () => {
  await runBridgeAndChannelNamingPoliceSuite();
});
