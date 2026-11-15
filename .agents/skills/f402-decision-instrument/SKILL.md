---
name: f402-decision-instrument
description: Build, audit, and run pre-registered, power-gated, cost-matrix-calibrated F402 customer decision instruments and book-wide sharp/bot/syndicate ranking systems. Use when evaluating suspected bots, closing-line sharps, whitelisted exemptions, or multi-account agent-office syndicates.
---

# F402 Customer Decision-Instrument & Book-Wide Ranking Skill (`v3.0.0`)

Produce a **decision instrument** (not a narrative report) for single-customer adjudications (`lib/f402_ccc88412_decision_instrument.ts`) and book-wide customer rankings (`lib/f402_customer_decision_ranking.ts`). Every output must satisfy the nine `v3.0.0` methodological guardrails below.

## 1. Nine Non-Negotiable Methodological Guardrails (`v3.0.0`)

1. **Uncalibrated Heuristic Scores vs. Calibrated Posteriors**:
   - Never label a weighted rubric or a curve-fit normal CDF $\Phi((\text{clvEdgePct} - \mu)/\sigma)$ as a calibrated posterior probability $P(\text{State} \mid D)$ unless it is estimated from a labeled training set with a reliability diagram and Brier score.
   - Report `limitHeuristicScore` and `linkHeuristicScore` as **plain uncalibrated heuristic scores** on $[0, 1]$ compared against the cost-ratio threshold $\tau^* = C_{\text{FP}} / (C_{\text{FP}} + C_{\text{FN}})$.
   - When presenting a conjugate Normal-Normal model on net EV alongside a heuristic score and a subset hypothesis test (e.g., `H1` Football 1H+2H), explicitly disclose that the three metrics are **non-nested** and answer three different questions.

2. **Matched Time Horizons in the Cost Matrix**:
   - Express $C_{\text{FP}}$ (Type I false-positive cost of limiting a negative-EV account) and $C_{\text{FN}}$ (Type II false-negative cost of leaving a true sharp unlimited) in the **exact same billing-cycle time horizon** (e.g., 36-day cycle: $C_{\text{FP}} = \$2,200$, $C_{\text{FN}} = \$1,450$, $\tau^* = 0.6027$; matched 6-month `5.0x` horizon: $C_{\text{FP}} = \$11,000$, $C_{\text{FN}} = \$7,250$, $\tau^* = 0.6027$).
   - Always include a **sensitivity grid** across $0.015\times..10\times$ $C_{\text{FP}}$ and state the exact **flip frontier** ($C_{\text{FP,flip}} = C_{\text{FN}} \cdot s / (1 - s)$).

3. **Same-Ticket Multi-Leg Pairing vs. Distinct-Ticket Sub-5s Automation (`H7`)**:
   - In Fantasy402 (`TicketWriter = "Internet"`), a 2-leg straight bet slip (`PlayNumber = 1` and `PlayNumber = 2` on one `TicketNumber`) receives an identical timestamp by stored-procedure construction (`sp_InsertTicket`).
   - Same-ticket ML + Puckline pairing (`H7`) is a **`SUPPORTED_SYSTEMATIC_STRATEGY_SIGNATURE`**, **not** proof of sub-second UI clicking. Label automation inference as `CONSISTENT_WITH_NOT_PROVEN_BY_SAME_TICKET_DATA` unless **distinct** `TicketNumber`s on `TicketWriter = "Internet"` exhibit sub-5-second inter-ticket gaps (`PROVEN_BY_SUB5S_DISTINCT_TICKET_GAPS`).
   - Exclude third-party cart-batch writers (`TicketWriter = "GSBUILDER"` Props Builder and `TicketWriter = "GSLIVE"` Live In-Play) when computing distinct-ticket inter-bet gaps, as those iframes mint sequential `TicketNumber`s 3–120ms apart during a single cart checkout.

4. **Baseline Flag Composition & Null-Likelihood vs. Posterior Caveat**:
   - When testing a behavioral signature against a book-wide baseline rate $p_0$, audit and disclose the baseline's `SuspectedBot` / `SuspectedBotType` composition (unflagged `N:0` vs other flagged accounts) and state the **direction of bias** (including other flagged accounts in $p_0$ is conservative because it raises $p_0$).
   - Explicitly state that a binomial $p$-value (e.g., $p = 1.18 \times 10^{-16}$) is a **null-hypothesis tail likelihood** $P(D \ge k \mid H_0: p_0)$, **not** a posterior probability $P(\text{Bot} \mid D)$.

5. **Post-Hoc Pre-Registration & Contingency Disclosure**:
   - If hypotheses or thresholds are formalized after exploratory inspection of the active window (`W1` + `W2`), label the envelope `POST_HOC_RETROSPECTIVE` and lead Section 0 with an explicit disclosure if the headline verdict rests on a post-hoc hypothesis (`H7`). Treat the next out-of-sample window (`W3`) as the first true prospective test.

6. **Power Gating per Metric and Denominator (`80%` Power at $\alpha = 0.05$)**:
   - Compute minimum required sample size $n_{\min}$ for $80\%$ one-sided binomial power to detect a $+15\%$ CLV lift over the book prior ($n_{\min} = 42$ for $p_{2,0} = 14.83\% \to 29.83\%$).
   - Gate every cell with $n < n_{\min}$ as `INSUFFICIENT_EVIDENCE`. If a segment is powered for union CLV ($n = 54 \ge 42$) but underpowered on its point-bearing subset ($n = 33 < 42$), report **separate power statuses** for each denominator.

7. **De-Vigged CLV Conversion & Correlated-Pair Variance Decomposition**:
   - Separate `beatPointsRate` ($p_1$) and `beatPriceRate` ($p_2$), compute corrected union $P(A \cup B) = p_1 + p_2 - p_1 p_2$, and convert point/price moves into de-vigged EV% against close (never sum raw points across market types).
   - When decomposing realized PnL into expected CLV PnL + variance swing on paired bets (such as NHL ML + Puckline on the same team), compute standard deviation at the **correlated event level** ($\text{Var}(X_{\text{ML}} + X_{\text{PL}}) = \text{Var}(X_{\text{ML}}) + \text{Var}(X_{\text{PL}}) + 2\text{Cov}(X_{\text{ML}}, X_{\text{PL}})$), not just under leg independence.

8. **Operational `MONITOR` Alerting Triggers**:
   - Every `MONITOR` / `KEEP_BOT_FLAG_ACTIVE_SYSTEMATIC_PATTERN_NEGATIVE_EV` recommendation must define concrete numeric triggers (metric, current baseline, threshold, rolling window, and automated action if crossed) covering rolling Net EV%, point-beat rate $p_1$, pairing/inter-ticket gap regime shifts, and weekly handle/pricing shifts.

9. **Generator Conservation Oracles & Zero Prose-vs-Table Drift**:
   - Every generator script must verify exact conservation of customer counts, wager counts, beat-points counts, beat-price counts, risk, and net PnL across all table partitions (`maxAbsDiscrepancy === 0`) and verify byte-identical SHA-256 digests across two consecutive runs.
   - Bind all markdown prose references dynamically to computed table cells so prose and tables cannot drift.
   - When auditing `getInfoPlayer` wire flags (`lib/f402_get_info_player.ts`), disambiguate `WiseLineMovementWeight = 1` (`DEFAULT_BASELINE_1` DGS factory default vs `> 1` `ELEVATED_SHARP`), `AllowUltraLive = "Y"` vs `AllowEZLive = "N"`, and `AllowBuyPointsExtraGames = "Y"` vs `HalfPointInetFootballFlag = "N"`.

---

## 2. Canonical Entrypoints & Verification Commands

```sh
# 1. Regenerate and verify the v3.0.0 CCC88412 Decision Instrument (JSON + Markdown)
bun scripts/generate_ccc88412_decision_instrument.ts

# 2. Regenerate and verify the v3.0.0 All-Customer Decision Ranking System (6,228 customers)
bun scripts/generate_customer_decision_rankings.ts

# 3. Audit a single player profile with v3.0.0 Decision-Instrument overlay
bun run audit:player-info <path-to-getInfoPlayer.json>

# 4. Run unit & conservation-oracle suites
bun test lib/f402_ccc88412_decision_instrument.test.ts lib/f402_customer_decision_ranking.test.ts lib/f402_weblog_pattern_tracker.test.ts lib/f402_get_info_player.test.ts
```
