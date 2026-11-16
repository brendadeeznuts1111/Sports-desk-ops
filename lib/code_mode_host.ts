/**
 * Host-realm Code Mode factory — MCP / desk spine only.
 * Profile snapshot tools live in the guest path (`quickjs_code_mode.ts`), not here.
 */
import { z } from "zod";
import {
  runCheckSorSlippageTool,
  runDecodeNshFrameTool,
  runGetActiveBetBlotterTool,
  runGetBridgeChannelCatalogTool,
  runGetChannelProvenanceTool,
  runGetLiabilityAndPolymarketLiquidityTool,
  runGetLiveLineTradingBoardTool,
  runGetTradingDeskKpisAndSportTreeTool,
} from "./sportsdesk_mcp_server.ts";
import {
  computeWagerSoAMetrics,
  type WagerSoAMetrics,
} from "./bridge_3c_reader.ts";
import { CodeModeRunner } from "./code_mode.ts";

/** Host runner: `Bun.Transpiler` + `AsyncFunction` — cells can reach Bun/process. */
export function createSportsdeskCodeModeHostRunner(): CodeModeRunner {
  const runner = new CodeModeRunner();

  runner.registerTool({
    name: "get_channel_provenance",
    description:
      "Resolves signal channel code to provenance badge, category, color, and transport table.",
    parameters: z.object({
      channel: z.string(),
      includeTransportSpecs: z.boolean().optional(),
    }),
    handler: (args) => runGetChannelProvenanceTool(args as never),
  });

  runner.registerTool({
    name: "get_bridge_channel_catalog",
    description:
      "Inspects the 10 operational bridges (00..09) and active signal channels.",
    parameters: z.object({
      transportBridge: z.string().optional(),
      signalChannel: z.string().optional(),
    }),
    handler: (args) => runGetBridgeChannelCatalogTool(args as never),
  });

  runner.registerTool({
    name: "check_sor_slippage",
    description:
      "Evaluates SOR execution decision slippage in basis points against soft warning (25 bps) and hard rejection (200 bps).",
    parameters: z.object({
      intendedCents: z.number(),
      executedCents: z.number(),
      sport: z.string().optional(),
    }),
    handler: (args) => runCheckSorSlippageTool(args as never),
  });

  runner.registerTool({
    name: "decode_nsh_frame",
    description:
      "Decodes 64-byte NSH binary telemetry frame hex string into fields.",
    parameters: z.object({
      frameHex: z.string(),
    }),
    handler: (args) => runDecodeNshFrameTool(args as never),
  });

  runner.registerTool({
    name: "get_trading_desk_kpis_and_sport_tree",
    description: "Returns top KPI strip and active sport taxonomy tree.",
    parameters: z.object({}),
    handler: (args) => runGetTradingDeskKpisAndSportTreeTool(args as never),
  });

  runner.registerTool({
    name: "get_live_line_trading_board",
    description:
      "Returns live line trading board ladder and key numbers for specified sport.",
    parameters: z.object({
      sport: z.string().optional(),
    }),
    handler: (args) => runGetLiveLineTradingBoardTool(args as never),
  });

  runner.registerTool({
    name: "get_active_bet_blotter",
    description:
      "Returns read-only active bet blotter wagers and filter counts.",
    parameters: z.object({
      limit: z.number().optional(),
      channel: z.string().optional(),
    }),
    handler: (args) => runGetActiveBetBlotterTool(args as never),
  });

  runner.registerTool({
    name: "get_liability_and_polymarket_liquidity",
    description:
      "Computes book liability vs Polymarket CLOB depth for cross-venue hedging.",
    parameters: z.object({
      marketId: z.string().optional(),
      side: z.string().optional(),
    }),
    handler: (args) => runGetLiabilityAndPolymarketLiquidityTool(args as never),
  });

  runner.registerTool({
    name: "read_json_file",
    description: "Reads and parses a local JSON file directly from disk.",
    parameters: z.object({
      path: z.string(),
    }),
    handler: async (args: { path: string }) => {
      const file = Bun.file(args.path);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${args.path}`);
      }
      return file.json();
    },
  });

  runner.registerTool({
    name: "compute_wager_metrics",
    description:
      "Computes single-pass analytic reductions over SoA wager columns with zero collection allocations.",
    parameters: z.object({
      spreads: z.array(z.number()),
      totals: z.array(z.number()),
      odds: z.array(z.number()),
    }),
    handler: (args: {
      spreads: number[];
      totals: number[];
      odds: number[];
    }): WagerSoAMetrics => {
      const length = Math.min(
        args.spreads.length,
        args.totals.length,
        args.odds.length,
      );
      const spreadCol = new Int32Array(length);
      const totalCol = new Int32Array(length);
      const oddsCol = new Int32Array(length);
      spreadCol.set(args.spreads.slice(0, length));
      totalCol.set(args.totals.slice(0, length));
      oddsCol.set(args.odds.slice(0, length));

      return computeWagerSoAMetrics(
        {
          capacity: length,
          spreadCol: spreadCol as never,
          totalCol: totalCol as never,
          oddsCol: oddsCol as never,
        },
        length,
      );
    },
  });

  return runner;
}

/**
 * @deprecated Use {@link createSportsdeskCodeModeHostRunner}. Removal: first release after
 * **2026-06-01** (target sportsdesk-ops **v0.2.0**). Tracked: https://github.com/bw496915-cmyk/Sports-desk-ops/issues/227
 * Before deleting, grep for `createSportsdeskCodeModeRunner` and
 * update the allowlist in the same commit.
 */
export const createSportsdeskCodeModeRunner =
  createSportsdeskCodeModeHostRunner;
