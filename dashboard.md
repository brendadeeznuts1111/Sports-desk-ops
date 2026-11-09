# 📊 SportsDesk & Fantasy402 Real-Time Surveillance Dashboard

> Live Risk Telemetry · Real-time Bettor Profiling & Sharp Rating · Desk Hotline: [Demodev Desk](https://t.me/demodevdeskbot)

---

## 🎯 Top Rated Sharp Bettors (Live Surveillance)

| Customer ID                                                     | Sharpness Score |      Tier      | Risk Level | Primary Archetype          | Bayesian Skill (95% CI)  | CLV t-stat (p-val) | Kelly Sizing  | Recommended Action  |
| :-------------------------------------------------------------- | :-------------: | :------------: | :--------: | :------------------------- | :----------------------: | :----------------: | :-----------: | :-----------------: |
| [GP301](https://fantasy402.com/manager.html?customer=GP301)     | **9.6 / 10.0**  | `ELITE_SHARP`  | `CRITICAL` | `key_number_buyer`         | **58.2%** [54.1%, 62.3%] | `+4.12` (p=0.0001) |  Half-Kelly   | 🚨 `ALERT_OPERATOR` |
| [BRT5229](https://fantasy402.com/manager.html?customer=BRT5229) | **8.9 / 10.0**  | `ELITE_SHARP`  | `CRITICAL` | `key_number_buyer`         | **56.8%** [52.4%, 61.2%] | `+3.45` (p=0.0006) |  Half-Kelly   | 🚨 `ALERT_OPERATOR` |
| [ST100](https://fantasy402.com/manager.html?customer=ST100)     | **8.2 / 10.0**  |    `SHARP`     |   `HIGH`   | `early_line_mover`         | **55.4%** [51.0%, 59.8%] | `+2.89` (p=0.0038) |   Qtr-Kelly   | ⚠️ `ALERT_OPERATOR` |
| [LIVE99](https://fantasy402.com/manager.html?customer=LIVE99)   | **7.8 / 10.0**  |    `SHARP`     |   `HIGH`   | `in_play_specialist`       | **54.9%** [50.2%, 59.6%] | `+2.61` (p=0.0091) |   Qtr-Kelly   | ⚠️ `ALERT_OPERATOR` |
| [BK119](https://fantasy402.com/manager.html?customer=BK119)     | **6.4 / 10.0**  |  `SEMI_SHARP`  | `ELEVATED` | `post_halftime_specialist` | **53.1%** [48.5%, 57.7%] | `+1.84` (p=0.0658) | Undisciplined |    👁️ `MONITOR`     |
| [RF2003](https://fantasy402.com/manager.html?customer=RF2003)   | **3.8 / 10.0**  | `RECREATIONAL` | `STANDARD` | `recreational`             | **49.2%** [44.8%, 53.6%] | `-0.42` (p=0.6744) |   Flat Unit   |     ✅ `ACCEPT`     |
| [SQUARE1](https://fantasy402.com/manager.html?customer=SQUARE1) | **1.2 / 10.0**  |    `SQUARE`    |   `LOW`    | `square`                   | **43.5%** [38.1%, 48.9%] | `-3.15` (p=0.0016) |  Martingale   |     ✅ `ACCEPT`     |

---

## ⚡ Real-Time Incoming Wager Profiling Stream

- 🚨 **CRITICAL ALERT** `#W-99812` by [GP301](https://fantasy402.com/manager.html?customer=GP301): Bought `0.5pt` onto key number `3` (`-2.5` ➔ `-3.0`, Risk: `$5,500`). Action: `ALERT_OPERATOR` (autoExecute: `false`).
- 🚨 **CRITICAL ALERT** `#W-99815` by [BRT5229](https://fantasy402.com/manager.html?customer=BRT5229): Bought `1.0pt` across key number `7` (`-6.5` ➔ `-7.5`, Risk: `$10,000`). Action: `ALERT_OPERATOR`.
- ⚠️ **HIGH STEAM** `#W-99820` by [ST100](https://fantasy402.com/manager.html?customer=ST100): Pregame steam move on Kansas City Chiefs `-3.5` (price advantage: `+18¢` vs close).
- ℹ️ **STANDARD** `#W-99824` by [RF2003](https://fantasy402.com/manager.html?customer=RF2003): NFL Total Over `44.5` (Risk: `$250`). Action: `ACCEPT`.

---

## 📈 Sport & Exposure Breakdown

| Sport                | Active Handles (USD) | Open Bets | Sharp Exposure (%) |     Dominant Timing      |
| :------------------- | :------------------: | :-------: | :----------------: | :----------------------: |
| **NFL Football**     |     `$1,248,500`     |   `412`   |      `44.2%`       | Pregame (Closing Window) |
| **CFB Football**     |      `$782,000`      |   `285`   |      `36.8%`       |      Halftime / 2H       |
| **NBA Basketball**   |      `$624,300`      |   `330`   |      `28.5%`       | In-Play (Live Quarters)  |
| **NCAAB Basketball** |      `$145,200`      |   `98`    |      `18.1%`       |     Under Derivative     |
| **Other / Soccer**   |      `$89,400`       |   `64`    |       `6.5%`       |         Pregame          |

---

## 🌐 Bun Native DNS Cache & Networking Telemetry

> Resolver Backend: `system` (macOS non-blocking system API) · Cache: `256 entries` (30s TTL) · Auto-warmed via `dns.prefetch`

| Endpoint Host                                 | Port  | Service Component                  | Pre-warm Status |
| :-------------------------------------------- | :---: | :--------------------------------- | :-------------: |
| `fantasy402.com`                              | `443` | Fantasy402 Manager Portal          | 🟢 `PREFETCHED` |
| `pub-d061f943df0e4477ba7ff200721eddb1.r2.dev` | `443` | Cloudflare R2 Public Gateway       | 🟢 `PREFETCHED` |
| `api.telegram.org`                            | `443` | Telegram Bot API (@demodevdeskbot) | 🟢 `PREFETCHED` |
| `clob.polymarket.com`                         | `443` | Polymarket CLOB Trading API        | 🟢 `PREFETCHED` |

---

---

## 👥 Customer Profiling & Behavioral Sharp Showcase

### Profiled Customer Cohorts & Corpora

| Cohort / Registry                     |   Count   | Description & Evidence Source                                                                                 |
| :------------------------------------ | :-------: | :------------------------------------------------------------------------------------------------------------ |
| **Committed Backtest Cohort**         |  **49**   | 4-week CFB/NBA historical backtest with CLV, volume, hold, and parlay data (`docs/backtest-4wk-cfb-nba.json`) |
| **Key Number Buyer Watchlist**        |   **5**   | Elite sharps targeting football key numbers 3, 7, 10, 14, 21 (`KEY_NUMBER_BUYER_PROFILES`)                    |
| **Hook Syndicate Watchlist**          |   **5**   | Downline accounts exploiting half-point hooks (`HALF_POINT_HOOK_SYNDICATE_PROFILES`)                          |
| **CI Synthetic Fixture Book**         |   **6**   | Edge case test cohort (`tests/fixtures/backtest/enriched_customers_full.json`)                                |
| **Local Customer Book Specification** |  **220**  | Full operator book (`enriched_customers_full.json`, 1,100 sampled tickets across 29 agents)                   |
| **Broad Surveillance Surface**        | **4,914** | Unique customer identifiers across all historical captures and weblogs                                        |

### Multidimensional Profiling Architecture

- **Unified Sharpness Composite Index (0.0 - 10.0)**: Decomposed into CLV (3.0), Bayesian Skill (2.5), Sizing Discipline (1.5), Signature Specialization (2.0), and Timing Exploitation (1.0).
- **Stake Sizing Inequality**: Exact Gini coefficient (0.0 = Flat Unit, 1.0 = Martingale Chaser).
- **Correlated Parlay Forensics**: Automated detection of Favorite Spread + Over, Underdog + Under, and 1H/Game crosses.
- **Timing Fingerprints**: Classification into Early Originators (>24h), Steam Chasers, Closing Line Snipers (<15m), and Halftime Specialists.
- **Operator Desk Directives**: Automated stake limit caps ($250 - $25,000), in-play delays (3s), line shading (10-20¢), and shadow copy multipliers.

---

## ⚙️ Automated Shell Directives

```sh
# Health probe trigger
echo "Desk health check: OK"
```
