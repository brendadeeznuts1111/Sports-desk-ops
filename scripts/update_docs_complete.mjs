import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Node-compatible utility: import.meta.path is Bun-only.
// ast-grep-ignore: bun-import-meta-path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const openapiPath = resolve(rootDir, "docs/openapi.json");
const apiRefPath = resolve(rootDir, "docs/api-reference.md");

const openapi = JSON.parse(readFileSync(openapiPath, "utf-8"));

// 1. Add schemas for the 4 quantitative engines
openapi.components = openapi.components || {};
openapi.components.schemas = openapi.components.schemas || {};

openapi.components.schemas.BitemporalIngestionRecord = {
  type: "object",
  required: [
    "id",
    "v_t",
    "valid_to",
    "tx_from",
    "tx_to",
    "price",
    "channel_id",
    "pattern",
  ],
  properties: {
    id: { type: "integer", example: 451 },
    v_t: {
      type: "integer",
      description: "Valid-time start (milliseconds)",
      example: 1793042000000,
    },
    valid_to: {
      type: "integer",
      nullable: true,
      description: "Valid-time end; null if open",
      example: null,
    },
    tx_from: {
      type: "integer",
      description: "Transaction-time commit timestamp",
      example: 1793042000150,
    },
    tx_to: {
      type: "integer",
      nullable: true,
      description: "Transaction-time superseded timestamp; null if active",
      example: null,
    },
    price: {
      type: "integer",
      description: "Parsed board price from XML AST",
      example: -115,
    },
    channel_id: {
      type: "string",
      enum: [
        "Internet",
        "ALERT",
        "GSLIVE",
        "GSBUILDER",
        "CSLEVEL2",
        "BLOCKED",
        "GATEWAY",
      ],
      example: "Internet",
    },
    pattern: {
      type: "string",
      enum: ["NORMAL", "UP", "DOWN", "SPIKE_UP", "SPIKE_DOWN"],
      example: "NORMAL",
    },
    xml_golden_ast_sha256: {
      type: "string",
      example:
        "3b918478f334ed6540f79a026a27f15850094e84070b140b1329a855f728a745",
    },
  },
};

openapi.components.schemas.EmpiricalBayesSharpProfile = {
  type: "object",
  required: [
    "customerID",
    "archetype",
    "rawCLVBasisPoints",
    "shrunkSharpScore",
    "ticketCount",
    "isGated",
  ],
  properties: {
    customerID: { type: "string", example: "BGD101" },
    archetype: {
      type: "string",
      enum: [
        "EXECUTION_SNIPER",
        "STEAM_CHASER",
        "PARLAY_EXTRACTOR",
        "WHALE_VOLATILITY",
        "RECREATIONAL_CASUAL",
      ],
      example: "EXECUTION_SNIPER",
    },
    rawCLVBasisPoints: { type: "integer", example: 240 },
    shrunkSharpScore: { type: "number", example: 86.2 },
    ticketCount: { type: "integer", example: 14 },
    isGated: {
      type: "boolean",
      description: "True if N >= 8 sample floor is met",
      example: true,
    },
    recommendedDelaySeconds: { type: "integer", example: 15 },
  },
};

openapi.components.schemas.MultiFactorCorroborationScore = {
  type: "object",
  required: ["clusterId", "mfcsScore", "classification", "isBreached"],
  properties: {
    clusterId: { type: "string", example: "CLUST-198.51.100.0/24" },
    mfcsScore: { type: "number", minimum: 0, maximum: 100, example: 86.4 },
    breakdown: {
      type: "object",
      properties: {
        subnetScore: { type: "number", example: 30 },
        timeScore: { type: "number", example: 30 },
        stakeScore: { type: "number", example: 20 },
        deviceScore: { type: "number", example: 25 },
        marketScore: { type: "number", example: 30 },
      },
    },
    classification: {
      type: "string",
      enum: [
        "CLEARED_RECREATIONAL",
        "ELEVATED_RISK",
        "BOT_SNIPER_FLAGGED",
        "GHOST_INJECTION_CLAMPED",
      ],
      example: "BOT_SNIPER_FLAGGED",
    },
    isBreached: {
      type: "boolean",
      description: "True if MFCS >= 80",
      example: true,
    },
  },
};

openapi.components.schemas.BranchGradeEscrowPolicy = {
  type: "object",
  required: [
    "agentID",
    "branchGrade",
    "netHoldPercentage",
    "toxicityScore",
    "escrowHoldbackRate",
  ],
  properties: {
    agentID: { type: "string", example: "ATEAM" },
    branchGrade: {
      type: "string",
      enum: ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "D_TOXIC"],
      example: "CCC",
    },
    netHoldPercentage: { type: "number", example: -14.2 },
    toxicityScore: { type: "number", example: 76.0 },
    sharpsCount: { type: "integer", example: 5 },
    escrowHoldbackRate: { type: "number", example: 0.5 },
    actionPlaybook: {
      type: "string",
      example: "Escrow freeze; mandate +15c juice model (-115/-115).",
    },
  },
};

writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), "utf-8");
console.log("Updated openapi.json with quantitative engine schemas.");

// 2. Read existing api-reference.md
let md = readFileSync(apiRefPath, "utf-8");

const deepSections = `

---

## 8. Plane 3 Bitemporal Log Replay & Zero-Copy Bun.JSONL Architecture

In \`sportsdesk_ingestion_replay.ts\`, line updates and market odds stream into append-only JSONL files (\`reports/ingestion-audit.jsonl\`). To prevent timeline collisions and allow historical backtesting, the database models two orthogonal temporal dimensions:

* **Valid Time (\`v_t\` / \`valid_from\` $\\to$ \`valid_to\`)**: When the odds or market state were factually active in the real world. Unclosed intervals default to the open sentinel \`VALID_TIME_OPEN_SENTINEL\` (\`9223372036854775807n\`, \`i64::MAX\`).
* **Transaction Time (\`tx_from\` $\\to$ \`tx_to\`)**: When the physical record was committed to SQLite. Closed on duplicate row IDs to preserve an immutable audit trail of corrections.

\`\`\`sql
-- Enforced via SQLite WAL trigger in sportsdesk_ingestion_replay.ts
CREATE TRIGGER enforce_bitemporal_overlap
BEFORE INSERT ON ingestion_trades
FOR EACH ROW
WHEN NEW.channel_status != 'DROPPED'
BEGIN
  SELECT RAISE(ABORT, 'Bitemporal Overlap on ' || NEW.channel_id)
  WHERE EXISTS (
    SELECT 1 FROM ingestion_trades
    WHERE channel_id = NEW.channel_id
      AND tx_to IS NULL
      AND NEW.valid_from < IFNULL(valid_to, 9223372036854775807)
      AND IFNULL(NEW.valid_to, 9223372036854775807) > valid_from
  );
END;
\`\`\`

* **Zero-Copy ASCII Extraction**: Uses Bun's C++ JSC parser (\`Bun.JSONL.parseChunk\`) to stream directly from \`Uint8Array\` binary buffers, slicing byte offsets with \`buf.subarray(result.read)\` rather than allocating intermediate \`TextDecoder\` strings.
* **Golden XML AST Pinning**: Validates incoming odds XML structures against pre-computed SHA-256 hashes (\`Bun.XML.parse(xml, { compact: false })\`), detecting price anomalies:
  * \`SPIKE_UP\`: $\\text{Price} > 1.20 \\times \\text{Price}_{\\text{prev}}$
  * \`SPIKE_DOWN\`: $\\text{Price} < 0.80 \\times \\text{Price}_{\\text{prev}}$

---

## 9. Empirical Bayes Online Sharp Scoring & CLV Triangulation

Naive win-loss percentages fail because retail noise ($\\approx 85\\%$ of the book) pulls true sharp signals toward zero. SportsDesk regularizes player Closing Line Value (CLV) against archetype-stratified priors:

$$\\text{CLV (bps)} = \\left( \\frac{P_{\\text{bet}}}{P_{\\text{close}}} - 1 \\right) \\times 10{,}000$$

$$\\hat{\\theta}_i = \\frac{\\frac{\\mu_{\\text{archetype}}}{\\sigma_{\\text{archetype}}^2} + \\frac{N_i Y_i}{s_i^2}}{\\frac{1}{\\sigma_{\\text{archetype}}^2} + \\frac{N_i}{s_i^2}}$$

| Behavioral Archetype | Prior Mean ($\\mu_0$) | Prior Variance ($\\sigma_0^2$) | Min Sample Floor ($N$) | Operational Action |
| :--- | :--- | :--- | :--- | :--- |
| **\`EXECUTION_SNIPER\`** | $+240\\text{ bps}$ | $18.5$ | $N \\ge 8$ | Slash limits to $500, apply 15s delay gate. |
| **\`STEAM_CHASER\`** | $+160\\text{ bps}$ | $24.0$ | $N \\ge 12$ | Apply 4s–6s delay gate, monitor consensus lag. |
| **\`PARLAY_EXTRACTOR\`** | $+95\\text{ bps}$ | $35.0$ | $N \\ge 15$ | Restrict correlated multi-leg proposition stacking. |
| **\`WHALE_VOLATILITY\`** | $-140\\text{ bps}$ | $65.0$ | $N \\ge 20$ | Collar per-wager risk, **do not apply delay gates**. |
| **\`RECREATIONAL_CASUAL\`**| $-380\\text{ bps}$ | $42.0$ | $N \\ge 10$ | Standard limits, zero delay friction. |

* **The Whale Fallacy**: High-volume losing whales (e.g. account \`RF2003\` under agent \`FAKEMONEY\`) generate large short-term variance swings despite heavily negative CLV (-185 bps). Throttling or banning them on raw turnover destroys core house profitability.
* **The Regularization Gate ($\\tau^* = 0.68, N_{\\min} \\ge 8$)**: If an account has fewer than 8 settled wagers, its score is locked to $\\mu_{\\text{archetype}}$. No punitive delay gates or limit cuts may be executed on small sample sizes.

---

## 10. Multi-Factor Corroboration Score (MFCS 0–100) & Subnet Clustering Forensics

Raw \`/24\` IPv4 subnet matching produces severe false positives due to Carrier-Grade NAT (CGNAT mobile pools) and university Wi-Fi. A subnet tripwire escalates to syndicate enforcement only when the composite corroboration score reaches $\\ge 80$:

$$\\text{MFCS} = S_{\\text{subnet}} + S_{\\text{time}} + S_{\\text{stake}} + S_{\\text{device}} + S_{\\text{market}}$$

1. **Subnet Identity ($S_{\\text{subnet}}$)**: Same \`/24\` subnet = 15 pts; exact \`/32\` IP match = 30 pts.
2. **Timing Synchronicity ($S_{\\text{time}}$)**: Sub-500ms concurrent placement = 30 pts; sub-5s placement = 15 pts.
3. **Stake Sizing Correlation ($S_{\\text{stake}}$)**: Exact off-number dollar match (e.g. $1,340 on both accounts) = 20 pts; max table limit match = 10 pts.
4. **Device Fingerprint ($S_{\\text{device}}$)**: Matching Canvas hash + WebGL renderer string = 25 pts; matching User-Agent + screen resolution = 10 pts.
5. **Selection Correlation ($S_{\\text{market}}$)**: Identical derivative side = 20 pts; shared cross-book \`BetGroupIdentifier\` (\`M.G<id>\`) = 30 pts.

* **$\\text{MFCS} \\ge 80$ (Critical Breach)**: Flags \`BOT_SNIPER_FLAGGED\` / \`GHOST_INJECTION_CLAMPED\`. The engine executes \`POST /cloud/api/Manager/updateByColumn\` to apply a dynamic 6s–15s delay gate (\`Delay\`) and freeze table limits.
* **$\\text{MFCS} < 60$**: Categorized as an innocent network collision; zero restrictions are imposed.

---

## 11. Agent Co-Underwriter Governance & 8-Tier BranchGrades

Sub-agents retain up to a 50% profit/loss share on their player downlines, creating moral hazard: agents may hide sharp action, negotiate delayed weekly settlements, or conceal winning snipers behind recreational losing whales.

The engine classifies branches using half-open intervals $[min, max)$ with an explicit \`D_TOXIC\` override:

| Grade | Risk Level | Net Hold % Interval | Toxicity Interval | Action Playbook |
| :--- | :--- | :--- | :--- | :--- |
| **\`AAA\`** | Prime Citadel | $[+18.0\\%, +\\infty)$ | $[0, 10)$ | 0% escrow holdback; expand recreational credit. |
| **\`AA\`** | Core Pillar | $[+12.0\\%, +18.0\\%)$ | $[0, 25)$ | 0% escrow holdback; standard weekly settlement. |
| **\`A\`** | Retail Pool | $[+6.0\\%, +12.0\\%)$ | $[0, 40)$ | 5% escrow holdback; routine ticket monitoring. |
| **\`BBB\`** | Balanced Flow | $[+2.0\\%, +6.0\\%)$ | $[0, 55)$ | 10% escrow holdback; weekly sharp audit review. |
| **\`BB\`** | Thin Margin | $[-2.0\\%, +2.0\\%)$ | $[40, 70)$ | 20% escrow holdback; cap recreational limits. |
| **\`B\`** | Deficit Watch | $[-10.0\\%, -2.0\\%)$ | $[50, 80)$ | 35% escrow holdback; freeze sub-account creation. |
| **\`CCC\`** | Vulnerable Deficit | $[-25.0\\%, -10.0\\%)$ | $[65, 88)$ | 50% escrow holdback; mandate +15c juice model. |
| **\`D_TOXIC\`**| Inverted / Toxic | $(-\\infty, +\\infty)$ | $[80, 100]$ or $\\text{Hold} \\le -50\\%$ | 100% upfront cash escrow; slash limits to $1,000. |

* **Precedence Override**: If \`toxicity >= 80 || holdPct <= -50 || (holdPct < -20 && hasSharps)\`, the branch unconditionally resolves to \`D_TOXIC\`, freezing agent commissions until resolved.
`;

if (!md.includes("## 8. Plane 3 Bitemporal Log Replay")) {
  md += deepSections;
  writeFileSync(apiRefPath, md, "utf-8");
  console.log(
    "Appended deep quantitative architecture sections to docs/api-reference.md.",
  );
} else {
  console.log("Deep sections already present in docs/api-reference.md.");
}
