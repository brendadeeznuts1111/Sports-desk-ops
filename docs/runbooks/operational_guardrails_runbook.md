# SportsDesk & Fantasy402 Operating-Model Guardrails Runbook

## Document Overview

- **Repository**: `sportsdesk-ops`
- **Scope**: Master Book `BILLY666` (668 Sub-Agents, 9,435 Accounts, 2,236 Active Sports Bettors)
- **Architecture Reference**: Native Bun v1.4+ Runtime, `domain-branded-types.ts`, `tokens.toml`
- **Target Audience**: Risk Officers, Downline Desk Managers, Forensic Quant Engineers

---

## 1. Executive Summary & Range Philosophy

Modern bookmaking surveillance requires operating across disciplinary boundaries—combining financial portfolio theory, behavioral psychology, network forensics, and Bayesian inference:

1. **Agent Governance**: Agents acting as 50% co-underwriters introduce agency risks (adverse selection, limit gaming, sharp action hiding) requiring behavioral escrow controls.
2. **Signal Triangulation**: Closing Line Value (CLV) is a continuous price-efficiency sensor, not a binary ban verdict.
3. **Behavioral Retention**: Churn interventions must address specific attrition drivers (delay friction, void disgust, syndicate retirement, beaten price) rather than deploying generic promotions.
4. **Network Forensics**: IP subnet clustering is an initial tripwire requiring multi-factor corroboration to prevent CGNAT and mobile carrier false positives.
5. **Latency Economics**: Confirmation delay gates (0s–15s) incur measurable attrition costs that must be dynamically tuned against prevented leakage.
6. **Empirical Bayes Regularization**: Account-level estimation requires archetype-stratified priors ($\mu_{\text{archetype}}$) with strict shrinkage bounds ($\tau^* = 0.68$, $N \ge 8$).

---

## 2. Guardrail 1: Agent Co-Underwriter Governance & Behavioral Escrow Triggers

### 2.1 The 50% Split Agency Problem

In the SportsDesk master hierarchy, sub-agents retain up to a 50% revenue/loss share on their player downlines. While intended to align interests with the house, pure hold-based compensation produces severe moral hazard:

- **Adverse Selection**: Agents actively onboard high-stakes syndicate action if they negotiate loss caps or delayed weekly settlement terms.
- **Limit Gaming**: Agents split sharp action across multiple sub-accounts to bypass book-level risk filters.
- **Sharp Concealment**: Agents offset sharp winning players against large recreational losing whales within their branch, reporting a net positive hold while leaching house EV.

### 2.2 8-Tier BranchGrade Classification Matrix

Agents are graded on behavioral risk metrics, not raw net dollars:

| BranchGrade   | Name               | Min Hold %                  | Max Toxicity | Max Sharps        | Escrow Holdback | Action Playbook                       |
| :------------ | :----------------- | :-------------------------- | :----------- | :---------------- | :-------------- | :------------------------------------ |
| **`AAA`**     | Prime Citadel      | $\ge +18.0\%$               | $\le 10$     | 0                 | 0%              | Full delegation, VIP credit expansion |
| **`AA`**      | Core Pillar        | $+12.0\%$ to $+17.9\%$      | $\le 25$     | 0                 | 0%              | Standard weekly settlement            |
| **`A`**       | Retail Pool        | $+6.0\%$ to $+11.9\%$       | $\le 40$     | $\le 1$           | 5%              | Routine ticket surveillance           |
| **`BBB`**     | Balanced Flow      | $+2.0\%$ to $+5.9\%$        | $\le 55$     | $\le 2$           | 10%             | Weekly sharp audit review             |
| **`BB`**      | Thin Margin        | $-2.0\%$ to $+1.9\%$        | $\le 70$     | $\le 3$           | 20%             | Cap recreational credit limits        |
| **`B`**       | Deficit Watch      | $-10.0\%$ to $-2.1\%$       | $\le 80$     | $\le 4$           | 35%             | Freeze sub-agent account creation     |
| **`CCC`**     | Vulnerable Deficit | $-25.0\%$ to $-10.1\%$      | $\le 88$     | $\ge 5$           | 50%             | Escrow freeze, mandate +15c vig       |
| **`D_TOXIC`** | Toxic / Syndicate  | $< -25.0\%$ OR Tox $\ge 90$ | Any          | $\ge 1$ Extractor | 100%            | Immediate cutover, desk takeback      |

### 2.3 Mandatory Behavioral Escrow Triggers

Regardless of weekly net profit, escrow holdbacks activate automatically if:

1. **Sharp Leakage Concentration**: Any single bettor accounts for $> 60\%$ of branch net winnings over 7 days.
2. **Off-Peak Timing Cluster**: $> 40\%$ of volume is executed within 90 seconds of global consensus line moves.
3. **Syndicate Linkage**: Branch contains accounts flagged in shared `/24` subnets or correlated `BetGroupIdentifier` syndicates.

---

## 3. Guardrail 2: Multi-Factor CLV Triangulation (Sensor vs. Verdict)

### 3.1 CLV as an Efficiency Sensor

Closing Line Value measures execution price relative to the closing consensus price:
$$\text{CLV (bps)} = \left( \frac{P_{\text{bet}}}{P_{\text{close}}} - 1 \right) \times 10{,}000$$

A positive CLV indicates price-efficient execution, but treating CLV as an automatic ban criteria creates two major operational errors:

- **False Negative (Whale Fallacy)**: High-limit bettors with negative CLV can generate substantial variance-driven house losses or long-term operational profit. For example, account `RF2003` under agent `FAKEMONEY` has an average CLV of -185 bps, yet generates $940,000 in 7-day handle and -$1,006,530 in lifetime net hold. Banning or throttling `RF2003` based on raw volume would destroy a core house revenue pillar.
- **False Positive (Small-Sample Sniper Fallacy)**: A recreational bettor hitting 3 early lines in a row will show +280 bps CLV over a small sample size ($N < 8$), but will revert under larger volume.

### 3.2 The Triangulation Matrix

Decisions require evaluating three orthogonal dimensions:

```
                      Market Depth (High / Liquid)
                                   ▲
                                   │
              [RECREATIONAL RETAIL]│ [STEAM CHASER]
              - High liquidity     │ - Beats moves in major markets
              - Negative CLV       │ - High CLV (+180 bps)
              - Uncapped Limits    │ - Apply 4s-6s Delay Gate
                                   │
◄──────────────────────────────────┼──────────────────────────────────►
Execution Timing (Stale / Post-Move)│ Execution Timing (Originating / Pre-Move)
                                   │
              [WHALE VOLATILITY]   │ [EXECUTION SNIPER]
              - Huge stakes        │ - Off-market props & derivatives
              - Negative CLV       │ - Positive CLV (+250 bps)
              - Collar max risk    │ - Slash limits to $500, 15s Delay
                                   │
                                   ▼
                      Market Depth (Low / Illiquid Props)
```

---

## 4. Guardrail 3: Differentiated Churn Mechanics & Intervention Playbooks

Bettor attrition is not homogeneous. Applying identical marketing retention credits across all exiting accounts wastes capital on syndicates and fails to retain valuable recreational bettors.

### 4.1 Churn Taxonomy & Action Matrix

| Churn Mode                 | Root Mechanism                         | Key Indicators                                                     | Target Cohort                           | Operational Playbook                                                                        |
| :------------------------- | :------------------------------------- | :----------------------------------------------------------------- | :-------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Friction Exit**          | Confirmation delay fatigue             | High bet cancel rate ($>25\%$), drop-off after 10s–15s delay gates | Retail bettors misclassified as snipers | Step down delay gate from 10s $\to$ 2s; verify non-steam status; provide bonus credit       |
| **Void Disgust**           | Frustration with pushed/cancelled legs | High ticket count with voided legs, immediate session termination  | Prop & parlay players                   | Issue discretionary goodwill cash credit for pushes; review automated void settlement rules |
| **Subnet Burnout**         | Syndicate burning exhausted accounts   | Sudden volume halt across 3+ linked accounts within 48h            | Syndicate beards (`BGD101`, `PEY101`)   | Do not attempt retention; mark sub-agent accounts as permanently decommissioned             |
| **Beaten-Price Departure** | Price sensitivity to wide vig          | CLV drop below -250 bps after +20c vig adjustment                  | Price-conscious recreational bettors    | Restore standard -110 pricing on straight spreads; monetize via live in-play and parlays    |

---

## 5. Guardrail 4: Probabilistic /24 Subnet Verification & Clustering Tripwires

### 5.1 Native Fantasy402 IP Tracker Modes (`get-ip-tracker`)

In the Fantasy402 Manager portal under **Reporting** (`data-action="get-ip-tracker"`), the native selector (`#responsive_single`) exposes four discrete forensic query modes:

| Wire Value | Action Name           | Portal Query Scope                | Behavioral & Forensic Surveillance Utility                                                                        |
| :--------- | :-------------------- | :-------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **`A`**    | **Web Access Log**    | Chronological session access log  | Ingests session timestamps, dwell times, and pre-move execution velocity; tracks login decay for `FRICTION_EXIT`. |
| **`B`**    | **Global IP Matcher** | Entire book / downline scan       | Identifies cross-agent and cross-branch IP collisions across all 668 sub-agents under `BILLY666`.                 |
| **`C`**    | **Acct IP Match**     | Single-account sibling search     | Pinpoints all auxiliary accounts sharing IP history with a designated target bettor (e.g., `BGD101` or `RF2003`). |
| **`I`**    | **Users by IP**       | Reverse IP-to-Account enumeration | Resolves all usernames associated with a specific IP address or `/24` subnet to evaluate cluster breadth.         |

#### 5.1.1 Wire format (`getWebLog`)

> The BookDeskOps Desk owns the live contract: `src/risk/weblog.ts` (request builders for all four modes, including per-mode date formatting) and `docs/weblog-runbook.md` (retained index, per-customer security panel). Where this section and Desk disagree, Desk wins. Mode `C` sends both dates as `YYYY-MM-DD`; the other modes use `MM/DD/YYYY`. Desk sends `ip` as the customer ID for every mode except `I`, while the captured mode `B` request below sent it empty.

All four modes are one endpoint; the selector value is the `type` field. Observed in a Manager HAR capture (2026-10-28, portal `v1.0.279`) for mode `B`; the other modes are inferred from the form and still need a capture.

```http
POST https://www.fantasy402.com/cloud/api/Manager/getWebLog
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

agentID=<session agent>&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026
&type=B&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=<session agent>
```

| Field                   | Observed (mode `B`) | Meaning                                                                 |
| :---------------------- | :------------------ | :---------------------------------------------------------------------- |
| `type`                  | `B`                 | Mode: `A`, `B`, `C` or `I` (table above)                                |
| `start`, `end`          | `MM/DD/YYYY`        | Inclusive date range; same day when unset                               |
| `customerID`            | `0`                 | `0` = whole book. Mode `C` should carry the target account (unverified) |
| `ip`                    | empty               | Mode `I` should carry the IP or prefix (unverified)                     |
| `actions`               | `ALL`               | Action filter for the access log                                        |
| `agentID`, `agentOwner` | session master      | Same value on every Manager call in the capture (see 5.5)               |
| `RRO`                   | `1`                 | Sent as `1` on reports, `0` on `getInfoPlayer`; meaning unknown         |
| `operation`             | `getWebLog`         | Echo of the method name; every Manager call sends it                    |

The session is cookie-based (the capture has no `Authorization` header), and the response body was not captured, so the row schema is still undocumented.

### 5.2 Complementary Reporting Endpoints in the Surveillance Lifecycle

The IP Tracker raises a tripwire; the other `Reporting` actions confirm, size and close it. In order of use:

| Stage               | Action                                    | What it contributes                                                               |
| :------------------ | :---------------------------------------- | :-------------------------------------------------------------------------------- |
| 1. Detect           | `get-ip-tracker` mode `B`                 | Book-wide sweep for shared IPs across agents                                      |
| 2. Attribute        | `get-ip-tracker` modes `C` / `I`          | Sibling accounts of one bettor; every account on one IP or `/24`                  |
| 3. Corroborate      | `get-ip-tracker` mode `A`                 | Session timing and dwell for the MFCS timing factor (5.4)                         |
| 4. Grade the branch | `get-agent-performance` (`data-type="C"`) | Downline handle, net won and hold for the 8-tier BranchGrade (`AAA` to `D_TOXIC`) |
| 5. Check intent     | `delete-wager` (_Deleted Wagers_)         | Voids and cancellations: `VOID_HEAVY_DISGUST` and line-chase cancels              |
| 6. Size exposure    | `get-analysis`                            | Market and sport concentration of the cluster's action                            |
| 7. Follow money     | `get-transaction-history`                 | Deposits, withdrawals and credit adjustments shared across the cluster            |
| 8. Settle           | `get-settled-figure` (_Collections_)      | Weekly figure and the agent's 50% liability share before any restriction          |

Only the MFCS (5.4) escalates a cluster; stages 4 to 8 size the response once it does.

### 5.3 The Network False Positive Risk

Flags based purely on shared `/24` IPv4 subnets (`xxx.xxx.xxx.0/24`) generate unacceptable false positive rates due to:

- **Carrier-Grade NAT (CGNAT)**: Mobile cellular carriers (e.g., T-Mobile, Verizon Wireless) route thousands of distinct mobile devices through shared public IPv4 gateway pools.
- **Shared Households / Campus Wi-Fi**: Multiple distinct family members or college dorm residents betting simultaneously.

### 5.4 Multi-Factor Corroboration Scoring

An IP cluster flag from `Global IP Matcher` (`B`) or `Users by IP` (`I`) is strictly an initial tripwire. A cluster is escalated to syndicate classification only when the Multi-Factor Corroboration Score (MFCS) exceeds 75 points:

$$\text{MFCS} = S_{\text{subnet}} + S_{\text{time}} + S_{\text{stake}} + S_{\text{device}} + S_{\text{market}}$$

1. **Subnet Identity ($S\_{\text{subnet}}$)**:
   - Same `/24` subnet: 15 pts
   - Same exact `/32` IP address: 30 pts
2. **Timing Synchronicity ($S\_{\text{time}}$)**:
   - Bets submitted within 500 ms of each other: 30 pts
   - Bets submitted within 5 seconds of each other: 15 pts
3. **Stake Sizing Correlation ($S\_{\text{stake}}$)**:
   - Exact dollar match on off-number stakes (e.g., $1,340 on both accounts): 20 pts
   - Identical maximum allowed table limit on both accounts: 10 pts
4. **Device Fingerprint Matching ($S\_{\text{device}}$)**:
   - Identical Canvas Hash + WebGL Renderer string: 25 pts
   - Identical User-Agent + Screen Resolution: 10 pts
5. **Selection Correlation ($S\_{\text{market}}$)**:
   - Identical non-major proposition or derivative side: 20 pts
   - Shared cross-book `BetGroupIdentifier` (`M.G<id>`): 30 pts

_Rule_: If $\text{MFCS} < 60$, the cluster is categorized as an innocent network collision; no account limits or shared restrictions may be imposed.

### 5.5 Identity Resolution: Global Omnisearch (`search-component`)

Modes `C` and `I` need exact account IDs, which come from the Manager's global search. Evidence: the Manager UI extract (`fantasy402-extract`) and the 2026-10-28 HAR capture.

**Component.** The search box sits in the `search-agents` panel: `.search-component` inside an `.input-group` (6 occurrences), `placeholder="Search accounts..."`, `data-search="true"`. `data-type="all"` (4 occurrences) is the mode that matches both entity types, agents and player accounts, from one query.

**Autofill neutralization.** Browsers treat a text input next to a password field as a login form and fill it with the saved Manager username, which silently replaces the search term. The page defeats this with `autocomplete="new-password"` on the search input plus a dummy `name="password"` input (6 occurrences of each). Any scraper or WebView automation must clear the field before typing, because the fill can still happen in a fresh profile.

**Identity contract.**

- _Reads_ send the bettor ID trimmed and unpadded: opening a player sent `getInfoPlayer` with a 7-character `customerID`.
- _`agentID` / `agentOwner`_ are the logged-in master on all 19 Manager calls in the capture, including `getInfoPlayer`, not the bettor's direct parent agent. Resolve the direct parent from the search result or `getInfoPlayer`'s response (not captured yet), never from these request fields.
- _Padded writes:_ `PaddedCustomerId` (`domain-branded-types.ts`) pads to 11 characters for `updateByColumn`, which this capture does not include. The only padded ID observed is `Log/write`'s `customerID`, padded to 10 characters. Confirm the width with an `updateByColumn` capture before relying on 11.

---

## 6. Guardrail 5: Delay Gate Elasticity & Attrition Calibration Curves

### 6.1 The Latency Tradeoff

Confirmation delay gates (0s to 15s) hold incoming wagers in a pending queue while the risk engine monitors consensus market moves:

- **Benefit**: Neutralizes latency arbitrage and screen scrapers who execute milliseconds before retail feeds update.
- **Cost**: Generates user friction, causes expired quote cancellations, and accelerates churn among non-syndicate bettors.

### 6.2 Empirical Elasticity Schedule

| Delay Tier         | Target Profile                 | Churn Hazard Mult      | Max Hold Protection | Usage Policy                                                |
| :----------------- | :----------------------------- | :--------------------- | :------------------ | :---------------------------------------------------------- |
| **0.0s (Instant)** | Verified Retail (`AAA`, `AA`)  | $1.0\times$ (Baseline) | $0\%$               | Standard default for all recreational accounts              |
| **2.0s – 3.0s**    | Mild Steam Followers           | $1.2\times$            | $45\%$              | Soft defense; minimal perceived friction on mobile          |
| **5.0s – 6.0s**    | Active Steam Chasers (`GP300`) | $1.8\times$            | $80\%$              | Standard sharp defense for fast-moving lines                |
| **10.0s**          | Chronic Extractors             | $3.4\times$            | $95\%$              | Severe control; reserved for accounts with CLV $> +200$ bps |
| **15.0s (Max)**    | Confirmed Snipers (`BGD101`)   | $6.2\times$            | $99\%$              | Intentional friction gate to force syndicate abandonment    |

_Operational Constraint_: Any account placed on $\ge 10.0\text{s}$ delay must have its 7-day attrition rate monitored via the At-Risk Churn Cohort. If the account's CLV drops below +50 bps, the gate must automatically step down to 3.0s.

---

## 7. Guardrail 6: Archetype-Stratified Empirical Bayes Priors

### 7.1 The Failure of Global Shrinkage

Standard Empirical Bayes shrinks an observed player win rate or CLV toward the global population mean:
$$\hat{\theta}_i = B_i \bar{Y} + (1 - B_i) Y_i$$
When applied globally across all 9,435 accounts, the massive retail majority ($\approx 85\%$) pulls true sharp signals toward zero, masking dangerous syndicate snipers while penalizing recreational players who experience short-term winning runs.

### 7.2 Stratified Archetype Priors

Priors are stratified across verified behavioral archetypes using hyper-parameters calibrated from historical settlement data:

| Archetype Code | Archetype Name           | Prior CLV Mean ($\mu_0$) | Prior Variance ($\sigma_0^2$) | Min Sample Floor ($N$) |
| :------------- | :----------------------- | :----------------------- | :---------------------------- | :--------------------- |
| `SNIPER`       | Execution Sniper         | $+240\text{ bps}$        | $18.5$                        | $N \ge 8$              |
| `STEAM`        | Steam / Line Chaser      | $+160\text{ bps}$        | $24.0$                        | $N \ge 12$             |
| `PARLAY_EXT`   | Parlay Extractor         | $+95\text{ bps}$         | $35.0$                        | $N \ge 15$             |
| `WHALE`        | Whale Volatility         | $-140\text{ bps}$        | $65.0$                        | $N \ge 20$             |
| `RECREATIONAL` | Core Recreational Retail | $-380\text{ bps}$        | $42.0$                        | $N \ge 10$             |

### 7.3 Shrinkage Formula & Regularization Threshold

For account $i$ with $N_i$ settled tickets, observed sample mean $Y_i$, and sample variance $s_i^2$, the posterior estimate is:
$$\hat{\theta}_i = \frac{\frac{\mu_{\text{archetype}}}{\sigma_{\text{archetype}}^2} + \frac{N_i Y_i}{s_i^2}}{\frac{1}{\sigma_{\text{archetype}}^2} + \frac{N_i}{s_i^2}}$$

- **Sample Size Gate ($N \ge 8$)**: If $N_i < 8$, the account's Bayes score is locked to $\mu_{\text{archetype}}$. No limit cuts or punitive delay gates may be triggered on $N < 8$.
- _*Optimal Shrinkage Weight ($\tau^* = 0.68$)_*: When $N_i \ge 8$, the shrinkage factor $B_i$ is bounded such that:
  $$B_i = \min\left(0.68, \frac{\sigma_{\text{archetype}}^2}{\sigma_{\text{archetype}}^2 + s_i^2 / N_i}\right)$$
  This prevents hot streaks from prematurely classifying recreational bettors as sharps, while preserving high-confidence detection for genuine execution syndicates.

---

## 8. Incident Escalation & Operational Checklist

When an account or sub-agent triggers risk thresholds:

```
[ALERT TRIGGERED: Sharp Exposure / Downline Leakage]
   │
   ├── Step 1: Run Downline Census & Tree Walk
   │     bun sportsdesk_cli.ts -k [AGENT_ID]
   │
   ├── Step 2: Extract Customer Dossier & Ticket Ledger
   │     bun sportsdesk_cli.ts -C [CUSTOMER_ID]
   │
   ├── Step 3: Audit Multi-Factor Network Corroboration (MFCS)
   │     - Verify /24 subnet, timing burst (<500ms), canvas hash
   │     - Discard CGNAT / mobile false positives (MFCS < 60)
   │
   ├── Step 4: Triangulate CLV vs. Volume & Liquidity Depth
   │     - If Whale (negative CLV, large handle): Cap per-wager limit, DO NOT delay
   │     - If Sniper (positive CLV, off-market prop): Apply 15s delay, slash to $500
   │
   ├── Step 5: Enforce Agent Behavioral Escrow
   │     - If Agent Grade = CCC or D_TOXIC: Freeze 50% holdback, audit downline
   │
   └── Step 6: Dispatch Telegram Risk Alert
         bun sportsdesk_cli.ts -A [CUSTOMER_ID]
```

---

## 9. Mode C (`getWebLog`) Wire Observation Addendum (2026-11-20)

An operator paste of a live Mode `C` (`Acct IP Match`) form request to `POST /cloud/api/Manager/getWebLog` (no response body captured — Tier B request observation only) confirmed four details alongside the 2026-10-28 Mode `B` HAR (Section 5.1.1):

1. **10-field wire order**: `agentID`, `customerID`, `start`, `end`, `type`, `actions`, `ip`, `operation`, `RRO`, `agentOwner`.
2. **Multi-day `YYYY-MM-DD` date window**: Mode `C` accepts an inclusive multi-day ISO range (`start=2026-11-06` .. `end=2026-11-20`) rather than only single-day snapshots.
3. **Mode `C` `ip` field mirrors lowercase customer login**: `ip` carries `<customer-lower>` alongside `customerID=<customer>` (matching the Desk note in Section 5.1.1).
4. **Distinct case-sensitive `agentOwner`**: `agentOwner` can differ from `agentID` (e.g., suffixed operator sub-identity with lowercase characters) and must not be forced equal to `agentID` or uppercased by request builders.

Sanitized request fixture: `tests/fixtures/f402-weblog-mode-c-observed-2026-11-20.json`.
