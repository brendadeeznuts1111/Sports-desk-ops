import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Node-compatible utility: fileURLToPath keeps this script runnable outside Bun.
const filename = fileURLToPath(import.meta.url);
const dir = dirname(filename);
const rootDir = resolve(dir, "..");
const openapiPath = resolve(rootDir, "docs/openapi.json");
const apiRefPath = resolve(rootDir, "docs/api-reference.md");

const openapi = JSON.parse(readFileSync(openapiPath, "utf-8"));

// 1. Ensure all schemas exist
openapi.components = openapi.components || {};
openapi.components.schemas = openapi.components.schemas || {};

openapi.components.schemas.SysexitCode = {
  type: "integer",
  description: "Standard BSD/Linux sysexits.h fail-closed process exit codes",
  enum: [0, 64, 72, 75, 77],
  "x-enum-varnames": [
    "EX_OK",
    "EX_USAGE",
    "EX_DATAERR",
    "EX_TEMPFAIL",
    "EX_NOPERM",
  ],
  example: 0,
};

openapi.components.schemas.MutationClassification = {
  type: "string",
  description: "Specification-grade mutation classification outcome",
  enum: [
    "COMMITTED",
    "UNVERIFIED_COMMIT",
    "SILENT_NO_OP",
    "REJECTED",
    "MODEL_ERROR",
    "QUBIC_UI_ONLY_404",
    "POISONED_PATH_500",
    "GATEWAY_FAULT_500",
    "UPSTREAM_UNAVAILABLE",
    "SHAPE_DRIFT",
  ],
  example: "COMMITTED",
};

openapi.components.schemas.WirePayloadErrorClassification = {
  type: "string",
  description: "Transport and payload wire error classification",
  enum: [
    "AUTHENTICATION_SESSION_EXPIRED",
    "WIRE_PAYLOAD_TRUNCATED",
    "WIRE_PAYLOAD_SHAPE_DRIFT",
    "CSRF_PAIRING_MISMATCH",
    "TRANSPORT_TIMEOUT",
    "CALLER_ABORTED",
    "POISONED_PATH_DETECTED",
    "INVALID_IDENTIFIER_LENGTH",
  ],
  example: "AUTHENTICATION_SESSION_EXPIRED",
};

openapi.components.schemas.StandardWireError = {
  type: "object",
  required: ["error", "code", "sysexitCode", "retryable"],
  properties: {
    error: {
      type: "string",
      example: "Session expired or invalid bearer token",
    },
    code: { $ref: "#/components/schemas/WirePayloadErrorClassification" },
    sysexitCode: { $ref: "#/components/schemas/SysexitCode" },
    retryable: { type: "boolean", example: true },
    retryAfterMs: { type: "integer", example: 250 },
  },
};

openapi.components.schemas.NeuronLayerToken = {
  type: "object",
  required: [
    "neuronId",
    "label",
    "layer",
    "hexColor",
    "channelCode",
    "operationalRole",
  ],
  properties: {
    neuronId: { type: "string", example: "L18.N0204" },
    label: { type: "string", example: "Retail Pregame Baseline Gate" },
    layer: { type: "integer", example: 18 },
    hexColor: {
      type: "string",
      pattern: "^#[0-9a-fA-F]{6}$",
      example: "#1d84b5",
    },
    channelCode: { type: "string", example: "Internet" },
    operationalRole: {
      type: "string",
      example:
        "Retail pregame baseline flow monitoring and twin matching target.",
    },
  },
};

openapi.components.schemas.ManagerDomLocalizationKey = {
  type: "object",
  required: ["key", "label", "domSelector", "wireMapping", "operationalRole"],
  properties: {
    key: { type: "string", example: "L-1029" },
    label: { type: "string", example: "Source" },
    domSelector: { type: "string", example: 'th[data-language="L-1029"]' },
    wireMapping: { type: "string", example: "TicketWriter" },
    operationalRole: {
      type: "string",
      example:
        "Ingestion channel discriminator (Internet, ALERT, GSLIVE, GSBUILDER, CSLEVEL2).",
    },
  },
};

// 2. Ensure all 36 paths are registered
const pathsToAdd = {
  "/cloud/api/System/verifySession": {
    post: {
      tags: ["System & Authentication"],
      summary: "Verify Active JWT Session",
      description:
        "Validates active token integrity. On HTTP 401, triggers 1x re-mint cycle before failing closed.",
      operationId: "verifySession",
      security: [{ BearerAuth: [] }],
      "x-retryable": true,
      responses: {
        200: {
          description: "Session valid",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  valid: { type: "boolean", example: true },
                  expiresAt: { type: "integer", example: 1793042000 },
                },
              },
            },
          },
        },
        401: { description: "Session expired (re-mint triggered)" },
      },
    },
  },
  "/api/desk/auth/me": {
    get: {
      tags: ["System & Authentication"],
      summary: "Inspect Current Operator Session",
      description:
        "Retrieves active operator session ID from HTTP-only cookies.",
      operationId: "getOperatorSession",
      responses: {
        200: {
          description: "Active session confirmed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  authenticated: { type: "boolean", example: true },
                  sessionId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        401: { description: "Unauthenticated" },
      },
    },
  },
  "/cloud/api/Manager/getCustomerNotes": {
    post: {
      tags: ["Manager & Player Admin"],
      summary: "Get Customer Risk Notes & Surveillance Annotations",
      description:
        "Fetches operator notes, sharp tags, and historical risk flags for a player.",
      operationId: "getCustomerNotes",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["customerID"],
              properties: {
                customerID: { type: "string", example: "CB112_1    " },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Notes retrieved",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  notes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        timestamp: { type: "string" },
                        author: { type: "string" },
                        text: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/cloud/api/Manager/updateCustomerNotes": {
    post: {
      tags: ["Manager & Player Admin"],
      summary: "Append Customer Risk Annotation",
      description:
        "Appends an immutable audit annotation to the customer profile.",
      operationId: "updateCustomerNotes",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["customerID", "noteText"],
              properties: {
                customerID: { type: "string", example: "CB112_1    " },
                noteText: {
                  type: "string",
                  example: "AUTO-CUT-TIER1 applied limit freeze.",
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Note appended",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string", example: "SUCCESS" } },
              },
            },
          },
        },
      },
    },
  },
  "/cloud/api/Manager/deleteSportsVigSetup": {
    post: {
      tags: ["Vig & Juice Setup"],
      summary: "Remove Custom Juice Shading Rules",
      description:
        "Restores baseline odds pricing for the player by deleting active vig overrides.",
      operationId: "deleteSportsVigSetup",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["operation", "sportType", "player"],
              properties: {
                operation: { type: "string", default: "deleteSportsVigSetup" },
                sportType: { type: "string", example: "Football            " },
                player: { type: "string", example: "CB112_1    " },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Vig setup deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  Result: {
                    type: "object",
                    properties: { Result: { type: "integer", example: 1 } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/cloud/api/Manager/deleteWager": {
    post: {
      tags: ["Wagers & Live Surveillance"],
      summary: "Void / Cancel Wager Ticket",
      description:
        "Cancels an open or contested wager ticket with reason code audit logging.",
      operationId: "deleteWager",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["wagerNumber", "reason"],
              properties: {
                wagerNumber: { type: "string", example: "894112" },
                reason: {
                  type: "string",
                  example: "Past-post stale line exploit",
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Wager canceled",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  wagerNumber: { type: "string", example: "894112" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/cloud/api/Report/getDeletedWagerReport": {
    post: {
      tags: ["Reporting & Forensics"],
      summary: "Deleted & Voided Wagers Audit Log",
      description:
        "Audit log of all voided, deleted, and canceled tickets across the downline with operator timestamps.",
      operationId: "getDeletedWagerReport",
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: "Deleted wagers log",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    wagerNumber: { type: "string" },
                    login: { type: "string" },
                    deletedAt: { type: "string" },
                    deletedBy: { type: "string" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/cloud/api/Report/getDailyFigure": {
    post: {
      tags: ["Reporting & Forensics"],
      summary: "Daily Gross Volume & House Hold Breakdown",
      description:
        "Pulls daily volume, payouts, and hold deficit/profit across billing period.",
      operationId: "getDailyFigure",
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: "Daily breakdown",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", format: "date" },
                    volume: { type: "number" },
                    netHold: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/hitl/queue": {
    get: {
      tags: ["Desk & HITL Operations"],
      summary: "Query Pending Tier 2 Limit Adjustments",
      description:
        "Lists all queued limit modifications awaiting operator sign-off.",
      operationId: "getHitlQueue",
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: "Queued approvals list",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    approvalId: { type: "string" },
                    customerID: { type: "string" },
                    currentLimitCents: { type: "integer" },
                    proposedLimitCents: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/hitl/reject": {
    post: {
      tags: ["Desk & HITL Operations"],
      summary: "Reject Queued Limit Raise",
      description:
        "Rejects and purges a queued limit raise with rejection audit notes.",
      operationId: "rejectHitlLimit",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["approvalId", "reason"],
              properties: {
                approvalId: { type: "string", example: "APP-20261030-9411" },
                reason: { type: "string", example: "High sharp score." },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Queued approval rejected",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string", example: "REJECTED" } },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/forensics/audit": {
    post: {
      tags: ["Desk & HITL Operations"],
      summary: "Dispatch Multi-Factor Forensic Audit",
      description:
        "Runs Mode A / Mode B / Mode C / Mode I scans and computes Multi-Factor Corroboration Score (MFCS 0-100).",
      operationId: "dispatchForensicAudit",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                period: { type: "string", example: "24h" },
                maxVelocitySeconds: { type: "integer", default: 15 },
                applyLimits: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Forensic audit scorecard",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  auditedTickets: { type: "integer" },
                  flaggedSnipers: { type: "integer" },
                  ipCollisions: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/forensics/scores": {
    get: {
      tags: ["Desk & HITL Operations"],
      summary: "Query Empirical Bayes Sharp Scores",
      description:
        "Queries online Empirical Bayes sharp scores (tau*=0.68, N_min=8) and CLV basis points.",
      operationId: "getSharpScores",
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: "Sharp scores registry",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    customerID: { type: "string" },
                    sharpScore: { type: "number" },
                    clvBasisPoints: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/rfq/quote": {
    post: {
      tags: ["Prediction Market RFQ"],
      summary: "Request Prediction Market RFQ Joint Probability Quote",
      description:
        "Translates SportsDesk sharp tickets into Polymarket / Kalshi multi-leg event contracts and queries RFQAPI for dynamic probability quotes.",
      operationId: "requestRfqQuote",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ticketIdentifier", "legs"],
              properties: {
                ticketIdentifier: { type: "string", example: "MM800|894112" },
                legs: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Joint RFQ quote received",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  quoteId: { type: "string" },
                  jointProbability: { type: "number" },
                  hedgePriceCents: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/desk/rfq/hedge": {
    post: {
      tags: ["Prediction Market RFQ"],
      summary: "Execute Layoff Hedge Order",
      description:
        "Dispatches hedging orders to Polymarket Combos / Kalshi to neutralize tail payout exposure.",
      operationId: "executeLayoffHedge",
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["quoteId", "hedgeAmountCents"],
              properties: {
                quoteId: { type: "string", example: "RFQ-908412-PM" },
                hedgeAmountCents: { type: "integer", example: 500000 },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "Layoff hedge executed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  executionId: { type: "string" },
                  status: { type: "string", example: "FILLED" },
                },
              },
            },
          },
        },
      },
    },
  },
};

for (const [p, op] of Object.entries(pathsToAdd)) {
  if (!openapi.paths[p]) {
    openapi.paths[p] = op;
  }
}

writeFileSync(openapiPath, JSON.stringify(openapi, null, 2), "utf-8");
console.log(
  "Saved openapi.json with",
  Object.keys(openapi.paths).length,
  "paths.",
);

// 3. Build comprehensive api-reference.md
const lines = [
  "# Fantasy402 & SportsDesk Operational Wire API Reference",
  "",
  "Authoritative wire contract specification, JSON return shapes, headers matrix, L-key localization bindings, and authentication gotchas for the **Fantasy402 PPH Platform** and **SportsDesk Management Suite** (`desk.bookdeskops.com`) under **Bun v1.4+**.",
  "",
  "## 1. Operational Domains Overview",
  "",
  "| Domain / Tag | Endpoints | Core Operational Purpose | Fail-Closed Stance |",
  "| :--- | :--- | :--- | :--- |",
  "| **System & Authentication** | 4 | JWT session minting, validation, and operator session lifecycle | Re-mint 1x on 401, fail closed (`EX_DATAERR 72`) |",
  "| **Manager & Player Admin** | 7 | `updateByColumn` atomic mutations, player info read-backs, omnisearch, notes | Enforce 11-char space padding, reject unpadded (`EX_USAGE 64`) |",
  "| **Vig & Juice Setup** | 3 | Custom juice shading (+15c main spreads/totals, +20c derivatives) | Enforce 20-char sport padding, zero silent failure |",
  "| **Wagers & Live Surveillance** | 4 | Real-time ticker streaming, pending ticket grouping, wager cancellation | Drop `BLOCKED` sentinels, watermark delta polling |",
  "| **Reporting & Forensics** | 6 | Forensic IP tracker (Modes A, B, C, I), weekly rollups, branch ratings | Classify dwell velocity & /24 subnet clusters |",
  "| **Desk & HITL Operations** | 5 | HMAC-SHA256 limit approvals, sharp detection scores, and MFCS engine | Constant-time token verification, strip `unsafe-url` (`EX_NOPERM 77`) |",
  "| **Prediction Market RFQ** | 2 | Polymarket Combos & Kalshi RFQ multi-leg pricing and layoff hedging | 15s quote expiration, single-execution hedge guarantee |",
  "| **Internal & Partner Feeds** | 5 | Health probes, watchlist streaming, Telegram alerts, and Partner 118 steam join | Fail-closed network deadlines |",
  "",
  "## 2. Complete HTTP Headers Matrix",
  "",
  "### 2.1 Outbound Request Headers",
  "",
  "| Header Name | Required? | Wire Value / Syntax | Operational Purpose & Enforcement | Failure Mode if Omitted / Malformed |",
  "| :--- | :--- | :--- | :--- | :--- |",
  "| `Authorization` | **Yes** | `Bearer <JWT>` | Transmits authenticated JWT token (~20-25 min lifetime). | **HTTP 401**: Missing or bad auth format. |",
  "| `X-Requested-With` | **Yes** | `XMLHttpRequest` | Proves AJAX origin to OpenResty routing filter. | **HTTP 401 / Redirect**: OpenResty rejects non-AJAX callers. |",
  "| `Accept` | **Yes** | `application/json` | Mandates JSON wire payloads over HTML error wrappers. | Server emits HTML error page with `<` on faults. |",
  "| `Content-Type` | **Yes** | `application/x-www-form-urlencoded` or `application/json` | Dictates payload serialization: form-encoded for `updateByColumn` and `getWebLog`; JSON for `vigSetupInsert`, `getPending`, and RFQ. | **HTTP 400 / 500**: Payload unparsed or poisoned. |",
  "| `Referrer-Policy` | **Yes** | `no-referrer` | Strips `Referer` URL to prevent internal routes and HMAC tokens from leaking. | **HTTP 403**: HITL routes reject `unsafe-url`. |",
  "| `Cookie` | Conditional | `desk_session_id=<uuidv7>` | Authenticates SportsDesk operator on `/api/desk/*` routes. | **HTTP 401**: Unauthenticated operator session. |",
  "",
  "### 2.2 Inbound Response Security Headers",
  "",
  "| Response Header | Wire Value | Security & Runtime Purpose |",
  "| :--- | :--- | :--- |",
  "| `Content-Type` | `application/json; charset=utf-8` | Strictly typed JSON payload encoding. |",
  "| `Set-Cookie` | `desk_session_id=...; HttpOnly; Secure; SameSite=Strict; Path=/api/desk; Max-Age=28800` | Provisions 8-hour operator session cookie via native Bun `CookieMap`. |",
  "| `X-Content-Type-Options`| `nosniff` | Blocks MIME type sniffing across proxies and webviews. |",
  "| `Cache-Control` | `no-store, no-cache, must-revalidate` | Prevents browser and proxy caching of real-time wagering risk data. |",
  "| `Content-Security-Policy` | `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;` | Replaces obsolete `X-Frame-Options: ALLOWALL` for secure Telegram Mini App mounting. |",
  "",
  "## 3. API Session & Wire Gotchas (The Complete Checklist)",
  "",
  "Every operator, script, and background daemon must adhere to the **15 Canonical Wire Gotchas** discovered across live production HAR analysis and engine runbooks:",
  "",
  "1. **Authorization Channel Isolation**: Passing `X-JWT-Assertion: <jwt>` or custom headers returns HTTP 401 HTML; authentication strictly requires `Authorization: Bearer <JWT>`.",
  "2. **Request Body JWT Prohibition**: Placing `code: <jwt>` in request bodies returns HTTP 401; tokens belong exclusively in headers.",
  "3. **Dead Session HTML Detection**: Expired sessions and Cloudflare challenges return HTML starting with `<` (`<!DOCTYPE` or `<html`); parsers must inspect `text.trim().startsWith('<')` and trigger an automated re-mint cycle instead of failing on JSON syntax errors.",
  "4. **20–25 Minute Session Decay**: JWT tokens expire after ~20–25 minutes; clients transparently re-authenticate credentials 1x via `authenticateCustomer` and retry in-flight calls before aborting with `EX_DATAERR` (72).",
  "5. **CSRF Pairing Atomic Requirement**: Submitting `sessionId` without `clientCsrfToken` (or vice versa) triggers `CSRF_PAIRING_MISMATCH` (HTTP 403, `EX_NOPERM` 77).",
  "6. **Referrer Leakage Gate**: Inbound HITL approval routes reject `req.referrerPolicy === 'unsafe-url'` with HTTP 403 to protect `DESK-*` tokens.",
  "7. **CookieMap Session Binding**: Operator sessions use native Bun `CookieMap` with time-ordered `Bun.randomUUIDv7()` and `SameSite=Strict`.",
  "8. **Zero Embedded URL Credentials**: URLs formatted with inline `user:password@` authority components are blocked across the runtime to prevent credentials leaking into error stack traces.",
  '9. **Space-Padding Contract (`PaddedCustomerId`)**: Writing unpadded logins (`"CB112"`) to `updateByColumn` or `vigSetupInsert` yields `Result.Result = 0` (`SILENT_NO_OP`); logins must be padded to strictly 11 characters (`"CB112_1    "`).',
  '10. **Scope Hierarchy Rule**: Supplying master agent `"BILLY666"` on mutations yields `Result.Result = -1` (`REJECTED_SCOPE`); writes must name the direct owning sub-agent (`"CUB22HR"`).',
  "11. **Poisoned Path Trigger**: Passing a `path` parameter in form bodies poisons `updateByColumn`, causing an empty HTTP 500 response (`POISONED_PATH_500`).",
  "12. **Qubic UI Rewrite Illusion**: Direct HTTP calls to `/qubic/api/...` yield HTTP 404 (`QUBIC_UI_ONLY_404`); requests must target `/cloud/api/...`.",
  "13. **Model Routing Trap**: Calling `/cloud/api/Customer/updateByColumn` returns HTTP 400 `Invalid Method: Model:` (`MODEL_ERROR`); customer mutations must route through `/Manager/updateByColumn`.",
  '14. **Vig Setup Wire Format**: `vigSetupInsert` requires `application/json` with 20-character space-padded `sportType` (`"Football            "`), whereas `getSportsVigSetup` requires `application/x-www-form-urlencoded`.',
  '15. **Pending Noise Sentinel Drops**: Raw `getPending` streams contain noise rows with `TicketWriter === "BLOCKED"` (`L19.N0518`) and zero-stake placeholders; these must be dropped before grouping legs into parent tickets.',
  "",
  "## 4. Complete L-Key Dictionary: Layer Tokens & Manager DOM Mapping",
  "",
  "### 4.1 Neuron Layer Tokens (Layers 18–28 SSOT Registry)",
  "",
  "| Neuron Token | Semantic Label | WagerSource / Route | Hex Color | Color Swatch | DOM CSS Class | Latency / Gate Threshold | Operational Function |",
  "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  "| **`L18.N0204`** | Retail Pregame Baseline Gate | `Internet` | `#1d84b5` | Sky Blue | `.f402-row-retail` | 1,500 ms SLA | Monitors standard casual pregame bets; serves as the canonical counterpart in digital twin matching. |",
  '| **`L19.N0518`** | Blocked Sentinel & Noise Filter | `BLOCKED` | `#64748b` | Slate Gray | `.tier-blocked-slate` | `{ kind: "sentinel_drop" }` | Drops zero-stake and voided rows before multi-leg grouping to prevent corrupting parent parlay leg arrays. |',
  "| **`L20.N1105`** | Equilibrium Confirm & Vig Gate | `GATEWAY` | `#10b981` | Emerald Green | `.theme-sd-emerald` | 1,000 ms SLA | Monitors overall book hold equilibrium and verifies +15c/+20c vig persist read-backs via `getSportsVigSetup`. |",
  "| **`L21.N0884`** | Syndicate Sub-Account Alert Twin | `ALERT` | `#ef4444` | Crimson Red | `.f402-row-alert` | 250 ms SLA | Shadow wagers mirroring sharp sub-accounts; enforces `canonicalVolumeCents = 0` to prevent double-counting. |",
  "| **`L22.N1402`** | Steam / Line Chase Phrasing | `GSBUILDER` | `#f59e0b` | Amber-500 | `.tier-amber-steam` | 1,000 ms SLA | Correlated Same-Game Parlay (SGP) proposition builder joined via `M.G<betGroupId>`; steerable via `--steer`. |",
  '| **`L23.N0412`** | Whale Sizing Anomaly | `GSLIVE` | `#28a745` | Forest Green | `.f402-row-whale` | 500 ms SLA | High-stake in-play live derivatives ($2,000+); forces `rotationGrade = "LIVE"`, extracts `M.G<id>`, routes to +20c vig tax. |',
  "| **`L24.N2019`** | Recreational Longshot Bias | `CSLEVEL2` | `#38bdf8` | Light Sky | `.tier-rec-longshot` | 2,000 ms SLA | Customer service telephone bets and manual desk entries; monitors longshot parlay bias and clerk overrides. |",
  "| **`L25.N1882`** | Adverse Selection & Steam Convergence | `--sd-route-devig` | `#06b6d4` | Cyan-500 | `.route-devig-cyan` | Consensus lag $\\le 5\\text{s}$ | Fast market line move convergence against Pinnacle reference; initiates devig spread recalculation. |",
  "| **`L26.N3104`** | CLV Margin Decay & Shrinkage | `--sd-route-sharp` | `#a855f7` | Purple-500 | `.route-sharp-purple` | $\\tau^* = 0.68, N_{\\min} \\ge 8$ | Online Empirical Bayes sharp detection ($k_{\\text{flow}}=6.0, k_{\\text{clv}}=10.0$); flags systematic Closing Line Value extractors. |",
  "| **`L27.N0912`** | Liquidity Exhaustion Circuit Breaker | `--sd-route-pending` | `#d97706` | Dark Amber | `.route-halt-amber` | Top depth $< \\$1,000$ | Triggers automated exposure circuit breakers when top-of-book market liquidity drops below safety thresholds. |",
  "| **`L28.N2501`** | Terminal Execution Write-Gate | `--sd-route-manager` | `#f43f5e` | Rose-500 | `.route-gate-rose` | MFCS $\\ge 80$ | Execution write-gate triggering dynamic 6s confirmation delay and limit clamp via `Manager/updateByColumn`. |",
  "",
  '### 4.2 Manager DOM Localization Keys (`data-language="L-xxxx"`)',
  "",
  "| DOM Localization Key | Header Label / UI Component | Wire Mapping Property | Purpose & Surveillance Binding |",
  "| :--- | :--- | :--- | :--- |",
  "| **`L-1029`** | **`Source`** | `TicketWriter` | Ingestion channel discriminator (`Internet`, `ALERT`, `GSLIVE`, `GSBUILDER`, `CSLEVEL2`). Primary hook for digital twin reconciler. |",
  "| **`L-1028`** | **`Ticket #`** | `WagerNumber` | Monotonic parent wager identifier. Key component of parent composite key `${Login}\\|${WagerNumber}`. |",
  "| **`L-1031`** | **`Player / Account`** | `Login` / `customerID` | Customer account identifier. Trimmed for queries, right-padded to 11 characters (`PaddedCustomerId`) on mutations. |",
  "| **`L-1032`** | **`Agent`** | `agentOwner` / `agentID` | Direct owning sub-agent hierarchy node (e.g. `CUB22HR`). Validates scope to prevent `REJECTED_SCOPE` (-1). |",
  "| **`L-1033`** | **`Date / Time`** | `PlacedTimestamp` | Placed timestamp (ISO UTC). Evaluates session-to-wager dwell velocity ($\\Delta t_{\\text{velocity}} = t_{\\text{placed}} - t_{\\text{login}}$). |",
  '| **`L-1034`** | **`Sport`** | `SportType` | Normalized sport category. Padded to strictly 20 characters (`"Football            "`) on `vigSetupInsert`. |',
  "| **`L-1035`** | **`Description`** | `ShortDesc` | Selection description containing bet type (`ShortDesc[0]`), line, odds, and optional `M.G<betGroupId>` headers. |",
  "| **`L-1036`** | **`Risk`** | `Risk` | Stake amount in dollars. Stored in SQLite strictly as integer `Cents` (`Math.round(risk * 100)`). |",
  "| **`L-1037`** | **`To Win`** | `Win` / `ToWin` | Potential payout amount in dollars. Stored as integer `Cents`. |",
  "| **`L-1038`** | **`Result / Status`** | `Result` / `Status` | Ticket resolution status (`Pending`, `Won`, `Lost`, `Pushed`, `Canceled`). |",
  "| **`L-1039`** | **`IP Address`** | `ipAddress` | Originating client IP. Feeds Mode B global cross-agent matcher and Mode I /24 subnet clustering. |",
  "| **`L-1040`** | **`Delay`** | `Delay` | Dynamic confirmation delay gate in seconds. Mutated via `updateByColumn` (default 0s, sharp clamp 6s). |",
  "| **`L-1045`** | **`Balance`** | `CurrentBalance` | Player outstanding ledger balance. Verified during read-back via `getInfoPlayer`. |",
  "| **`L-1050`** | **`Weekly Total`** | `grandTotalWeekly` | Mobile header KPI feeding management gross turnover. Verified via `getInfoManager`. |",
  "",
  "## 5. TicketWriter Ingestion Channels & Wire Contracts",
  "",
  "| `TicketWriter` Value | Layer & Token | Execution Source | Wire ShortDesc Codes | Latency SLA | Volume Rule (`canonicalVolumeCents`) | Primary Forensic Exposure |",
  "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  '| **`"Internet"`** | `L18.N0204` (`#1d84b5`) | Retail Web Portal | `S, P, T, C, E` | 1,500 ms | $\\min(\\text{Risk}, \\text{Win})$ (`null` on Teasers) | Casual pregame flow; target counterpart in digital twin matching. |',
  '| **`"ALERT"`** | `L21.N0884` (`#ef4444`) | Syndicate Mirror Feed | `S, P, L, G, M` | 250 ms | **Strictly `0`** | Bot sniper sub-account mirror slips; precedes web slips by $\\le 6\\text{s}$. |',
  '| **`"GSLIVE"`** | `L23.N0412` (`#28a745`) | GS Partner 118 In-Play | `M` (ticker), `G` (pending) | 500 ms | $\\min(\\text{Risk}, \\text{Win})$ | Whale sizing anomalies; exposes `M.G<id>` and omits `Team`/`Line`. |',
  '| **`"GSBUILDER"`** | `L22.N1402` (`#f59e0b`) | Same-Game Prop Engine | `C, M, P` | 1,000 ms | $\\min(\\text{Risk}, \\text{Win})$ | Multi-leg correlated prop stacks; carries `<br>` delimited legs. |',
  '| **`"CSLEVEL2"`** | `L24.N2019` (`#38bdf8`) | Clerk / Manual Desk | `L, S, C, E` | 2,000 ms | $\\min(\\text{Risk}, \\text{Win})$ | Telephone desk orders, manual line overrides, and doubles tennis. |',
  '| **`"BLOCKED"`** | `L19.N0518` (`#64748b`) | Noise Filter Sentinel | Empty or any | Sentinel drop | **Dropped** (not evaluated) | Zero-stake placeholders and voided legs; must drop before grouping. |',
  '| **`"GATEWAY"`** | `L20.N1105` (`#10b981`) | Equilibrium Sentinel | Empty | 1,000 ms | Diagnostic check | Margin balance and +15c/+20c vig verification read-backs. |',
  "",
  "## 6. Error Taxonomy & Sysexits Matrix",
  "",
  "| Error Classification | HTTP Status | Sysexit Code | Retryable? | Root Cause & Operational Resolution |",
  "| :--- | :--- | :--- | :--- | :--- |",
  "| **`COMMITTED`** | 200 | `EX_OK` (0) | No | Mutation confirmed upstream; read-back succeeded. |",
  "| **`UNVERIFIED_COMMIT`** | 200 | `EX_OK` (0) | **No** | Upstream returned `Result=1`, but read-back timed out. Flagged `isCommitted = true` to strictly prevent duplicate write retries. |",
  '| **`SILENT_NO_OP`** | 200 | `EX_USAGE` (64) | **No** | Unpadded login passed (`"CB112"` instead of `"CB112_1    "`). Fix client padding before resubmitting. |',
  '| **`REJECTED_SCOPE`** | 200 | `EX_USAGE` (64) | **No** | Master agent passed (`"BILLY666"`) instead of direct parent sub-agent (`"CUB22HR"`). Re-bind to sub-agent. |',
  "| **`MODEL_ERROR`** | 400 | `EX_USAGE` (64) | **No** | Target pointed to `/Customer/updateByColumn` instead of `/Manager/updateByColumn`. Re-route to Manager. |",
  "| **`POISONED_PATH_500`** | 500 | `EX_USAGE` (64) | **No** | Form body contained forbidden `path` property. Strip `path` parameter fail-fast at boundary. |",
  "| **`QUBIC_UI_ONLY_404`** | 404 | `EX_USAGE` (64) | **No** | Direct request sent to `/qubic/api/...` instead of `/cloud/api/...`. Correct URL prefix. |",
  "| **`INVALID_IDENTIFIER_LENGTH`** | 422 | `EX_USAGE` (64) | **No** | Customer login exceeds 11 characters. Truncate or reject at boundary. |",
  "| **`AUTHENTICATION_SESSION_EXPIRED`** | 401 | `EX_DATAERR` (72) | **Yes (1x)** | JWT expired (~20–25 min lifetime). Execute exactly 1 re-mint cycle via `authenticateCustomer` and retry request. |",
  "| **`WIRE_PAYLOAD_TRUNCATED`** | 502 | `EX_DATAERR` (72) | **Yes** | Upstream returned malformed or truncated JSON. Retry with exponential backoff. |",
  "| **`WIRE_PAYLOAD_SHAPE_DRIFT`** | 200 | `EX_DATAERR` (72) | **No** | Response root is non-object, missing `Result`, or contains invalid types. |",
  "| **`CSRF_PAIRING_MISMATCH`** | 403 | `EX_NOPERM` (77) | **No** | `sessionId` and `clientCsrfToken` were not both present or both omitted. |",
  "| **`UNSAFE_REFERRER_HEADER`** | 403 | `EX_NOPERM` (77) | **No** | Inbound request sent `referrerPolicy: unsafe-url`. Rejected to prevent `DESK-*` HMAC leakage. |",
  "| **`TRANSPORT_TIMEOUT`** | 408 / 504 | `EX_TEMPFAIL` (75) | **Yes** | Monotonic deadline budget exceeded (`AbortSignal.timeout`). Retryable within remaining total budget. |",
  "| **`UPSTREAM_UNAVAILABLE`** | 502 / 503 | `EX_TEMPFAIL` (75) | **Yes** | Cloudflare reverse proxy or gateway unreachable. Retry with exponential backoff and jitter. |",
  "",
  "## 7. Complete Endpoint Reference",
  "",
];

for (const [p, methods] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    lines.push(`### \`${method.toUpperCase()} ${p}\``);
    lines.push(
      `**${op.summary || p}** (\`operationId: ${op.operationId || p}\`)`,
    );
    lines.push("");
    lines.push(op.description || "Operational endpoint.");
    lines.push("");

    const retryable = op["x-retryable"] ?? false;
    lines.push(
      `- **Retry Policy**: \`${retryable ? "RETRYABLE" : "NON-RETRYABLE"}\``,
    );

    if (op.parameters && op.parameters.length > 0) {
      lines.push("- **Parameters**:");
      for (const param of op.parameters) {
        lines.push(
          `  - \`${param.name}\` (${param.in}): \`${param.schema?.default || "string"}\` — ${param.description || ""}`,
        );
      }
    }

    if (op.requestBody) {
      lines.push("- **Request Payload**:");
      for (const ctype of Object.keys(op.requestBody.content || {})) {
        lines.push(`  - Content-Type: \`${ctype}\``);
      }
    }

    lines.push("- **Responses**:");
    for (const [code, rval] of Object.entries(op.responses || {})) {
      lines.push(`  - \`HTTP ${code}\`: ${rval.description || "Response"}`);
    }
    lines.push("");
  }
}

writeFileSync(apiRefPath, lines.join("\n"), "utf-8");
console.log("Saved api-reference.md with", lines.length, "lines.");
