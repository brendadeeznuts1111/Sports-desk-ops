---
name: f402-point-buy-taxonomy
description: >-
  Audits, detects, and reprices point purchases (BuyPoints) across Fantasy402 feeds, figure reports,
  and settlement ledgers. Covers football key-number leaks (3, 7, 14, 21), basketball hold dynamics,
  period taxonomy (Game=0 restriction), fractional odds (FinalNumerator), and syndicate profiling.
---

# Fantasy402 Point-Buy & Period Taxonomy Skill

Operational knowledge and procedures for auditing, detecting, and mitigating point-purchase (`BuyPoints`) flow, SubSport taxonomies, and period-scoped betting across Fantasy402 feeds, the live intake socket, and settled ledgers.

---

## 1. Architectural Reality: Pricing Bug vs. Syndicate Profiling

### Core Thesis

When syndicates repeatedly buy half-points on football lines, **the trading desk has a structural pricing bug** — not merely a customer-behavior problem.

- **Football Key Numbers (3, 7, 14, 21)**: Margin distributions have discrete clustering due to scoring quanta (field goals = 3, touchdowns = 7). Moving across 3 or 7 has a **20¢ to 28¢ fair value**.
- **Desk Pricing Bug**: The desk charges a flat **10¢ to 15¢** (`-120` to `-125`) regardless of the number.
- **Economic Result**: Syndicates harvest **+7¢ to +18¢ of positive expected value (+EV)** on every ticket buying onto, off, or across 3 and 7.
- **The P0 Fix**: Reprice half-points on 3 and 7 dynamically to **`-135` / `-140`** in `SportsVigSetup`. Profiling provides telemetry, but repricing eliminates the exploit.

### Why the Bug Does NOT Apply to Basketball

- **Basketball (NBA & NCAA CBB)**: Scoring is continuous (200–240 total points). Margin distributions are bell-shaped and smooth (~3% per margin between 1 and 9).
- **Fair Value**: An NBA half-point is worth only **3.0¢ to 3.5¢**; a 2.0-point move is worth **12¢ to 14¢**.
- **Desk Advantage**: The desk charges **10¢ (`-120`)** for 0.5 pt and **40¢ (`-150`)** for 2.0 pts. Basketball point-buying is a **high-hold house advantage** (-EV for casual bettors).

---

## 2. SubSport Scoping & The In-Play (`LIVE`) Taxonomy

Instead of only scoping by customer logins, desk risk rules must be scoped by **`SportType`**, **`SportSubType`**, and **`ChosenTeamID`** descriptors:

```
┌──────────────────────────────────────────────┬───────────────────┬──────────────────────────────────────────┐
│ Dimension                                    │ Pre-Game Market   │ In-Play / Live Market                    │
├──────────────────────────────────────────────┼───────────────────┼──────────────────────────────────────────┤
│ SportType                                    │ Football, Bball   │ LIVE (ASI EZLive engine)                 │
│ SportSubType (e.g. NBA)                      │ NBA               │ NBA Live                                 │
│ SportSubType (e.g. College Football)         │ College           │ NCAAF Live                               │
│ SportSubType (e.g. NFL Football)             │ NFL               │ NFL Live                                 │
│ SportSubType (e.g. Hockey)                   │ NHL               │ NHL Live                                 │
│ ChosenTeamID Format                          │ "Lakers"          │ "Lakers (Live)"                          │
│ Team1ID / Team2ID                            │ "Penn State"      │ "Penn St (Live)"                         │
│ Rotation Number Range                        │ 100–999           │ 9000-series (9000–9999 = 9000 + base_rot)│
│ Point Buys Allowed?                          │ Allowed (Fball/BB)│ STRICTLY BLOCKED (0 buys across feed)    │
│ Primary Trading Desk Risk                    │ Point-Buy Leaks   │ Feed Latency / Broadcast Clock Arbitrage │
└──────────────────────────────────────────────┴───────────────────┴──────────────────────────────────────────┘
```

### Rotation Mapping Convention

- Pre-Game `#544 Lakers` $\to$ In-Play **`#9544 Lakers (Live)`** (`SportSubType: "NBA Live"`)
- Pre-Game `#111 Penn St` $\to$ In-Play **`#9111 Penn St (Live)`** (`SportSubType: "NCAAF Live"`)
- Pre-Game `#40 Stars` $\to$ In-Play **`#9040 Stars (Live)`** (`SportSubType: "NHL Live"`)

### SubSport Operational Policy

1. **Pre-Game `College` & `NFL` Spreads**: The high-risk point-buy zone. Requires dynamic repricing on 3, 7, 14, 21.
2. **Pre-Game `NBA` & `NCAA` Spreads/Totals**: Point buys allowed; desk retains +4¢ to +26¢ excess house hold.
3. **All `* Live` SubSports (`NBA Live`, `NFL Live`, `NCAAF Live`, `NHL Live`)**:
   - Point purchases are **100% BLOCKED**.
   - Wagers are always graded on full-game outcome (`PeriodNumber: 0`).
   - Risk monitoring focuses on **execution latency** (wagers placed during active in-play drives before odds suspend).

---

## 3. Cross-Sport Availability Matrix

Across the **930,791 live tickets** in `probes/out13/f402-bets.jsonl`:

| Sport (`SportType`) | Sub Sport (`SportSubType`)     | Market Type                      | Point Buys Allowed? | Active Buy Legs | Desk Exposure                                         |
| ------------------- | ------------------------------ | -------------------------------- | :-----------------: | --------------: | ----------------------------------------------------- |
| **Football**        | `College` (CFB)                | Spread                           |       **YES**       |          27,936 | **CRITICAL LEAK**: -120/-125 on 3, 7, 14, 21          |
| **Football**        | `College` (CFB)                | Game Total                       |       **YES**       |           4,446 | **POSITIVE HOLD**: Flat -120 extracts retail vig      |
| **Football**        | `NFL`                          | Spread                           |       **YES**       |          17,555 | **SEVERE LEAK**: -125/-135 on 3 and 7                 |
| **Football**        | `NFL`                          | Game Total                       |       **YES**       |           2,406 | **POSITIVE HOLD**: Flat -120 extracts retail vig      |
| **Basketball**      | `NBA`                          | Spread                           |       **YES**       |           3,364 | **DESK ADVANTAGE**: 40¢ juice charged for 2 pts       |
| **Basketball**      | `NBA`                          | Game Total                       |       **YES**       |             545 | **DESK ADVANTAGE**: Sucker vig trap (fair value < 2¢) |
| **Basketball**      | `NCAA` (CBB)                   | Spread                           |       **YES**       |           1,947 | **DESK ADVANTAGE**: House retains +4¢ to +7¢ hold     |
| **Basketball**      | `NCAA` (CBB)                   | Game Total                       |       **YES**       |             306 | **DESK ADVANTAGE**: High house hold                   |
| **Basketball**      | `WNBA`                         | Spread / Total                   |       **YES**       |             131 | **DESK ADVANTAGE**: High retail hold                  |
| **LIVE**            | `NBA Live` / `NFL Live` / etc. | Live In-Play                     |     **BLOCKED**     |               0 | **IMMUNE**: Point buys disabled on live               |
| **Hockey**          | `NHL`                          | Puck Line (-1.5 / +1.5)          |     **BLOCKED**     |               0 | **IMMUNE**: Alternative Puck Lines only (-1, -2)      |
| **Hockey**          | `Hockey Alter`                 | Underdog Alt Spread (-1.5)       |     **BLOCKED**     |               0 | **IMMUNE**: Fixed discrete lines (+245 to +375)       |
| **Hockey**          | `NHL`                          | Game Total (5.5, 6.0)            |     **BLOCKED**     |               0 | **IMMUNE**: Moneyline juice adjustments only          |
| **Football**        | `College` / `NFL`              | Individual Points Total (Type E) |     **BLOCKED**     |               0 | **IMMUNE**: Betslip disables point buys on Type E     |
| **Basketball**      | `NBA` / `NCAA`                 | Individual Points Total (Type E) |     **BLOCKED**     |               0 | **IMMUNE**: Betslip disables point buys on Type E     |
| **Baseball**        | `MLB`                          | Run Line (-1.5 / +1.5)           |     **BLOCKED**     |               0 | **IMMUNE**: Alternative Run Lines only                |
| **Soccer**          | `Top Soccer`                   | Goal Lines / Totals              |     **BLOCKED**     |               0 | **IMMUNE**: Asian handicap lines only                 |

### Puck Line Pricing & Underdog Alternative Lines

- **Standard Puck Line (`NHL`)**: Fixed spread at `-1.5` (favorite) / `+1.5` (underdog). Overtime is included, but sudden-death OT rules dictate that a game ending tied in regulation can only finish with a 1-goal margin. Thus, `-1.5` must win in regulation, while `+1.5` automatically cashes if tied at 60:00.
- **Underdog Side, -1.5 Alt Line (`Hockey Alter`)**:
  > **Underdog side, -1.5 alt line = bet the underdog to win by 2+ goals. Fair price ≈ +350 to +400 for a 20–22% probability. Observed book prices range +245 to +375.**
- **Implied Probability Gap (pp) vs. Unhedged Single-Bet Expected Hold (%)**:
  The trading desk measures both the raw probability gap ($p_{\text{posted}} - p_{\text{fair}}$) and the mathematical bookmaker hold ($H = 1 - p_{\text{fair}} \times (1 + \text{odds}_{\text{decimal}})$):

  | Selection / Price                    | Posted Implied | Fair = 20% ($d_{\text{fair}}=5.0$) Prob Gap | Fair = 20% Expected Hold | Fair = 22% ($d_{\text{fair}}=4.55$) Prob Gap | Fair = 22% Expected Hold |
  | ------------------------------------ | :------------: | :-----------------------------------------: | :----------------------: | :------------------------------------------: | :----------------------: |
  | **Leafs Alt +260** ($d=3.60$)        |     27.78%     |                **+7.78 pp**                 |        **+28.0%**        |                 **+5.78 pp**                 |        **+20.8%**        |
  | **Blue Jackets Alt +270** ($d=3.70$) |     27.03%     |                **+7.03 pp**                 |        **+26.0%**        |                 **+5.03 pp**                 |        **+18.6%**        |
  | **Oilers Alt +315** ($d=4.15$)       |     24.10%     |                **+4.10 pp**                 |        **+17.0%**        |                 **+2.10 pp**                 |        **+8.7%**         |
  | **Ducks Alt +375** ($d=4.75$)        |     21.05%     |                **+1.05 pp**                 |        **+5.0%**         |                 **−0.95 pp**                 |        **−4.5%**         |

  Across the 3 tickets actually fired by `GX195` (Leafs, CBJ, Oilers), the unhedged single-bet expected hold retained by the desk was **+17.0% to +28.0%** (at $p=20\%$) or **+8.7% to +20.8%** (at $p=22\%$).

- **Empty-Net Mechanics & Empirical Margin Evidence**:
  - **Unconditional League Rate**: Across historical full-season NHL regular-season data, **~42% to 45% of all games finish with a 1-goal margin**.
  - **Conditional In-Play Mechanics (Vollman et al.)**:
    - _Bibliographic Note_: Approximate reference, subject to physical copy verification (Rob Vollman, _Stat Shot_, ECW Press, 2018, Goalie-Pull Dynamics dataset).
    - Describes the strictly conditional state (_trailing by 1 with goalie pulled and < 2:00 remaining_):
      - Empty-Net Goal (leading team extends to 2+ goals): **29.4%**
      - Equalizer (trailing team forces OT): **12.1%**
      - No change (1-goal final): **58.5%**
    - _Critical distinction_: This 58.5% rate is strictly conditional on the late-game goalie-pull state, not the unconditional 1-goal rate across all games.
  - **Sample Illustrative Data (2026-11-03 GX195 Portfolio Slate)**:
    - On this date, there were **11 scheduled NHL games league-wide**. Customer `GX195` placed 8 wagers across **7 of the 11 games (63.6% slate coverage, leaving 4 games unbet)**.
    - These 8 wagers represent **0.286%** of the 2,794 deduplicated hockey puck line wagers in the intake corpus (or 0.203% of the 3,932 raw intake sightings).
    - In this 7-game slate, **4 of 7 games (57.1%)** ended with a 1-goal margin (Mammoth 3–2, Devils 4–3, Ducks 5–4, Stars 6–5).
    - With $n=7$, the 95% confidence interval is roughly **25% to 86%**; these observations **illustrate** and are consistent with the historical ~42–45% rate, but do not replace larger-sample validation across all graded tickets.
    - 2-goal margin: **1 of 7 (14.3%)** (Wild 4–2); $\ge$3-goal margin: **2 of 7 (28.6%)** (Predators 4–1, Blue Jackets 7–2).
    - Underdog 2+ goal wins in the sample: **1 of 7 (14.3%)** (Blue Jackets 7–2).

---

## 4. Period Taxonomy: `PeriodDescription` & `PeriodNumber`

Fantasy402 stores period scoping as a paired tuple: `PeriodDescription` (fixed-width string with trailing padding) and `PeriodNumber` (integer code).

### Canonical Mapping & Database Padding

The backend database stores `PeriodDescription` as fixed-width `CHAR(20)`, which includes trailing whitespace on raw API payloads:

| `PeriodNumber` | Raw Wire `PeriodDescription` | Trimmed Label   | Portal UI `<option>`                      | Market Scope                    |
| :------------: | ---------------------------- | --------------- | ----------------------------------------- | ------------------------------- |
|    **`-1`**    | `""` / `null`                | `"All Periods"` | `<option value="-1">All Periods</option>` | Global query filter             |
|    **`0`**     | `"Game                "`     | `"Game"`        | `<option value="0">Game</option>`         | Full game (includes OT)         |
|    **`1`**     | `"1st Half            "`     | `"1st Half"`    | `<option value="1">1st Half</option>`     | First half derivative           |
|    **`2`**     | `"2nd Half            "`     | `"2nd Half"`    | `<option value="2">2nd Half</option>`     | Second half derivative          |
|    **`3`**     | `"1st Quarter         "`     | `"1st Quarter"` | `<option value="3">1st Qtr</option>`      | Q1 derivative (or P1 in hockey) |
|    **`4`**     | `"2nd Quarter         "`     | `"2nd Quarter"` | `<option value="4">2nd Qtr</option>`      | Q2 derivative (or P2 in hockey) |
|    **`5`**     | `"3rd Quarter         "`     | `"3rd Quarter"` | `<option value="5">3rd Qtr</option>`      | Q3 derivative (or P3 in hockey) |
|    **`6`**     | `"4th Quarter         "`     | `"4th Quarter"` | `<option value="6">4th Qtr</option>`      | Q4 derivative                   |

### The Invariant Rule: Point Buys are Game-Only (`PeriodNumber: 0`)

**100% of point buys occur strictly on `PeriodDescription: "Game"` (`PeriodNumber: 0`).**

- Point buying is programmatically **locked out** on halves (`1st Half`: 1, `2nd Half`: 2) and quarters (1Q..4Q: 3..6).
- Sharp accounts betting 2nd Halves (`CCC88412`, `BRT5235`) bet **straight posted lines** with zero point adjustments.
- Live in-play handicap lines (`SportType: "LIVE"`, e.g. `LIVE #9548 Lakers (Live)`) grade on the full final score, so their `PeriodDescription` is always `"Game"` (`PeriodNumber: 0`).

### Text Parsing Regex for Ticker Strings

On live socket ticker strings where `PeriodNumber` is not a standalone field:

```typescript
const match = desc.match(/-\s*For\s+([^-]+)$/i);
const periodText = match ? match[1].trim() : "Game";
// "- For Game"     -> PeriodDescription: "Game",     PeriodNumber: 0
// "- For 2nd Half" -> PeriodDescription: "2nd Half", PeriodNumber: 2
```

---

## 5. Feed Schemas & Detection Queries

Detection requires understanding how the three Fantasy402 tiers encode wagers:

```
┌────────────────────────┬─────────────────────┬───────────────────┬──────────────────────────────────────────┐
│ Tier                   │ BuyPoints Field?    │ OrigSpread Field? │ Where the Buy Actually Lives             │
├────────────────────────┼─────────────────────┼───────────────────┼──────────────────────────────────────────┤
│ Live Ticker (f402-bets)│ Absent from JSON    │ Absent from JSON  │ Text in ShortDesc: "- buying ½ For Game" │
│ Settled (getGraded)    │ Absent from LIST    │ Absent from LIST  │ Text in Description: "buying &#189;"     │
│ Figure Date / Pending  │ Numeric (0.5, 1.0)  │ Unadjusted line   │ Explicit BuyPoints column + Description  │
└────────────────────────┴─────────────────────┴───────────────────┴──────────────────────────────────────────┘
```

### SubSport Classifier & Point Parser

Use `classifySubSport` and `parseBuyPointsFromDesc` in [`lib/f402_figure_date_enricher.ts`](file:///Users/nolarose/.gemini/antigravity/worktrees/sportsdesk-ops/portal_period_taxonomy/lib/f402_figure_date_enricher.ts):

```typescript
export function isLiveSubSport(
  sportType?: string,
  sportSubType?: string,
  teamId?: string,
): boolean {
  if (sportType?.trim() === "LIVE") return true;
  if (sportSubType?.includes("Live")) return true;
  if (teamId && /\(Live\)/i.test(teamId)) return true;
  return false;
}
```

### DailyFigureDate & Schedule Rotation Variance

Rotation numbers in North American sportsbooks are assigned **per game on the daily schedule**, not as permanent team identifiers:

- **Odd vs. Even Convention**: Odd numbers designate the **Visiting / Away Team**; Even numbers designate the **Home Team**.
- **Reconciliation Example (Dallas Stars #40 vs #9)**:
  - On **2026-10-02** (`DailyFigureDate: "2026-10-02"`): Dallas Stars were the **Home team** assigned rotation **`#40`** (paired with Away `#39 Blues`). Note: Preseason contest (`UNVERIFIED — likely preseason`).
  - On **2026-11-03** (`DailyFigureDate: "2026-11-03"`): Dallas Stars were the **Visiting team** assigned rotation **`#9`** (paired with Home `#10 Washington Capitals`). Regular season contest.
- Canonical event identity is formed by combining `DailyFigureDate` with canonical team tokens:
  `{SubSport}-{YYYYMMDD}-{AwayTeam}@{HomeTeam}` (e.g. `NHL-20261103-DallasStars@WashingtonCapitals`).

### Canonical Team Tokenization (`canonicalTeamToken`)

To ensure deterministic join keys across disparate venue strings:

1. Normalizes `Saint ` to `St.`
2. Normalizes `St ` (without dot) to `St.`
3. Collapses internal whitespace while strictly preserving punctuation (periods, hyphens, apostrophes).

- `St. Louis Blues`, `St Louis Blues`, `Saint Louis Blues` $\implies$ **`St.LouisBlues`**.
- `Dallas Stars` $\implies$ **`DallasStars`**.
- `Tampa Bay Lightning` $\implies$ **`TampaBayLightning`**.

---

### Data Ingestion Schema Boundary: Intake Stream vs. Settlement Report

The platform operates on two distinct data architectural tiers:

1. **Intake Tier (`f402-bets.jsonl`)**: Lean 15-key stream emitted by the socket at bet intake time **before games are played**.
   - Keys: `["AgentID", "AgentLogin", "AmountWagered", "CustomerID", "InsertDateTime", "Login", "ShortDesc", "TicketWriter", "ToWinAmount", "VIP", "VolumeAmount", "WagerNumber", "WagerType", "capturedAtMs", "isFirstObservation"]`.
   - **Telemetry Boundary**: It contains NO `SportType`, `SportSubType`, `PeriodNumber`, `PeriodDescription`, `AdjSpread`, `OrigSpread`, `FinalScore`, `Outcome`, or `AmountWon`. Every market and league attribute must be extracted by parsing `ShortDesc`.
   - **Duplicate Sightings**: Multiple observations per `WagerNumber` exist across poller reconnects and worker queues; deduplication via `WagerNumber` is required when computing unique ticket counts.
2. **Settlement Tier (`/cloud/api/Report/getWagersByFigureDate`)**: Post-match accounting batch report containing full structured fields, final scores, P&L outcomes, and advisory fractional ladders. All field references to structured columns apply to this endpoint.

---

## 6. Pricing Representation & `FinalNumerator`

Fantasy402 wagers store price and payout terms in three simultaneous formats:

1. **`FinalMoney`** (American Odds): `-110`, `+110`, `-145`, `-220`.
2. **`FinalDecimal`** (European Decimal): `1.9091`, `2.1000`, `1.6897`, `1.4545`. Payout multiplier: $\text{Stake} \times \text{FinalDecimal}$.
3. **`FinalNumerator` & `FinalDenominator`** (Fractional Odds): $\frac{N}{D}$.
   - Payout Profit: $\text{Stake} \times \frac{\text{FinalNumerator}}{\text{FinalDenominator}}$.
   - Formula: $\text{FinalDecimal} = 1 + \frac{\text{FinalNumerator}}{\text{FinalDenominator}}$.
   - Purpose: Ensures deterministic integer settlement without floating-point rounding drift.

| FinalMoney | FinalNumerator | FinalDenominator | Fractional Form | FinalDecimal | Settled Terms on \$100 Risk |
| ---------- | :------------: | :--------------: | :-------------: | :----------: | --------------------------- |
| `-110`     |       10       |        11        |     `10/11`     |    1.9091    | Risk \$110 to win \$100     |
| `+110`     |       11       |        10        |     `11/10`     |    2.1000    | Risk \$100 to win \$110     |
| `-145`     |       11       |        16        |     `11/16`     |    1.6897    | Risk \$145 to win \$100     |
| `-220`     |       5        |        11        |     `5/11`      |    1.4545    | Risk \$220 to win \$100     |

### Settlement Integrity: P&L Accounting & Advisory Ladder Drift

1. **`AmountWon` Semantics (Profit, Not Return)**:
   - In Fantasy402 reporting, **`AmountWon` is pure net profit**, not gross return.
   - `AmountLost` is pure lost stake (`AmountWagered`).
   - Total returned capital to the customer balance on a winning ticket is $\text{AmountWagered} + \text{AmountWon}$. Downstream accounting engines must never add stake to `AmountWon` twice.

2. **`FinalDecimal` & `Num/Denom` Advisory Defect**:
   - Across live feeds, `FinalDecimal` and `FinalNumerator`/`FinalDenominator` represent advisory UK bookmaker ladder steps that often round or drift from `FinalMoney`:
     - Wild: `FinalMoney: +150` $\implies$ `FinalDecimal: 2.50`, but fractional is `29/20` ($1.45$).
     - Hurricanes: `FinalMoney: +135` $\implies$ `FinalDecimal: 2.35`, but fractional is `13/10` ($1.30$).
     - Maple Leafs: `FinalMoney: +123` $\implies$ `FinalDecimal: 2.20`, but fractional is `6/5` ($1.20$).
     - Canucks: `FinalMoney: +138` $\implies$ `FinalDecimal: 2.35`, but fractional is `27/20` ($1.35$).
   - **Settlement Invariant**: Downstream pipelines must treat **`AmountWagered` and `ToWinAmount`** as the single authoritative source of truth for P&L reconciliation; `FinalDecimal` and fractional fields are strictly secondary telemetry.

---

## 7. Dynamic Repricing Formulation for Football Spreads

To fix the football pricing bug without disabling point buys:

$$|M_{\text{fair}}| = \left( \frac{P_0 + \Delta P}{1 - (P_0 + \Delta P)} \right) \times 100$$

- **Key 3.0**: $\Delta P = +5.5\% \implies$ Set desk price to **`-140`** (currently `-120`).
- **Key 7.0**: $\Delta P = +4.5\% \implies$ Set desk price to **`-135`** (currently `-125`).
- **Key 14.0 / 21.0**: $\Delta P = +2.5\%\text{--}3.0\% \implies$ Set desk price to **`-125` to `-128`**.
- **Dead Numbers**: Maintain **`-120`**.
