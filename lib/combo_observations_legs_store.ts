/**
 * @file combo_observations_legs_store.ts
 * @description SQLite Storage & Staging Engine for Flattened Combo Observations (CFB, NFL, NBA, All Periods),
 *              including `ingestF402ReportPendingBatch()` which groups `api/Report/Pending` and `api/Report/getGrading`
 *              rows by `${TicketNumber}-${WagerNumber}` before hashing.
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import type { CanonicalPeriod } from "./leg_taxonomy.ts";
import {
  type CanonicalLeg,
  type LineHundredths,
  type F402CustomerReportPendingRow,
  computeComboIdentityHashes,
  groupF402PendingRowsByTicket,
  mapPolyLeg,
  mapF402Leg,
  type PolymarketRawOrderLeg,
  type F402RawTicketLeg,
} from "./combo_identity.ts";

export interface FlatLegRecord {
  id?: number;
  sourceVenue: "polymarket" | "f402";
  sourceTicket: string;
  walletOrAccount: string;
  agentId?: string | null;
  gameId: string;
  period?: CanonicalPeriod;
  subject: string;
  marketKind: string;
  side: string;
  lineHundredths: LineHundredths | null;
  productClass: string;
  stakeCents: number;
  oddsAmerican: number | null;
  identitySha256: string;
  shapeSha256: string;
  pickShapeSha256: string;
  placedAt: string;
  status: "pending" | "settled";
  createdAt?: string;
}

export interface WalletAttributionRecord {
  proxyWallet: string;
  customerId: string;
  agentOwner: string;
  attributionType?: string;
  confidenceBps?: number;
}

export function createComboObservationsLegsStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): ComboObservationsLegsStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS combo_observations_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_venue TEXT NOT NULL,
      source_ticket TEXT NOT NULL,
      wallet_or_account TEXT NOT NULL,
      agent_id TEXT,
      game_id TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT 'game',
      subject TEXT NOT NULL,
      market_kind TEXT NOT NULL,
      side TEXT NOT NULL,
      line_hundredths INTEGER,
      product_class TEXT NOT NULL,
      stake_cents INTEGER NOT NULL,
      odds_american INTEGER,
      identity_sha256 TEXT NOT NULL,
      shape_sha256 TEXT NOT NULL,
      pick_shape_sha256 TEXT NOT NULL,
      placed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_combo_legs_identity
      ON combo_observations_legs(identity_sha256, source_venue);

    CREATE INDEX IF NOT EXISTS idx_combo_legs_shape
      ON combo_observations_legs(shape_sha256, source_venue);

    CREATE INDEX IF NOT EXISTS idx_combo_legs_game_period_subject
      ON combo_observations_legs(game_id, period, subject, market_kind, side);

    CREATE INDEX IF NOT EXISTS idx_combo_legs_account
      ON combo_observations_legs(wallet_or_account, source_venue);

    CREATE TABLE IF NOT EXISTS wallet_customer_attributions (
      proxy_wallet TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      agent_owner TEXT NOT NULL,
      attribution_type TEXT NOT NULL DEFAULT 'IP_CLUSTER_OR_SYNDICATE',
      confidence_bps INTEGER NOT NULL DEFAULT 10000,
      linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (proxy_wallet, customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_attr_agent
      ON wallet_customer_attributions(agent_owner);
  `);

  return new ComboObservationsLegsStore(db);
}

export class ComboObservationsLegsStore {
  constructor(public readonly db: Database) {}

  insertFlatLeg(leg: FlatLegRecord): number {
    const res = this.db
      .query(
        `INSERT INTO combo_observations_legs (
          source_venue, source_ticket, wallet_or_account, agent_id,
          game_id, period, subject, market_kind, side, line_hundredths,
          product_class, stake_cents, odds_american,
          identity_sha256, shape_sha256, pick_shape_sha256,
          placed_at, status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      )
      .run(
        leg.sourceVenue,
        leg.sourceTicket,
        leg.walletOrAccount,
        leg.agentId ?? null,
        leg.gameId,
        leg.period ?? "game",
        leg.subject,
        leg.marketKind,
        leg.side,
        leg.lineHundredths,
        leg.productClass,
        leg.stakeCents,
        leg.oddsAmerican,
        leg.identitySha256,
        leg.shapeSha256,
        leg.pickShapeSha256,
        leg.placedAt,
        leg.status,
      );
    return Number(res.lastInsertRowid);
  }

  insertAttribution(attr: WalletAttributionRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO wallet_customer_attributions (
          proxy_wallet, customer_id, agent_owner, attribution_type, confidence_bps
        ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .run(
        attr.proxyWallet.toLowerCase(),
        attr.customerId.trim().toUpperCase(),
        attr.agentOwner.trim().toUpperCase(),
        attr.attributionType ?? "IP_CLUSTER_OR_SYNDICATE",
        attr.confidenceBps ?? 10000,
      );
  }

  ingestPolymarketCombo(
    orderHash: string,
    proxyWallet: string,
    legs: readonly PolymarketRawOrderLeg[],
    stakeCents: number = 10000,
    placedAt: string = new Date().toISOString(),
  ): void {
    const canonicalLegs: CanonicalLeg[] = legs.map(mapPolyLeg);
    const hashes = computeComboIdentityHashes(canonicalLegs);

    for (const leg of canonicalLegs) {
      this.insertFlatLeg({
        sourceVenue: "polymarket",
        sourceTicket: orderHash,
        walletOrAccount: proxyWallet.toLowerCase(),
        gameId: leg.gameId,
        period: leg.period ?? "game",
        subject: leg.subject,
        marketKind: leg.marketKind,
        side: leg.side,
        lineHundredths: leg.lineHundredths,
        productClass: leg.productClass,
        stakeCents,
        oddsAmerican: null,
        identitySha256: hashes.identitySha256,
        shapeSha256: hashes.shapeSha256,
        pickShapeSha256: hashes.pickShapeSha256,
        placedAt,
        status: "pending",
      });
    }
  }

  ingestF402Ticket(
    ticketNumber: string | number,
    wagerNumber: string | number,
    customerId: string,
    agentId: string,
    legs: readonly F402RawTicketLeg[],
    stakeCents: number = 10000,
    placedAt: string = new Date().toISOString(),
  ): void {
    const sourceTicket = `${ticketNumber}:${wagerNumber}`;
    const canonicalLegs: CanonicalLeg[] = legs.map(mapF402Leg);
    const hashes = computeComboIdentityHashes(canonicalLegs);

    for (const leg of canonicalLegs) {
      this.insertFlatLeg({
        sourceVenue: "f402",
        sourceTicket,
        walletOrAccount: customerId.trim().toUpperCase(),
        agentId: agentId.trim().toUpperCase(),
        gameId: leg.gameId,
        period: leg.period ?? "game",
        subject: leg.subject,
        marketKind: leg.marketKind,
        side: leg.side,
        lineHundredths: leg.lineHundredths,
        productClass: leg.productClass,
        stakeCents,
        oddsAmerican: -110,
        identitySha256: hashes.identitySha256,
        shapeSha256: hashes.shapeSha256,
        pickShapeSha256: hashes.pickShapeSha256,
        placedAt,
        status: "pending",
      });
    }
  }

  /**
   * Ingests a batch of raw `api/Report/Pending` (`e.Pending`) or `api/Report/getGrading` leg rows.
   * Groups legs by `d.TicketNumber + "-" + d.WagerNumber` BEFORE hashing so multi-leg parlays and teasers
   * share the parent ticket's composite `identity_sha256`, `shape_sha256`, and `pick_shape_sha256`.
   */
  ingestF402ReportPendingBatch(
    rows: readonly F402CustomerReportPendingRow[],
    placedAt: string = new Date().toISOString(),
    status: "pending" | "settled" = "pending",
  ): number {
    const groupedTickets = groupF402PendingRowsByTicket(rows);
    let insertedLegs = 0;
    for (const parent of groupedTickets) {
      for (const leg of parent.legs) {
        this.insertFlatLeg({
          sourceVenue: "f402",
          sourceTicket: parent.ticketGroupKey,
          walletOrAccount: parent.customerId,
          agentId: parent.agentId,
          gameId: leg.gameId,
          period: leg.period ?? "game",
          subject: leg.subject,
          marketKind: leg.marketKind,
          side: leg.side,
          lineHundredths: leg.lineHundredths,
          productClass: leg.productClass,
          stakeCents: parent.riskCents,
          oddsAmerican: -110,
          identitySha256: parent.hashes.identitySha256,
          shapeSha256: parent.hashes.shapeSha256,
          pickShapeSha256: parent.hashes.pickShapeSha256,
          placedAt,
          status,
        });
        insertedLegs++;
      }
    }
    return insertedLegs;
  }

  countLegs(): number {
    const row = this.db
      .query(`SELECT COUNT(*) as c FROM combo_observations_legs`)
      .get() as { c: number };
    return row.c;
  }
}
