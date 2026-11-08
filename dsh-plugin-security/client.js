/**
 * Client half of the SportsDesk security/fraud bundle: the read-only operator console.
 *
 * WHAT THIS IS
 *
 * A left-sidebar entry (`sidebar.panellist`, id "sportsdesk-security") plus the
 * main-column page that entry selects (`main`, keyed by the same id — the
 * sidebar owns the button, its tooltip and the selected state; this module owns
 * the shield glyph and the page). The page is the human view of the desk's
 * security posture:
 *
 *   Overview   the per-source matrix (state, provenance, records, age, reason),
 *              the corpus summary, the weak-label model summary with its limits,
 *              the F402 weblog posture/flags and a bet-aggregate strip.
 *   Queue      the operator triage queue: model/findings-ranked accounts with
 *              per-row score+band, critical/high counts, desk-flag counts, bets
 *              and reasons; clicking a row loads that account's dossier without
 *              leaving the tab.
 *   Explore    descriptive exploration under frozen constants: corpus/constants,
 *              the detector backlog with field-availability chips, and three
 *              "exploratory — not a finding" candidates (market entropy,
 *              unattributed override, stake concentration) with their
 *              question/method/caveat and compact tables.
 *   IP graph   masked IP-network clusters plus the distinct/shared-IP summary.
 *   Findings   named detectors with severity/category filters, expandable
 *              evidence, observed/threshold values and insufficient-data chips.
 *   Model      the transparent weak-label logistic report: features, metrics
 *              (AUC-ROC, average precision, precision@1%/5%, Brier), temporal
 *              validation, drift, calibration bins and limits. A missing model
 *              artifact renders "not fitted" plus the exact fit command —
 *              never zeroed metrics.
 *   Dossier    an account/agent id lookup: model score and band, top
 *              contributions, bet aggregates, findings, masked IP clusters and
 *              evidence pointers.
 *
 * DATA (same-origin GET routes served by this bundle's Host half)
 *
 *   /api/security/status      /api/security/bets       /api/security/ip-graph
 *   /api/security/weblog      /api/security/patterns   /api/security/model
 *   /api/security/queue?limit=25  /api/security/explore?limit=10
 *   /api/security/dossier?id=     /api/security/research
 *
 * A 200 body is `{ ok: true, ...CLI payload }`; a CLI failure is a 502
 * `{ ok: false, reason, message }`; a 404 means the installed Host bundle does
 * not register the route. Every payload carries `sources[]` (FraudSourceState)
 * so the page can state provenance and freshness instead of trusting the
 * numbers.
 *
 * HONESTY RULES
 *
 * - Nothing has been measured before the first response: the page says loading,
 *   never "everything is fine" and never a fake zero.
 * - A missing source renders "missing" plus its reason, and a null record count
 *   renders "not counted" — missing is not 0.
 * - Fixture provenance is labelled with a fixture chip; it is context, never an
 *   observation.
 * - A failed refresh keeps the last payload visible, labelled stale with the
 *   time it was received, plus the failure reason and Retry.
 * - Model output has no "probability of fraud" copy: it ranks a desk-flag
 *   proxy, and the page says "proxy label — not fraud probability" wherever the
 *   model is summarized.
 * - The page is read-only: no mutation button exists, and `fit` is not offered
 *   (the exact command is shown for the operator to run).
 *
 * RULES FOLLOWED
 *
 * - The factory is side-effect free: it builds constants, the store and the
 *   components. Locale registration and both slot registrations are owned
 *   effects created in `apply`.
 * - One module-level store; the panel fetches on activation (status + weblog +
 *   bets), lazily loads a tab's route on that tab's first activation, loads the
 *   dossier on submit, and Refresh re-measures the active tab. One
 *   AbortController per fetch; a superseded or unmounted request is aborted and
 *   can never publish. There is no poll timer; the timeout timer is cleared.
 *   Nothing publishes after disposal.
 * - Visible copy goes through the Client locale service (`ctx.locale.register`
 *   plus the `locale:` registration option, which supplies `t`), in both
 *   built-in locales, with a dictionary fallback so a missing seat renders
 *   English instead of a key.
 * - Chrome uses only host `--dsw-alias-*` color tokens; the sidebar glyph uses
 *   `currentColor`, so the host owns its color in every theme. No literal
 *   colors, no page-root writes, no direct DOM construction.
 * - React comes from the browser module table. No Harness Client package is
 *   imported and no DOM outside this page's own slot is read or written.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-sportsdesk-security",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this bundle (also the `locale:` registration option). */
    const NS = "sportsdesk-security";
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = "sportsdesk-security";

    /** Same-origin GET routes served by this bundle's Host half (index.js). */
    const ROUTES = Object.freeze({
      status: "/api/security/status",
      bets: "/api/security/bets",
      ipGraph: "/api/security/ip-graph",
      weblog: "/api/security/weblog",
      patterns: "/api/security/patterns",
      model: "/api/security/model",
      /** The triage queue always requests the frozen page size. */
      queue: "/api/security/queue?limit=25",
      /** Exploration asks for the frozen candidate row limit. */
      explore: "/api/security/explore?limit=10",
      dossier: "/api/security/dossier",
      research: "/api/security/research",
    });

    /**
     * Per-request bound. The Host route itself bounds the CLI (4 s per the
     * contract), so this is the outer ceiling for a wedged proxy, not the
     * expected latency.
     */
    const FETCH_TIMEOUT_MS = 20_000;
    /** Page tabs, in keyboard order. Overview is the default. */
    const TAB_ORDER = Object.freeze([
      "overview",
      "queue",
      "explore",
      "ip",
      "findings",
      "model",
      "dossier",
    ]);
    /** Detector severities, highest first (the filter and sort order). */
    const SEVERITY_ORDER = Object.freeze([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
    /** Frozen detector categories (API values from the contract). */
    const CATEGORY_ORDER = Object.freeze([
      "courtsiding",
      "multi_accounting",
      "line_shopping",
      "match_integrity",
      "agent_scheme",
      "ticket_anomaly",
      "ip_network",
      "data_quality",
    ]);
    /** Which store entries each tab shows (Refresh re-measures exactly these). */
    const TAB_SOURCE_KEYS = Object.freeze({
      overview: Object.freeze(["status", "weblog", "bets"]),
      queue: Object.freeze(["queue"]),
      explore: Object.freeze(["explore"]),
      ip: Object.freeze(["ipGraph"]),
      findings: Object.freeze(["patterns"]),
      model: Object.freeze(["model", "research"]),
      dossier: Object.freeze(["dossier"]),
    });
    /** Exploration backlog status value -> locale key. */
    const EXPLORE_STATUS_LABEL_KEYS = Object.freeze({
      implemented: "exploreStatusImplemented",
      proposed: "exploreStatusProposed",
    });
    /** Bets/dossier aggregate breakdown group -> locale label key (API names). */
    const BREAKDOWN_LABEL_KEYS = Object.freeze({
      bySport: "breakdownSport",
      bySubSport: "breakdownSubSport",
      byPeriod: "breakdownPeriod",
      byWagerType: "breakdownWagerType",
    });
    /** Explore API-vocabulary field -> locale label key (fixed display order). */
    const VOCABULARY_FIELD_ORDER = Object.freeze([
      "sport",
      "subSport",
      "period",
      "wagerType",
      "line",
    ]);
    const VOCABULARY_LABEL_KEYS = Object.freeze({
      sport: "vocabularySport",
      subSport: "vocabularySubSport",
      period: "vocabularyPeriod",
      wagerType: "vocabularyWagerType",
      line: "vocabularyLine",
    });
    /** Locale key per tab; the tablist and the keyboard order share TAB_ORDER. */
    const TAB_LABEL_KEYS = Object.freeze({
      overview: "tabOverview",
      queue: "tabQueue",
      explore: "tabExplore",
      ip: "tabIpGraph",
      findings: "tabFindings",
      model: "tabModel",
      dossier: "tabDossier",
    });
    /** Rendering bounds; the payloads can be large, the page stays readable. */
    const MAX_FINDINGS = 120;
    const MAX_CLUSTERS = 80;
    const MAX_FEATURES = 60;
    const MAX_EVIDENCE = 20;
    /** Real source notes and model limits are long; the Overview stays scannable. */
    const MAX_NOTE_CHARS = 200;
    /** Breakdown groups are bounded; the list keeps the head and reports the rest. */
    const MAX_BREAKDOWN_ROWS = 20;
    const MAX_OVERVIEW_LIMITS = 4;
    const MAX_ACCOUNT_SAMPLES = 6;
    /** Queue reason cells show the first few reasons; the row keeps the rest in a tooltip. */
    const MAX_QUEUE_REASONS = 3;
    const MAX_CALIBRATION_BINS = 10;
    /** Data value -> locale key maps (API strings stay data, labels stay local). */
    /** Integrity statuses this client understands; anything else renders "not reported". */
    const INTEGRITY_STATUS_KEYS = Object.freeze({
      verified: "integrityVerified",
      incomplete: "integrityIncomplete",
      invalid: "integrityInvalid",
      unavailable: "integrityUnavailable",
    });
    const SETTLEMENT_STATUS_KEYS = Object.freeze({
      unverified: "settlementUnverified",
    });
    const SEVERITY_LABEL_KEYS = Object.freeze({
      critical: "severityCritical",
      high: "severityHigh",
      medium: "severityMedium",
      low: "severityLow",
      info: "severityInfo",
    });
    const CATEGORY_LABEL_KEYS = Object.freeze({
      courtsiding: "categoryCourtsiding",
      multi_accounting: "categoryMultiAccounting",
      line_shopping: "categoryLineShopping",
      match_integrity: "categoryMatchIntegrity",
      agent_scheme: "categoryAgentScheme",
      ticket_anomaly: "categoryTicketAnomaly",
      ip_network: "categoryIpNetwork",
      data_quality: "categoryDataQuality",
    });
    const SOURCE_STATE_LABEL_KEYS = Object.freeze({
      ok: "sourceOk",
      stale: "sourceStale",
      missing: "sourceMissing",
      session_expired: "sourceSessionExpired",
      unreadable: "sourceUnreadable",
    });
    const PROVENANCE_LABEL_KEYS = Object.freeze({
      "live-api": "provenanceLiveApi",
      "api-log-rollup": "provenanceApiLogRollup",
      derived: "provenanceDerived",
      fixture: "provenanceFixture",
      missing: "provenanceMissing",
    });
    const SUBJECT_KIND_LABEL_KEYS = Object.freeze({
      account: "subjectKindAccount",
      agent: "subjectKindAgent",
    });

    /* -------------------------------------------------------------------- */
    /* Visible copy: en + zh, identical key sets, namespace `sportsdesk-security` */
    /* -------------------------------------------------------------------- */

    const DICTS = {
      en: {
        /* Sidebar + page chrome */
        panel: "Security",
        title: "Security & fraud console",
        subtitle:
          "Read-only view of the desk's security posture: log-source provenance, masked IP-network clusters, surveillance findings, the weak-label risk model and per-account dossiers.",
        readOnly: "READ-ONLY",
        refresh: "Refresh",
        refreshing: "Refreshing…",
        retry: "Retry",
        loading: "Loading…",
        notAvailable: "—",
        never: "never",
        tabsLabel: "Security console tabs",
        tabOverview: "Overview",
        tabQueue: "Queue",
        tabExplore: "Explore",
        tabIpGraph: "IP graph",
        tabFindings: "Findings",
        tabModel: "Model",
        tabDossier: "Dossier",
        /* Shared states */
        errorTitle: "Could not load this data",
        routeAbsentTitle: "Host route absent",
        routeAbsentBody: "Host route absent — update the Host bundle.",
        networkError: "Network error",
        timeoutError: "Request timed out",
        requestFailed: "Request failed",
        staleNotice:
          "Showing the payload received {time}. The last refresh failed: {reason}",
        ageNow: "just now",
        ageSeconds: "{count}s ago",
        ageMinutes: "{count}m ago",
        ageHours: "{count}h ago",
        ageDays: "{count}d ago",
        durationSeconds: "{count}s",
        durationMinutes: "{count}m",
        durationHours: "{count}h",
        durationDays: "{count}d",
        /* Sources */
        sourcesTitle: "Sources",
        sourcesSub:
          "One row per log source. A missing source reports missing with its reason — missing is never a zero.",
        sourceName: "Source",
        sourceStateLabel: "State",
        sourceProvenance: "Provenance",
        sourceRecords: "Records",
        sourceAge: "Age",
        sourceNote: "Note",
        /* Overview posture strip */
        postureSources: "Sources measured",
        postureAllOk: "all measured",
        postureStale: "{count} stale",
        postureMissing: "{count} missing",
        postureCorpus: "Corpus rows",
        postureModel: "Model",
        postureFlags: "Desk-flagged rows",
        postureIntegrity: "Bet-group integrity",
        postureSettlement: "Settlement",
        integrityNotReported: "not reported",
        integrityVerified: "verified",
        integrityIncomplete: "incomplete",
        integrityInvalid: "invalid",
        integrityUnavailable: "unavailable",
        integrityGroups: "groups",
        integrityCrossPlayer: "cross-player",
        integrityConflicts: "conflicts",
        settlementUnverified: "unverified",
        settlementNoLedger: "no same-book ledger",
        sourcePath: "Path",
        sourceSha: "sha256",
        sourceReason: "Reason",
        sourceOk: "ok",
        sourceStale: "stale",
        sourceMissing: "missing",
        sourceSessionExpired: "session expired",
        sourceUnreadable: "unreadable",
        provenanceLiveApi: "live API",
        provenanceApiLogRollup: "api-log-rollup",
        provenanceDerived: "derived",
        provenanceFixture: "fixture",
        provenanceMissing: "missing",
        sourceEmpty: "Status reported no source states.",
        noReason: "no reason reported",
        recordsMissing: "not counted",
        /* Overview */
        overviewCorpus: "Corpus",
        corpusRows: "Rows",
        corpusAccounts: "Accounts",
        corpusAgents: "Agents",
        corpusIps: "Distinct IPs",
        corpusWindow: "Window",
        corpusSha: "Corpus sha256",
        corpusMissing: "Status reported no corpus summary.",
        corpusUnavailable:
          "Corpus summary unavailable — the status route did not answer.",
        overviewModel: "Model",
        modelFitted: "fitted",
        modelNotFitted: "not fitted",
        modelUnknown: "state unknown",
        modelUnknownBody:
          "The status route has not answered, so the model state is unknown rather than measured.",
        modelFittedAt: "Fitted at",
        modelAuc: "AUC-ROC",
        modelAp: "Average precision",
        modelReason: "Reason",
        modelFitCommand: "Fit command",
        modelProxyNote:
          "Proxy label — not fraud probability. The model ranks a desk-flag proxy, not observed fraud.",
        modelLimitsTitle: "Model limits",
        modelNextStep: "Next step",
        limitsMore: "+{count} more limits in the Model tab.",
        noLimits: "No limits reported.",
        overviewWeblog: "Weblog posture",
        weblogMissing: "No F402 weblog posture reported.",
        weblogWindow: "Window",
        weblogRows: "Rows",
        weblogSessions: "Sessions",
        weblogFlags: "Flags",
        weblogGates: "Gates",
        weblogInsufficient: "Insufficient reason",
        gateStatus: "Status",
        gateDetail: "Detail",
        overviewBets: "Bet sample aggregate",
        betsRows: "Rows",
        betsAccounts: "Accounts",
        betsAgents: "Agents",
        betsSuspectedBot: "Suspected bot",
        betsReversedCredit: "Reversed credit",
        betsManualLog: "Manual log",
        betsOddsDrift: "Odds drift",
        betsStates: "States",
        betsEmpty: "No bet aggregate reported.",
        breakdownSport: "Sport",
        breakdownSubSport: "Sub-sport",
        breakdownPeriod: "Period",
        breakdownWagerType: "Wager type",
        breakdownNotCarried: "not carried by this source",
        breakdownEmpty: "No rows reported for this field.",
        breakdownMore: "+{count} more values",
        overviewHint:
          "Every number is read from the CLI payload; a missing field renders — or “not counted”, never 0.",
        /* Queue */
        queueTitle: "Review queue",
        queueSub:
          "Model/findings-ranked accounts for operator review. Click a row to load that account's dossier in the Dossier tab; nothing here is a finding, a ban or an order.",
        queueAccounts: "Accounts",
        queueEligible: "Eligible",
        queueReturned: "Returned",
        queueAgents: "Agents",
        queueScored: "Scored",
        queueMethod: "Method",
        queueEligibility: "Eligibility",
        queueRankBasis: "Rank basis",
        queueColRank: "Rank",
        queueColAccount: "Account",
        queueColAgent: "Agent",
        queueColModel: "Model",
        queueColCriticalHigh: "Critical / high",
        queueColFlags: "Flags",
        queueColBets: "Bets",
        queueColReasons: "Reasons",
        queueNoModel: "no model",
        queueNoScore: "no score",
        queueFlagsBot: "bot",
        queueFlagsReversed: "reversed",
        queueFlagsManual: "manual",
        queueFlagsDrift: "drift",
        queueEmpty:
          "No accounts in the queue — the measured eligible set is empty.",
        queueDossierHint:
          "Dossier for {account} loaded — open the Dossier tab to review it.",
        /* Explore */
        exploreTitle: "Explore",
        exploreSub:
          "Descriptive exploration of the logs under frozen constants. Candidates are exploratory, not findings; backlog fields are availability facts, not implementation claims.",
        exploreFrozenDetectors: "{count} frozen detectors",
        exploreCatalogPresent: "catalog present",
        exploreCatalogMissing: "catalog missing",
        exploreCatalogPath: "Catalog path",
        exploreCatalogMissingBody:
          "The research catalog is absent, so proposed backlog entries come from the frozen fallback list; no catalog content is implied by them.",
        exploreConstantsTitle: "Constants",
        exploreConstantMinBets: "Min bets",
        exploreConstantMaxRows: "Max rows",
        exploreConstantEntropyBucket: "Entropy bucket",
        exploreVocabularyTitle: "API vocabulary",
        exploreColApiField: "API field",
        exploreColNormalizedField: "Normalized record field",
        exploreColRawSource: "Raw source",
        exploreColNote: "Note",
        vocabularySport: "Sport",
        vocabularySubSport: "Sub-sport",
        vocabularyPeriod: "Period",
        vocabularyWagerType: "Wager type",
        vocabularyLine: "Line",
        exploreBacklogTitle: "Detector backlog",
        exploreBacklogNote:
          "Field availability is a fact about the listed source fields only: `allListedFieldsAvailable` is not an implementability verdict, and a proposed detector is not running.",
        exploreColDetector: "Detector",
        exploreColStatus: "Status",
        exploreColFields: "Fields / accessor",
        exploreStatusImplemented: "implemented",
        exploreStatusProposed: "proposed",
        exploreFieldAvailable: "available",
        exploreFieldMissing: "missing",
        exploreFieldsAllAvailable: "all listed fields available",
        exploreFieldsMissing: "some listed fields missing",
        exploreNotAFinding: "exploratory — not a finding",
        exploreQuestion: "Question",
        exploreMethod: "Method",
        exploreCaveat: "Caveat",
        exploreOmittedRows:
          "{count} more eligible rows omitted by the row limit",
        exploreNoRows:
          "No rows under the frozen constants — this candidate is empty, not zero.",
        exploreCandidateEntropyTitle: "Market entropy (exploratory)",
        exploreCandidateOverrideTitle: "Unattributed override (exploratory)",
        exploreCandidateStakeTitle: "Stake concentration (exploratory)",
        exploreColAccount: "Account",
        exploreColAgent: "Agent",
        exploreColBets: "Bets",
        exploreColEntropyBits: "Entropy bits",
        exploreColBuckets: "Buckets",
        exploreColTopShare: "Top share",
        exploreColManualRows: "Manual rows",
        exploreColWithoutAdmin: "Without admin",
        exploreColShare: "Share",
        exploreColTopStakeUsd: "Top stake USD",
        /* IP graph */
        ipTitle: "IP-network clusters",
        ipSub:
          "Addresses are masked: clusters are keyed by a short hash or a /24 prefix. No raw IP address is displayed.",
        ipSummary: "Summary",
        ipDistinctIps: "Distinct IPs",
        ipSharedIps: "Shared IPs",
        ipAccountsMultiIp: "Accounts on multiple IPs",
        ipMaxAccountsPerIp: "Max accounts per IP",
        ipClustersTitle: "Clusters",
        ipClusterKey: "Cluster",
        ipMasked: "Masked",
        ipAccounts: "Accounts",
        ipBets: "Bets",
        ipSamples: "Sample accounts",
        ipSharedFlag: "shared",
        ipBotRingFlag: "bot ring range",
        ipDatacenter: "datacenter class",
        ipPrefix24: "Prefix /24",
        ipEmpty: "No clusters reported.",
        /* Findings */
        findingsTitle: "Findings",
        findingsSub:
          "Named detectors over the normalized logs. Evidence expands in place; a finding whose inputs are missing says “insufficient data”.",
        findingsCount: "{count} findings",
        countChip: "{label} {count}",
        severityFilter: "Severity",
        categoryFilter: "Category",
        filterAll: "all",
        noFindings: "No findings for this filter.",
        insufficientData: "insufficient data",
        insufficientTitle: "Insufficient data",
        insufficientEmpty: "No insufficient-data notes reported.",
        observedTitle: "Observed",
        thresholdTitle: "Threshold",
        evidenceTitle: "Evidence",
        provenanceTitle: "Provenance",
        expandEvidence: "Show evidence",
        collapseEvidence: "Hide evidence",
        subjectLabel: "Subject",
        severityCritical: "critical",
        severityHigh: "high",
        severityMedium: "medium",
        severityLow: "low",
        severityInfo: "info",
        categoryCourtsiding: "courtsiding",
        categoryMultiAccounting: "multi-accounting",
        categoryLineShopping: "line shopping",
        categoryMatchIntegrity: "match integrity",
        categoryAgentScheme: "agent scheme",
        categoryTicketAnomaly: "ticket anomaly",
        categoryIpNetwork: "IP network",
        categoryDataQuality: "data quality",
        /* Model */
        modelTitle: "Model report",
        modelSub:
          "A transparent weak-label logistic ranker over the GSLive bet rows plus an account-level anomaly score. It predicts a desk-flag proxy; it does not estimate fraud.",
        modelNotFittedTitle: "Model not fitted",
        modelNotFittedBody:
          "No model artifact exists yet, so there are no metrics to show. The metrics are absent, not zero. The console never offers the fit itself (it writes an artifact); run the command below.",
        modelFitCommandTitle: "Fit command",
        modelNextStepTitle: "Next step",
        modelReportPath: "Artifact",
        modelSpecTitle: "Spec",
        modelSpecProxy: "Proxy label",
        modelSpecSplit: "Temporal split",
        modelSpecRows: "Corpus rows",
        modelSpecSha: "Corpus sha256",
        featuresTitle: "Features",
        featuresEmpty: "No features reported.",
        featureId: "Feature",
        featureLabel: "Label",
        featureKind: "Kind",
        featureWeight: "Weight",
        featureStats: "Train mean / std",
        metricsTitle: "Metrics",
        metricAucRoc: "AUC-ROC",
        metricAveragePrecision: "Average precision (PR-AUC)",
        metricPrecisionAt1: "Precision@1%",
        metricPrecisionAt5: "Precision@5%",
        metricBrier: "Brier score",
        metricEpochsRun: "Epochs run",
        metricConverged: "Converged",
        metricLabelSupport: "Label support",
        labelProxy: "Proxy",
        labelPositives: "Positives",
        labelNegatives: "Negatives",
        labelPrevalence: "Prevalence",
        metricTrainWindow: "Train window",
        metricHoldoutWindow: "Holdout window",
        calibrationTitle: "Calibration bins",
        calibrationEmpty: "No calibration bins reported.",
        calibrationBin: "Bin",
        calibrationPredicted: "Predicted",
        calibrationObserved: "Observed",
        calibrationCount: "Count",
        validationTitle: "Validation",
        validationWarnings: "Validation warnings",
        warningObserved: "observed: {value}",
        validationHoldout: "Temporal holdout",
        validationStability: "Stability (holdout halves)",
        stabilityFirstHalf: "First half AUC",
        stabilitySecondHalf: "Second half AUC",
        stabilityDelta: "Absolute delta",
        driftTitle: "Feature drift",
        driftEmpty: "No drift rows reported.",
        driftFeature: "Feature",
        driftShift: "Standardized mean shift",
        limitsTitle: "Limits",
        noMetrics: "No metrics reported.",
        noFeatures: "No features reported.",
        corpusProvenanceTitle: "Corpus provenance",
        /* Dossier */
        dossierTitle: "Account dossier",
        dossierSub:
          "Enter an account or agent id (the desk login/id, not a raw IP). The dossier joins bet aggregates, findings, masked IP clusters and the model score.",
        dossierId: "Account or agent id",
        dossierIdPlaceholder: "e.g. player_ABC123",
        dossierOpen: "Open dossier",
        dossierEmptyHint:
          "Enter an id to load a dossier. Nothing is queried until you submit.",
        dossierUnknownSubject: "Unknown subject — no dossier for {id}.",
        dossierScore: "Model score",
        dossierBand: "Band",
        dossierNotScored: "not scored",
        dossierContributions: "Top contributions",
        dossierNoContributions: "No model contributions reported.",
        contributionFeature: "Feature",
        contributionWeight: "Weight",
        contributionValue: "Contribution",
        dossierBetsTitle: "Bet aggregates",
        dossierFindingsTitle: "Findings",
        dossierClustersTitle: "Masked IP clusters",
        dossierHierarchyTitle: "Agent hierarchy",
        hierarchyAgent: "Agent",
        hierarchyParent: "Parent agent",
        hierarchyLevel: "Level",
        hierarchyType: "Type",
        hierarchyChain: "Chain",
        dossierEvidenceTitle: "Evidence pointers",
        dossierSourcesTitle: "Source freshness",
        dossierNoFindings: "No findings for this subject.",
        dossierNoClusters: "No IP clusters for this subject.",
        dossierNoEvidence: "No evidence pointers reported.",
        dossierModelReason: "Model reason",
        dossierModelCommand: "Model command",
        subjectKindAccount: "account",
        subjectKindAgent: "agent",
      },
      zh: {
        /* Sidebar + page chrome */
        panel: "安全",
        title: "安全与欺诈控制台",
        subtitle:
          "只读查看本工作台的安全态势：日志来源溯源、脱敏的 IP 网络聚类、监控发现、弱标签风险模型以及按账户的档案。",
        readOnly: "只读",
        refresh: "刷新",
        refreshing: "刷新中…",
        retry: "重试",
        loading: "加载中…",
        notAvailable: "—",
        never: "从未",
        tabsLabel: "安全控制台标签页",
        tabOverview: "概览",
        tabQueue: "队列",
        tabExplore: "探索",
        tabIpGraph: "IP 图谱",
        tabFindings: "发现",
        tabModel: "模型",
        tabDossier: "档案",
        /* Shared states */
        errorTitle: "无法加载数据",
        routeAbsentTitle: "Host 路由缺失",
        routeAbsentBody: "Host 路由缺失 — 请更新 Host 插件包。",
        networkError: "网络错误",
        timeoutError: "请求超时",
        requestFailed: "请求失败",
        staleNotice: "当前显示的是 {time} 收到的数据。上次刷新失败：{reason}",
        ageNow: "刚刚",
        ageSeconds: "{count} 秒前",
        ageMinutes: "{count} 分钟前",
        ageHours: "{count} 小时前",
        ageDays: "{count} 天前",
        durationSeconds: "{count} 秒",
        durationMinutes: "{count} 分钟",
        durationHours: "{count} 小时",
        durationDays: "{count} 天",
        /* Sources */
        sourcesTitle: "数据来源",
        sourcesSub:
          "每个日志来源一行。缺失的来源显示“缺失”及其原因 — 缺失永远不是 0。",
        sourceName: "来源",
        sourceStateLabel: "状态",
        sourceProvenance: "来源类型",
        sourceRecords: "记录数",
        sourceAge: "数据龄",
        sourceNote: "说明",
        /* Overview posture strip */
        postureSources: "已测量来源",
        postureAllOk: "全部已测量",
        postureStale: "{count} 个过期",
        postureMissing: "{count} 个缺失",
        postureCorpus: "语料行数",
        postureModel: "模型",
        postureFlags: "工作台标记行",
        postureIntegrity: "注单组完整性",
        postureSettlement: "结算核验",
        integrityNotReported: "未报告",
        integrityVerified: "已验证",
        integrityIncomplete: "不完整",
        integrityInvalid: "无效",
        integrityUnavailable: "不可用",
        integrityGroups: "注单组",
        integrityCrossPlayer: "跨用户",
        integrityConflicts: "字段冲突",
        settlementUnverified: "未核验",
        settlementNoLedger: "缺少同盘结算账本",
        sourcePath: "路径",
        sourceSha: "sha256",
        sourceReason: "原因",
        sourceOk: "正常",
        sourceStale: "过期",
        sourceMissing: "缺失",
        sourceSessionExpired: "会话过期",
        sourceUnreadable: "不可读",
        provenanceLiveApi: "实时 API",
        provenanceApiLogRollup: "API 日志汇总",
        provenanceDerived: "派生",
        provenanceFixture: "测试夹具",
        provenanceMissing: "缺失",
        sourceEmpty: "状态未报告任何来源状态。",
        noReason: "未报告原因",
        recordsMissing: "未统计",
        /* Overview */
        overviewCorpus: "语料库",
        corpusRows: "行数",
        corpusAccounts: "账户数",
        corpusAgents: "代理数",
        corpusIps: "独立 IP 数",
        corpusWindow: "时间窗口",
        corpusSha: "语料库 sha256",
        corpusMissing: "状态未报告语料库摘要。",
        corpusUnavailable: "语料库摘要不可用 — 状态路由未返回。",
        overviewModel: "模型",
        modelFitted: "已拟合",
        modelNotFitted: "未拟合",
        modelUnknown: "状态未知",
        modelUnknownBody: "状态路由尚未返回，模型状态未知（并非“未拟合”）。",
        modelFittedAt: "拟合时间",
        modelAuc: "AUC-ROC",
        modelAp: "平均精度",
        modelReason: "原因",
        modelFitCommand: "拟合命令",
        modelProxyNote:
          "代理标签 — 并非欺诈概率。模型排序的是工作台标记代理，并非已观测的欺诈。",
        modelLimitsTitle: "模型局限",
        modelNextStep: "下一步",
        limitsMore: "另有 {count} 条局限，见“模型”标签页。",
        noLimits: "未报告局限。",
        overviewWeblog: "Weblog 态势",
        weblogMissing: "未报告 F402 weblog 态势。",
        weblogWindow: "时间窗口",
        weblogRows: "行数",
        weblogSessions: "会话数",
        weblogFlags: "标记",
        weblogGates: "关卡",
        weblogInsufficient: "数据不足原因",
        gateStatus: "状态",
        gateDetail: "详情",
        overviewBets: "投注样本汇总",
        betsRows: "行数",
        betsAccounts: "账户数",
        betsAgents: "代理数",
        betsSuspectedBot: "疑似机器人",
        betsReversedCredit: "冲正信用",
        betsManualLog: "人工日志",
        betsOddsDrift: "赔率漂移",
        betsStates: "状态",
        betsEmpty: "未报告投注汇总。",
        breakdownSport: "运动",
        breakdownSubSport: "子运动",
        breakdownPeriod: "节次",
        breakdownWagerType: "投注类型",
        breakdownNotCarried: "该来源未提供",
        breakdownEmpty: "该字段未报告任何行。",
        breakdownMore: "另有 {count} 个值",
        overviewHint:
          "每个数字均读取自 CLI 载荷；缺失字段显示 — 或“未统计”，永远不是 0。",
        /* Queue */
        queueTitle: "审查队列",
        queueSub:
          "按模型与发现排序的待审查账户。点击某行会在“档案”标签页加载该账户的档案；此处内容不是裁定、封禁或指令。",
        queueAccounts: "账户数",
        queueEligible: "符合条件",
        queueReturned: "已返回",
        queueAgents: "代理数",
        queueScored: "已评分",
        queueMethod: "方法",
        queueEligibility: "入选条件",
        queueRankBasis: "排序依据",
        queueColRank: "排名",
        queueColAccount: "账户",
        queueColAgent: "代理",
        queueColModel: "模型",
        queueColCriticalHigh: "严重 / 高",
        queueColFlags: "标记",
        queueColBets: "投注数",
        queueColReasons: "原因",
        queueNoModel: "无模型",
        queueNoScore: "无评分",
        queueFlagsBot: "机器人",
        queueFlagsReversed: "冲正",
        queueFlagsManual: "人工",
        queueFlagsDrift: "漂移",
        queueEmpty: "队列中没有账户 — 实测符合条件集合为空。",
        queueDossierHint: "已加载 {account} 的档案 — 打开“档案”标签页查看。",
        /* Explore */
        exploreTitle: "探索",
        exploreSub:
          "在冻结常量下对日志的描述性探索。候选仅为探索性结果，并非发现；待办字段是可用性事实，并非实现声明。",
        exploreFrozenDetectors: "{count} 个冻结检测器",
        exploreCatalogPresent: "目录存在",
        exploreCatalogMissing: "目录缺失",
        exploreCatalogPath: "目录路径",
        exploreCatalogMissingBody:
          "研究目录缺失，因此拟议待办条目来自冻结的备用列表；它们不代表任何目录内容。",
        exploreConstantsTitle: "常量",
        exploreConstantMinBets: "最少投注数",
        exploreConstantMaxRows: "最大行数",
        exploreConstantEntropyBucket: "熵分桶字段",
        exploreVocabularyTitle: "API 词汇",
        exploreColApiField: "API 字段",
        exploreColNormalizedField: "规范化记录字段",
        exploreColRawSource: "原始来源",
        exploreColNote: "备注",
        vocabularySport: "运动",
        vocabularySubSport: "子运动",
        vocabularyPeriod: "节次",
        vocabularyWagerType: "投注类型",
        vocabularyLine: "盘口线",
        exploreBacklogTitle: "检测器待办",
        exploreBacklogNote:
          "字段可用性仅说明所列来源字段的情况：`allListedFieldsAvailable` 不是可实施性结论，拟议检测器并未运行。",
        exploreColDetector: "检测器",
        exploreColStatus: "状态",
        exploreColFields: "字段 / 访问路径",
        exploreStatusImplemented: "已实现",
        exploreStatusProposed: "拟议",
        exploreFieldAvailable: "可用",
        exploreFieldMissing: "缺失",
        exploreFieldsAllAvailable: "所列字段均可用",
        exploreFieldsMissing: "部分所列字段缺失",
        exploreNotAFinding: "探索性 — 并非发现",
        exploreQuestion: "问题",
        exploreMethod: "方法",
        exploreCaveat: "注意",
        exploreOmittedRows: "另有 {count} 行符合条件的记录被行数上限截断",
        exploreNoRows: "在冻结常量下没有行 — 该候选为空，并非 0。",
        exploreCandidateEntropyTitle: "市场熵（探索性）",
        exploreCandidateOverrideTitle: "未归属的人工干预（探索性）",
        exploreCandidateStakeTitle: "注额集中度（探索性）",
        exploreColAccount: "账户",
        exploreColAgent: "代理",
        exploreColBets: "投注数",
        exploreColEntropyBits: "熵（比特）",
        exploreColBuckets: "分桶数",
        exploreColTopShare: "最高占比",
        exploreColManualRows: "人工行数",
        exploreColWithoutAdmin: "无管理员行数",
        exploreColShare: "占比",
        exploreColTopStakeUsd: "最高注额 USD",
        /* IP graph */
        ipTitle: "IP 网络聚类",
        ipSub:
          "地址已脱敏：聚类以短哈希或 /24 前缀为键，不显示任何原始 IP 地址。",
        ipSummary: "汇总",
        ipDistinctIps: "独立 IP 数",
        ipSharedIps: "共享 IP 数",
        ipAccountsMultiIp: "多 IP 账户数",
        ipMaxAccountsPerIp: "单 IP 最大账户数",
        ipClustersTitle: "聚类",
        ipClusterKey: "聚类",
        ipMasked: "脱敏地址",
        ipAccounts: "账户数",
        ipBets: "投注数",
        ipSamples: "样本账户",
        ipSharedFlag: "共享",
        ipBotRingFlag: "机器人环网段",
        ipDatacenter: "数据中心类型",
        ipPrefix24: "/24 前缀",
        ipEmpty: "未报告任何聚类。",
        /* Findings */
        findingsTitle: "发现",
        findingsSub:
          "在规范化日志上运行命名检测器。证据可就地展开；输入缺失的发现会标注“数据不足”。",
        findingsCount: "{count} 项发现",
        countChip: "{label} {count}",
        severityFilter: "严重程度",
        categoryFilter: "类别",
        filterAll: "全部",
        noFindings: "当前筛选没有发现。",
        insufficientData: "数据不足",
        insufficientTitle: "数据不足",
        insufficientEmpty: "未报告数据不足说明。",
        observedTitle: "观测值",
        thresholdTitle: "阈值",
        evidenceTitle: "证据",
        provenanceTitle: "来源类型",
        expandEvidence: "展开证据",
        collapseEvidence: "收起证据",
        subjectLabel: "对象",
        severityCritical: "严重",
        severityHigh: "高",
        severityMedium: "中",
        severityLow: "低",
        severityInfo: "信息",
        categoryCourtsiding: "场边观察",
        categoryMultiAccounting: "多账户",
        categoryLineShopping: "线路套利",
        categoryMatchIntegrity: "比赛完整性",
        categoryAgentScheme: "代理方案",
        categoryTicketAnomaly: "票单异常",
        categoryIpNetwork: "IP 网络",
        categoryDataQuality: "数据质量",
        /* Model */
        modelTitle: "模型报告",
        modelSub:
          "基于 GSLive 投注行的透明弱标签逻辑回归排序器，外加账户级异常评分。它预测工作台标记代理，并不估计欺诈。",
        modelNotFittedTitle: "模型未拟合",
        modelNotFittedBody:
          "尚无模型产物，因此没有指标可显示。指标是缺失，并非零。控制台不提供拟合操作（拟合会写入产物），请运行下方命令。",
        modelFitCommandTitle: "拟合命令",
        modelNextStepTitle: "下一步",
        modelReportPath: "产物",
        modelSpecTitle: "规格",
        modelSpecProxy: "代理标签",
        modelSpecSplit: "时间切分",
        modelSpecRows: "语料库行数",
        modelSpecSha: "语料库 sha256",
        featuresTitle: "特征",
        featuresEmpty: "未报告特征。",
        featureId: "特征",
        featureLabel: "标签",
        featureKind: "类型",
        featureWeight: "权重",
        featureStats: "训练均值 / 标准差",
        metricsTitle: "指标",
        metricAucRoc: "AUC-ROC",
        metricAveragePrecision: "平均精度（PR-AUC）",
        metricPrecisionAt1: "精度@1%",
        metricPrecisionAt5: "精度@5%",
        metricBrier: "Brier 分数",
        metricEpochsRun: "迭代轮数",
        metricConverged: "已收敛",
        metricLabelSupport: "标签支持度",
        labelProxy: "代理标签",
        labelPositives: "正例",
        labelNegatives: "负例",
        labelPrevalence: "正例占比",
        metricTrainWindow: "训练窗口",
        metricHoldoutWindow: "留出窗口",
        calibrationTitle: "校准分箱",
        calibrationEmpty: "未报告校准分箱。",
        calibrationBin: "分箱",
        calibrationPredicted: "预测值",
        calibrationObserved: "观测值",
        calibrationCount: "数量",
        validationTitle: "验证",
        validationWarnings: "验证警告",
        warningObserved: "观测值：{value}",
        validationHoldout: "时间留出验证",
        validationStability: "稳定性（留出两半）",
        stabilityFirstHalf: "前半段 AUC",
        stabilitySecondHalf: "后半段 AUC",
        stabilityDelta: "绝对差值",
        driftTitle: "特征漂移",
        driftEmpty: "未报告漂移行。",
        driftFeature: "特征",
        driftShift: "标准化均值偏移",
        limitsTitle: "局限",
        noMetrics: "未报告指标。",
        noFeatures: "未报告特征。",
        corpusProvenanceTitle: "语料库溯源",
        /* Dossier */
        dossierTitle: "账户档案",
        dossierSub:
          "输入账户或代理 ID（工作台登录名/ID，不是原始 IP）。档案汇总投注聚合、发现、脱敏 IP 聚类以及模型评分。",
        dossierId: "账户或代理 ID",
        dossierIdPlaceholder: "例如 player_ABC123",
        dossierOpen: "打开档案",
        dossierEmptyHint: "输入 ID 以加载档案；提交前不会发起查询。",
        dossierUnknownSubject: "未知对象 — {id} 没有档案。",
        dossierScore: "模型评分",
        dossierBand: "档位",
        dossierNotScored: "未评分",
        dossierContributions: "主要贡献",
        dossierNoContributions: "未报告模型贡献。",
        contributionFeature: "特征",
        contributionWeight: "权重",
        contributionValue: "贡献值",
        dossierBetsTitle: "投注聚合",
        dossierFindingsTitle: "发现",
        dossierClustersTitle: "脱敏 IP 聚类",
        dossierHierarchyTitle: "代理层级",
        hierarchyAgent: "代理",
        hierarchyParent: "上级代理",
        hierarchyLevel: "层级",
        hierarchyType: "类型",
        hierarchyChain: "链路",
        dossierEvidenceTitle: "证据指针",
        dossierSourcesTitle: "来源新鲜度",
        dossierNoFindings: "该对象没有发现。",
        dossierNoClusters: "该对象没有 IP 聚类。",
        dossierNoEvidence: "未报告证据指针。",
        dossierModelReason: "模型原因",
        dossierModelCommand: "模型命令",
        subjectKindAccount: "账户",
        subjectKindAgent: "代理",
      },
    };

    /**
     * English fallback used only if the slot hands the component no `t` seat.
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string}
     */
    function fallbackT(key, params) {
      const template = DICTS.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      );
    }

    /* -------------------------------------------------------------------- */
    /* Boundary readers + formatters: never invent a number                  */
    /* -------------------------------------------------------------------- */

    /**
     * @param {unknown} value
     * @returns {value is Record<string, unknown>}
     */
    function isRecord(value) {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    }

    /**
     * @param {unknown} value
     * @returns {unknown[]}
     */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /**
     * @param {unknown} value
     * @returns {string | null}
     */
    function readText(value) {
      return typeof value === "string" && value.trim() !== "" ? value : null;
    }

    /**
     * @param {unknown} value
     * @returns {number | null}
     */
    function readNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /**
     * A count, thousands-separated; null when the payload did not report one.
     * @param {unknown} value
     * @returns {string | null}
     */
    function formatInteger(value) {
      const number = readNumber(value);
      return number === null ? null : Math.round(number).toLocaleString();
    }

    /**
     * A number on a 0..1 scale as a percentage.
     * @param {unknown} value
     * @returns {string | null}
     */
    function formatPercent(value) {
      const number = readNumber(value);
      return number === null ? null : `${(number * 100).toFixed(1)}%`;
    }

    /**
     * A fixed-precision number (metric rows).
     * @param {unknown} value
     * @param {number} digits
     * @returns {string | null}
     */
    function formatFixed(value, digits) {
      const number = readNumber(value);
      return number === null ? null : number.toFixed(digits);
    }

    /**
     * A signed fixed-precision number (model weights/contributions).
     * @param {unknown} value
     * @param {number} digits
     * @returns {string | null}
     */
    function formatSigned(value, digits) {
      const number = readNumber(value);
      if (number === null) return null;
      return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
    }

    /**
     * USD with two decimals; an unknown amount is null, not "$0.00".
     * @param {unknown} value
     * @returns {string | null}
     */
    function formatUsd(value) {
      const number = readNumber(value);
      if (number === null) return null;
      return `$${number.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }

    /**
     * An ISO timestamp as local time; null when it does not parse.
     * @param {unknown} iso
     * @returns {string | null}
     */
    function formatTimestamp(iso) {
      const text = readText(iso);
      if (text === null) return null;
      const milliseconds = Date.parse(text);
      return Number.isFinite(milliseconds)
        ? new Date(milliseconds).toLocaleString()
        : null;
    }

    /**
     * A stored epoch-milliseconds receive time as local time.
     * @param {number | null} at
     * @returns {string | null}
     */
    function formatReceivedAt(at) {
      return typeof at === "number" && Number.isFinite(at)
        ? new Date(at).toLocaleString()
        : null;
    }

    /**
     * A duration in seconds, localized.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {unknown} seconds
     * @returns {string | null}
     */
    function formatDuration(t, seconds) {
      const total = readNumber(seconds);
      if (total === null || total < 0) return null;
      if (total < 60) return t("durationSeconds", { count: Math.round(total) });
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return t("durationMinutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return t("durationHours", { count: hours });
      return t("durationDays", { count: Math.floor(hours / 24) });
    }

    /**
     * A {fromIso,toIso} window as text; a missing window is null.
     * @param {unknown} window
     * @returns {string | null}
     */
    function formatIsoWindow(window) {
      const record = isRecord(window) ? window : null;
      if (record === null) return null;
      const from = formatTimestamp(record.fromIso);
      const to = formatTimestamp(record.toIso);
      if (from === null && to === null) return null;
      return `${from ?? "?"} → ${to ?? "?"}`;
    }

    /**
     * Bound long data notes so one verbose backend sentence cannot dominate the
     * page; the full text stays in the element's title attribute.
     * @param {string} text
     * @param {number} max
     * @returns {string}
     */
    function truncateText(text, max) {
      if (text.length <= max) return text;
      return `${text.slice(0, max - 1).trimEnd()}…`;
    }

    /**
     * A data value through its locale label map, falling back to the raw value.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, string>} labels
     * @param {string | null} value
     * @returns {string}
     */
    function labelOf(t, labels, value) {
      if (value === null) return t("notAvailable");
      const key = labels[value];
      return key === undefined ? value : t(key);
    }

    /**
     * The visible state label for a FraudSourceState.state value.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {string | null} state
     * @returns {string}
     */
    function sourceStateText(t, state) {
      if (state === null) return t("notAvailable");
      const key = SOURCE_STATE_LABEL_KEYS[state];
      return key === undefined ? state : t(key);
    }

    /* -------------------------------------------------------------------- */
    /* Route transport: one GET, one AbortController per request             */
    /* -------------------------------------------------------------------- */

    /**
     * Build a structured failure from a non-2xx response or a failure body.
     * A 404 is the Host route being absent, which is a different operator
     * problem from a 502 CLI refusal, so it keeps its own code.
     * @param {number} status
     * @param {unknown} body
     * @returns {{ code: string, status: number, message: string }}
     */
    function responseFailure(status, body) {
      if (status === 404) {
        return { code: "route_absent", status, message: "" };
      }
      const record = isRecord(body) ? body : null;
      const reason = record === null ? null : readText(record.reason);
      const message = record === null ? null : readText(record.message);
      return {
        code: reason ?? `http_${status}`,
        status,
        message: message ?? "",
      };
    }

    /**
     * GET one route and return its parsed 200 body. A thrown failure is always
     * a plain `{ code, status, message }` object so the store can render it.
     * @param {string} url
     * @param {AbortSignal} signal
     * @returns {Promise<Record<string, unknown>>}
     */
    async function fetchRoute(url, signal) {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw responseFailure(response.status, body);
      if (!isRecord(body)) {
        throw {
          code: "invalid_response",
          status: response.status,
          message: "the route did not return a JSON object",
        };
      }
      if (body.ok === false) throw responseFailure(response.status, body);
      return body;
    }

    /**
     * Normalize a thrown fetch error (network, abort, timeout) to the store's
     * failure shape.
     * @param {unknown} error
     * @param {boolean} timedOut
     * @returns {{ code: string, status: number | null, message: string }}
     */
    function failureOf(error, timedOut) {
      if (timedOut) return { code: "timeout", status: null, message: "" };
      if (error !== null && typeof error === "object") {
        const record = error;
        const code = readText(record.code);
        const message = readText(record.message);
        const status = readNumber(record.status);
        if (code !== null) {
          return {
            code,
            status: status === null ? null : status,
            message: message ?? "",
          };
        }
        return {
          code: "network_error",
          status: status === null ? null : status,
          message: message ?? "",
        };
      }
      return { code: "network_error", status: null, message: String(error) };
    }

    /* -------------------------------------------------------------------- */
    /* The one store                                                         */
    /* -------------------------------------------------------------------- */

    /** Every store key; each holds one measured route payload. */
    const SOURCE_KEYS = Object.freeze([
      "status",
      "bets",
      "queue",
      "explore",
      "weblog",
      "ipGraph",
      "patterns",
      "model",
      "research",
      "dossier",
    ]);

    /**
     * Nothing measured yet. `phase` is idle | loading | ready | stale | error;
     * a stale entry keeps its last payload and carries the failed refresh.
     * @returns {{ phase: string, payload: Record<string, unknown> | null, receivedAt: number | null, refreshing: boolean, error: { code: string, status: number | null, message: string } | null }}
     */
    function initialEntry() {
      return {
        phase: "idle",
        payload: null,
        receivedAt: null,
        refreshing: false,
        error: null,
      };
    }

    /**
     * @returns {Record<string, ReturnType<typeof initialEntry>>}
     */
    function initialState() {
      const draft = {};
      for (const key of SOURCE_KEYS) draft[key] = initialEntry();
      return draft;
    }

    let state = initialState();
    const listeners = new Set();
    let disposed = false;
    /** in-flight request per store key; a superseded request is aborted. */
    const controllers = new Map();

    /**
     * @param {() => void} listener
     * @returns {() => void}
     */
    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return state;
    }

    /** Subscribe a component to the one measured snapshot. */
    function useStore() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /**
     * Publish one store entry unless the store was disposed. Callers have
     * already checked request identity, so a superseded response cannot land.
     * @param {string} key
     * @param {ReturnType<typeof initialEntry>} next
     */
    function publish(key, next) {
      if (disposed) return;
      state = { ...state, [key]: next };
      for (const listener of listeners) listener();
    }

    /**
     * Abort every in-flight request and forget it, so none of them can publish.
     * Called on panel unmount (nothing is left to render) and on disposal.
     */
    function abortAll() {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    }

    /**
     * Load one route into the store. A new request for the same key supersedes
     * (aborts) the previous one. The response publishes only while it is still
     * the current request and the store is alive.
     * @param {string} key - a SOURCE_KEYS member.
     * @param {{ force?: boolean, url?: string }} [options]
     * @returns {Promise<void>}
     */
    async function loadSource(key, options) {
      if (disposed) return;
      const opts = options ?? {};
      const previous = controllers.get(key);
      if (previous !== undefined) previous.abort();
      const controller = new AbortController();
      controllers.set(key, controller);
      const url = opts.url === undefined ? ROUTES[key] : opts.url;
      const current = state[key];
      publish(key, {
        ...current,
        phase: current.payload === null ? "loading" : "ready",
        refreshing: true,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      let outcome;
      try {
        const payload = await fetchRoute(url, controller.signal);
        outcome = { ok: true, payload };
      } catch (error) {
        outcome = { ok: false, failure: failureOf(error, timedOut) };
      } finally {
        clearTimeout(timer);
      }
      if (disposed || controllers.get(key) !== controller) return;
      controllers.delete(key);
      if (outcome.ok) {
        publish(key, {
          phase: "ready",
          payload: outcome.payload,
          receivedAt: Date.now(),
          refreshing: false,
          error: null,
        });
        return;
      }
      const previousPayload = state[key].payload;
      publish(key, {
        phase: previousPayload === null ? "error" : "stale",
        payload: previousPayload,
        receivedAt: state[key].receivedAt,
        refreshing: false,
        error: outcome.failure,
      });
    }

    /**
     * Load a route only if it has never produced a payload. Used for a tab's
     * first activation, so switching tabs does not re-spawn the CLI.
     * @param {string} key
     * @returns {Promise<void> | void}
     */
    function ensureSource(key) {
      if (disposed) return undefined;
      const entry = state[key];
      if (entry.payload === null && !entry.refreshing) {
        return loadSource(key, {});
      }
      return undefined;
    }

    /** @param {string} id @returns {string} */
    function dossierUrl(id) {
      return `${ROUTES.dossier}?id=${encodeURIComponent(id)}`;
    }

    /**
     * Load one account/agent dossier.
     * @param {string} id
     * @returns {Promise<void>}
     */
    function loadDossier(id) {
      return loadSource("dossier", { force: true, url: dossierUrl(id) });
    }

    /* -------------------------------------------------------------------- */
    /* Payload readers (exact frozen key paths; tolerant of absent fields)    */
    /* -------------------------------------------------------------------- */

    /**
     * @param {unknown} value
     * @returns {string | null}
     */
    function sourceId(value) {
      if (!isRecord(value)) return null;
      return readText(value.id);
    }

    /**
     * Normalize one FraudSourceState row; rows without an id are skipped.
     * @param {unknown} value
     * @returns {{ id: string, label: string, path: string | null, state: string | null, provenance: string | null, records: number | null, ageSeconds: number | null, stale: boolean, sha256: string | null, note: string | null, reason: string | null } | null}
     */
    function readSource(value) {
      if (!isRecord(value)) return null;
      const id = sourceId(value);
      if (id === null) return null;
      return {
        id,
        label: readText(value.label) ?? id,
        path: readText(value.path),
        state: readText(value.state),
        provenance: readText(value.provenance),
        records: readNumber(value.records),
        ageSeconds: readNumber(value.ageSeconds),
        stale: value.stale === true,
        sha256: readText(value.sha256),
        note: readText(value.note),
        reason: readText(value.reason),
      };
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {ReturnType<typeof readSource>[]}
     */
    function readSources(payload) {
      if (payload === null) return [];
      const rows = [];
      for (const raw of asArray(payload.sources)) {
        const source = readSource(raw);
        if (source !== null) rows.push(source);
      }
      return rows;
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ rows: number | null, accounts: number | null, agents: number | null, ips: number | null, window: Record<string, unknown> | null, sha256: string | null } | null}
     */
    function readCorpus(payload) {
      if (payload === null) return null;
      const corpus = isRecord(payload.corpus) ? payload.corpus : null;
      if (corpus === null) return null;
      return {
        rows: readNumber(corpus.rows),
        accounts: readNumber(corpus.accounts),
        agents: readNumber(corpus.agents),
        ips: readNumber(corpus.ips),
        window: isRecord(corpus.window) ? corpus.window : null,
        sha256: readText(corpus.sha256),
      };
    }

    /**
     * Bet-group integrity from the status payload. Returns null for a missing block or an
     * unsupported schemaVersion/status: the page must say "not reported", never "clean".
     * @param {Record<string, unknown> | null} payload
     * @returns {{ status: string, groups: number | null, crossPlayer: number | null, conflicts: number | null } | null}
     */
    function readIntegrity(payload) {
      if (payload === null) return null;
      const integrity = isRecord(payload.integrity) ? payload.integrity : null;
      if (integrity === null || integrity.schemaVersion !== 1) return null;
      const status = readText(integrity.status);
      if (status === null || !(status in INTEGRITY_STATUS_KEYS)) return null;
      const counters = isRecord(integrity.counters) ? integrity.counters : {};
      return {
        status,
        groups: readNumber(counters.groups),
        crossPlayer: readNumber(counters.crossPlayerGroups),
        conflicts: readNumber(counters.ticketFieldConflicts),
      };
    }

    /**
     * Settlement verification is a separate contract field, never folded into integrity.
     * @param {Record<string, unknown> | null} payload
     * @returns {{ status: string, blockedBy: string | null } | null}
     */
    function readSettlementVerification(payload) {
      if (payload === null) return null;
      const settlement = isRecord(payload.settlementVerification)
        ? payload.settlementVerification
        : null;
      if (settlement === null) return null;
      const status = readText(settlement.status);
      if (status === null) return null;
      return { status, blockedBy: readText(settlement.blockedBy) };
    }

    /**
     * Normalize the status model summary (ModelState); never invents metrics.
     * @param {Record<string, unknown> | null} payload
     * @returns {{ present: boolean, path: string | null, fittedAt: string | null, metrics: Record<string, unknown> | null, limits: string[], reason: string | null, command: string | null } | null}
     */
    function readModelState(payload) {
      if (payload === null) return null;
      const model = isRecord(payload.model) ? payload.model : null;
      if (model === null) return null;
      const limits = asArray(model.limits).filter(
        (limit) => typeof limit === "string",
      );
      return {
        present: model.present === true,
        path: readText(model.path),
        fittedAt: readText(model.fittedAt),
        metrics: isRecord(model.metrics) ? model.metrics : null,
        limits,
        reason: readText(model.reason),
        command: readText(model.command),
      };
    }

    /** @param {Record<string, unknown> | null} payload @returns {string | null} */
    function readNextStep(payload) {
      if (payload === null) return null;
      const nextStep = payload.nextStep;
      if (typeof nextStep === "string" && nextStep.trim() !== "") {
        return nextStep;
      }
      if (isRecord(nextStep)) {
        return readText(nextStep.command) ?? readText(nextStep.text);
      }
      return null;
    }

    /**
     * The bets aggregate (weak-label support counts). Null when absent.
     * @param {Record<string, unknown> | null} payload
     * @returns {Record<string, unknown> | null}
     */
    function readBetsAggregate(payload) {
      if (payload === null) return null;
      return isRecord(payload.aggregate) ? payload.aggregate : null;
    }

    /**
     * Normalize the four API-vocabulary breakdown arrays of a bets aggregate.
     * A null `value` is a real measured bucket (the SOURCE does not carry that
     * column), not a missing row; the renderer states that explicitly.
     * @param {Record<string, unknown> | null} aggregate
     * @returns {{ key: string, titleKey: string, rows: { value: string | null, rows: number | null }[] }[]}
     */
    function readBreakdowns(aggregate) {
      const groups = [];
      if (aggregate === null) return groups;
      for (const [key, titleKey] of Object.entries(BREAKDOWN_LABEL_KEYS)) {
        const rows = [];
        for (const raw of asArray(aggregate[key])) {
          if (!isRecord(raw)) continue;
          rows.push({ value: readText(raw.value), rows: readNumber(raw.rows) });
        }
        groups.push({ key, titleKey, rows });
      }
      return groups;
    }

    /**
     * One explore API-vocabulary entry.
     * @param {unknown} value
     * @returns {{ normalized: string | null, raw: string | null, note: string | null } | null}
     */
    function readVocabularyEntry(value) {
      if (!isRecord(value)) return null;
      const normalized = readText(value.normalized);
      const raw = readText(value.raw);
      if (normalized === null && raw === null) return null;
      return { normalized, raw, note: readText(value.note) };
    }

    /**
     * The explore API-vocabulary table in its frozen field order.
     * @param {unknown} value
     * @returns ({ field: string, normalized: string | null, raw: string | null, note: string | null })[] | null
     */
    function readVocabulary(value) {
      if (!isRecord(value)) return null;
      const entries = [];
      for (const field of VOCABULARY_FIELD_ORDER) {
        const entry = readVocabularyEntry(value[field]);
        if (entry !== null) entries.push({ field, ...entry });
      }
      return entries.length === 0 ? null : entries;
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ summary: Record<string, unknown> | null, clusters: Record<string, unknown>[] }}
     */
    function readIpGraph(payload) {
      if (payload === null) return { summary: null, clusters: [] };
      return {
        summary: isRecord(payload.summary) ? payload.summary : null,
        clusters: asArray(payload.clusters).filter(isRecord),
      };
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ posture: Record<string, unknown> | null, flags: Record<string, unknown>[], gates: Record<string, unknown>[], insufficientReason: string | null }}
     */
    function readWeblog(payload) {
      if (payload === null) {
        return {
          posture: null,
          flags: [],
          gates: [],
          insufficientReason: null,
        };
      }
      return {
        posture: isRecord(payload.posture) ? payload.posture : null,
        flags: asArray(payload.flags).filter(isRecord),
        gates: asArray(payload.gates).filter(isRecord),
        insufficientReason: readText(payload.insufficientReason),
      };
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ findings: Record<string, unknown>[], counts: Record<string, unknown> | null, insufficient: string[] }}
     */
    function readPatterns(payload) {
      if (payload === null) {
        return { findings: [], counts: null, insufficient: [] };
      }
      const insufficient = asArray(payload.insufficient).filter(
        (entry) => typeof entry === "string",
      );
      return {
        findings: asArray(payload.findings).filter(isRecord),
        counts: isRecord(payload.counts) ? payload.counts : null,
        insufficient,
      };
    }

    /**
     * @param {unknown} value
     * @returns {{ id: string, title: string, severity: string, category: string, subject: Record<string, unknown> | null, observed: Record<string, unknown> | null, threshold: Record<string, unknown> | null, evidence: Record<string, unknown>[], provenance: string[], explanation: string | null, insufficientData: boolean } | null}
     */
    function readFinding(value) {
      if (!isRecord(value)) return null;
      const id = readText(value.id);
      if (id === null) return null;
      return {
        id,
        title: readText(value.title) ?? id,
        severity: readText(value.severity) ?? "info",
        category: readText(value.category) ?? "data_quality",
        subject: isRecord(value.subject) ? value.subject : null,
        observed: isRecord(value.observed) ? value.observed : null,
        threshold: isRecord(value.threshold) ? value.threshold : null,
        evidence: asArray(value.evidence).filter(isRecord),
        provenance: asArray(value.provenance).filter(
          (entry) => typeof entry === "string",
        ),
        explanation: readText(value.explanation),
        insufficientData: value.insufficientData === true,
      };
    }

    /**
     * @param {unknown} value
     * @returns {ReturnType<typeof readFinding>[]}
     */
    function readFindings(value) {
      const findings = [];
      for (const raw of asArray(value)) {
        const finding = readFinding(raw);
        if (finding !== null) findings.push(finding);
      }
      return findings;
    }

    /**
     * Normalize the fitted model report; null unless `present` is true.
     * @param {Record<string, unknown> | null} payload
     * @returns {{ path: string | null, fittedAt: string | null, spec: Record<string, unknown> | null, features: Record<string, unknown>[], metrics: Record<string, unknown> | null, validation: Record<string, unknown> | null, limits: string[], corpusProvenance: Record<string, unknown> | null } | null}
     */
    function readModelReport(payload) {
      if (payload === null || payload.present !== true) return null;
      const limits = asArray(payload.limits).filter(
        (limit) => typeof limit === "string",
      );
      return {
        path: readText(payload.path),
        fittedAt: readText(payload.fittedAt),
        spec: isRecord(payload.spec) ? payload.spec : null,
        features: asArray(payload.features).filter(isRecord),
        metrics: isRecord(payload.metrics) ? payload.metrics : null,
        validation: isRecord(payload.validation) ? payload.validation : null,
        limits,
        corpusProvenance: isRecord(payload.corpusProvenance)
          ? payload.corpusProvenance
          : null,
      };
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ catalog: Record<string, unknown> | null, modelLimits: string[] } | null}
     */
    function readResearch(payload) {
      if (payload === null) return null;
      return {
        catalog: isRecord(payload.catalog) ? payload.catalog : null,
        modelLimits: asArray(payload.modelLimits).filter(
          (limit) => typeof limit === "string",
        ),
      };
    }

    /**
     * Normalize one IpCluster for rendering.
     * @param {unknown} value
     * @returns {{ key: string, masked: string | null, accounts: number | null, bets: number | null, samples: string[], sharedIp: boolean, botRingRange: boolean, datacenterClass: string | null } | null}
     */
    function readCluster(value) {
      if (!isRecord(value)) return null;
      const key = readText(value.key);
      if (key === null) return null;
      return {
        key,
        masked: readText(value.masked),
        accounts: readNumber(value.accounts),
        bets: readNumber(value.bets),
        samples: asArray(value.sampleAccounts)
          .filter((account) => typeof account === "string")
          .slice(0, MAX_ACCOUNT_SAMPLES),
        sharedIp: value.sharedIp === true,
        botRingRange: value.botRingRange === true,
        datacenterClass: readText(value.datacenterClass),
      };
    }

    /**
     * @param {Record<string, unknown> | null} payload
     * @returns {{ subject: Record<string, unknown> | null, hierarchy: Record<string, unknown> | null, bets: Record<string, unknown> | null, model: { present: boolean, score: number | null, band: string | null, contributions: Record<string, unknown>[], reason: string | null, command: string | null } | null, findings: ReturnType<typeof readFinding>[], clusters: ReturnType<typeof readCluster>[], evidence: Record<string, unknown>[], sources: ReturnType<typeof readSource>[] } | null}
     */
    function readDossier(payload) {
      if (payload === null) return null;
      const model = isRecord(payload.model) ? payload.model : null;
      const clusters = [];
      for (const raw of asArray(payload.ipClusters)) {
        const cluster = readCluster(raw);
        if (cluster !== null) clusters.push(cluster);
      }
      return {
        subject: isRecord(payload.subject) ? payload.subject : null,
        hierarchy: isRecord(payload.hierarchy) ? payload.hierarchy : null,
        bets: isRecord(payload.bets) ? payload.bets : null,
        model:
          model === null
            ? null
            : {
                present: model.present === true,
                score: readNumber(model.score),
                band: readText(model.band),
                contributions: asArray(model.contributions).filter(isRecord),
                reason: readText(model.reason),
                command: readText(model.command),
              },
        findings: readFindings(payload.findings),
        clusters,
        evidence: asArray(payload.evidence).filter(isRecord),
        sources: readSources(payload),
      };
    }

    /**
     * Normalize one queue row; rows without an account id are skipped.
     * @param {unknown} value
     * @returns {{ rank: number | null, account: string, agent: string | null, model: { score: number | null, band: string | null } | null, findings: { critical: number | null, high: number | null } | null, flags: { suspectedBot: number | null, reversedCredit: number | null, manualLog: number | null, oddsDrift: number | null } | null, bets: number | null, lastBetAt: string | null, reasons: string[] } | null}
     */
    function readQueueRow(value) {
      if (!isRecord(value)) return null;
      const account = readText(value.account);
      if (account === null) return null;
      const model = isRecord(value.model) ? value.model : null;
      const findings = isRecord(value.findings) ? value.findings : null;
      const flags = isRecord(value.flags) ? value.flags : null;
      return {
        rank: readNumber(value.rank),
        account,
        agent: readText(value.agent),
        model:
          model === null
            ? null
            : {
                score: readNumber(model.score),
                band: readText(model.band),
              },
        findings:
          findings === null
            ? null
            : {
                critical: readNumber(findings.critical),
                high: readNumber(findings.high),
              },
        flags:
          flags === null
            ? null
            : {
                suspectedBot: readNumber(flags.suspectedBot),
                reversedCredit: readNumber(flags.reversedCredit),
                manualLog: readNumber(flags.manualLog),
                oddsDrift: readNumber(flags.oddsDrift),
              },
        bets: readNumber(value.bets),
        lastBetAt: readText(value.lastBetAt),
        reasons: asArray(value.reasons).filter(
          (reason) => typeof reason === "string",
        ),
      };
    }

    /**
     * The queue payload: totals, method/eligibility/rank basis, model presence,
     * limits, insufficient notes and rows. Every field is optional at the
     * boundary; the renderer states an absence instead of inventing a value.
     * @param {Record<string, unknown> | null} payload
     * @returns {{ method: string | null, eligibility: string | null, rankBasis: string[], limits: string[], model: { present: boolean, fittedAt: string | null, proxy: string | null, reason: string | null } | null, totals: Record<string, unknown> | null, rows: NonNullable<ReturnType<typeof readQueueRow>>[], insufficient: string[] } | null}
     */
    function readQueue(payload) {
      if (payload === null) return null;
      const model = isRecord(payload.model) ? payload.model : null;
      const rows = [];
      for (const raw of asArray(payload.rows)) {
        const row = readQueueRow(raw);
        if (row !== null) rows.push(row);
      }
      return {
        method: readText(payload.method),
        eligibility: readText(payload.eligibility),
        rankBasis: asArray(payload.rankBasis).filter(
          (item) => typeof item === "string",
        ),
        limits: asArray(payload.limits).filter(
          (item) => typeof item === "string",
        ),
        model:
          model === null
            ? null
            : {
                present: model.present === true,
                fittedAt: readText(model.fittedAt),
                proxy: readText(model.proxy),
                reason: readText(model.reason),
              },
        totals: isRecord(payload.totals) ? payload.totals : null,
        rows,
        insufficient: asArray(payload.insufficient).filter(
          (item) => typeof item === "string",
        ),
      };
    }

    /**
     * Normalize one backlog field-availability row.
     * @param {unknown} value
     * @returns {{ field: string, available: boolean, via: string | null } | null}
     */
    function readBacklogField(value) {
      if (!isRecord(value)) return null;
      const field = readText(value.field);
      if (field === null) return null;
      return {
        field,
        available: value.available === true,
        via: readText(value.via),
      };
    }

    /**
     * One backlog entry: a detector id with its listed source fields'
     * availability. `allListedFieldsAvailable` is field-level only.
     * @param {unknown} value
     * @returns {{ id: string, status: string | null, implemented: boolean, fields: NonNullable<ReturnType<typeof readBacklogField>>[], allListedFieldsAvailable: boolean, rationale: string | null } | null}
     */
    function readBacklogEntry(value) {
      if (!isRecord(value)) return null;
      const id = readText(value.id);
      if (id === null) return null;
      const fields = [];
      for (const raw of asArray(value.fields)) {
        const field = readBacklogField(raw);
        if (field !== null) fields.push(field);
      }
      return {
        id,
        status: readText(value.status),
        implemented: value.implemented === true,
        fields,
        allListedFieldsAvailable: value.allListedFieldsAvailable === true,
        rationale: readText(value.rationale),
      };
    }

    /**
     * One exploration candidate wrapper. Rows stay raw records: each candidate
     * renderer reads exactly the columns it can state honestly.
     * @param {unknown} value
     * @returns {{ id: string | null, status: string | null, question: string | null, method: string | null, caveat: string | null, rows: Record<string, unknown>[], omittedRows: number | null } | null}
     */
    function readExploreCandidate(value) {
      if (!isRecord(value)) return null;
      return {
        id: readText(value.id),
        status: readText(value.status),
        question: readText(value.question),
        method: readText(value.method),
        caveat: readText(value.caveat),
        rows: asArray(value.rows).filter(isRecord),
        omittedRows: readNumber(value.omittedRows),
      };
    }

    /**
     * The exploration payload: constants, corpus, frozen detector ids, catalog
     * presence, backlog and the three candidates. Every field is optional at the
     * boundary; the renderer states absence instead of inventing a value.
     * @param {Record<string, unknown> | null} payload
     * @returns {{ constants: { minBets: number | null, maxRows: number | null, entropyBucket: string | null } | null, corpus: { rows: number | null, accounts: number | null, agents: number | null } | null, frozenDetectors: string[], catalogPresent: boolean, catalogPath: string | null, backlog: NonNullable<ReturnType<typeof readBacklogEntry>>[], candidates: { marketEntropy: ReturnType<typeof readExploreCandidate>, unattributedOverride: ReturnType<typeof readExploreCandidate>, stakeConcentration: ReturnType<typeof readExploreCandidate> }, limits: string[] } | null}
     */
    function readExplore(payload) {
      if (payload === null) return null;
      const constants = isRecord(payload.constants) ? payload.constants : null;
      const corpus = isRecord(payload.corpus) ? payload.corpus : null;
      const candidates = isRecord(payload.candidates)
        ? payload.candidates
        : null;
      const backlog = [];
      for (const raw of asArray(payload.backlog)) {
        const entry = readBacklogEntry(raw);
        if (entry !== null) backlog.push(entry);
      }
      return {
        constants:
          constants === null
            ? null
            : {
                minBets: readNumber(constants.minBets),
                maxRows: readNumber(constants.maxRows),
                entropyBucket: readText(constants.entropyBucket),
              },
        corpus:
          corpus === null
            ? null
            : {
                rows: readNumber(corpus.rows),
                accounts: readNumber(corpus.accounts),
                agents: readNumber(corpus.agents),
              },
        frozenDetectors: asArray(payload.frozenDetectors).filter(
          (id) => typeof id === "string",
        ),
        catalogPresent: payload.catalogPresent === true,
        catalogPath: readText(payload.catalogPath),
        vocabulary: readVocabulary(payload.vocabulary),
        backlog,
        candidates: {
          marketEntropy:
            candidates === null
              ? null
              : readExploreCandidate(candidates.marketEntropy),
          unattributedOverride:
            candidates === null
              ? null
              : readExploreCandidate(candidates.unattributedOverride),
          stakeConcentration:
            candidates === null
              ? null
              : readExploreCandidate(candidates.stakeConcentration),
        },
        limits: asArray(payload.limits).filter(
          (limit) => typeof limit === "string",
        ),
      };
    }

    /* -------------------------------------------------------------------- */
    /* Shared rendering pieces                                               */
    /* -------------------------------------------------------------------- */

    /**
     * One chip. `state`/`severity`/`provenance` become data attributes the CSS
     * colors from host tokens; no color is decided here.
     * @param {string} text
     * @param {{ key?: string, state?: string | null, severity?: string | null, provenance?: string | null, title?: string | null }} [options]
     */
    function chip(text, options) {
      const opts = options ?? {};
      const props = { className: "sec-chip", key: opts.key ?? text };
      if (opts.state !== undefined && opts.state !== null) {
        props["data-state"] = opts.state;
      }
      if (opts.severity !== undefined && opts.severity !== null) {
        props["data-severity"] = opts.severity;
      }
      if (opts.provenance !== undefined && opts.provenance !== null) {
        props["data-provenance"] = opts.provenance;
      }
      if (opts.title !== undefined && opts.title !== null) {
        props.title = opts.title;
      }
      return h("span", props, text);
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ severity?: string | null, category?: string | null, provenance?: string | null }} [options]
     */
    function findingChips(t, options) {
      const opts = options ?? {};
      const rows = [];
      if (opts.severity !== undefined && opts.severity !== null) {
        rows.push(
          chip(labelOf(t, SEVERITY_LABEL_KEYS, opts.severity ?? null), {
            key: "severity",
            severity: opts.severity,
          }),
        );
      }
      if (opts.category !== undefined && opts.category !== null) {
        rows.push(
          chip(labelOf(t, CATEGORY_LABEL_KEYS, opts.category ?? null), {
            key: "category",
          }),
        );
      }
      if (opts.provenance !== undefined && opts.provenance !== null) {
        rows.push(
          chip(labelOf(t, PROVENANCE_LABEL_KEYS, opts.provenance), {
            key: "provenance",
            provenance: opts.provenance,
          }),
        );
      }
      return rows;
    }

    /**
     * A label/value list. Values that are null are rendered as the
     * not-available marker by the caller; rows are pre-filtered here.
     * @param {{ label: string, value: unknown, key?: string }[]} rows
     */
    function metaList(rows) {
      if (rows.length === 0) return null;
      return h(
        "dl",
        { className: "sec-meta" },
        rows.map((row) =>
          h(
            "div",
            { className: "sec-meta-item", key: row.key ?? row.label },
            h("dt", null, row.label),
            h("dd", null, row.value),
          ),
        ),
      );
    }

    /**
     * A labeled card section.
     * @param {string} title
     * @param {unknown[]} children
     * @param {{ key?: string, sub?: string | null }} [options]
     */
    function card(title, children, options) {
      const opts = options ?? {};
      return h(
        "section",
        { className: "sec-card", key: opts.key ?? title },
        h("h2", { className: "sec-card-title" }, title),
        opts.sub === undefined || opts.sub === null
          ? null
          : h("p", { className: "sec-card-sub" }, opts.sub),
        children,
      );
    }

    /**
     * The reason text for a stored failure.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ code: string, status: number | null, message: string } | null} error
     * @returns {string}
     */
    function failureReason(t, error) {
      if (error === null) return t("requestFailed");
      if (error.code === "route_absent") return t("routeAbsentBody");
      if (error.code === "timeout") return t("timeoutError");
      if (error.code === "network_error") {
        return error.message === ""
          ? t("networkError")
          : `${t("networkError")}: ${error.message}`;
      }
      if (error.message !== "") {
        return `${error.code}: ${error.message}`;
      }
      return error.status === null
        ? error.code
        : `${error.code} (HTTP ${error.status})`;
    }

    /**
     * The failure callout: title, reason and Retry. Rendered only when a
     * visible card has no payload to show.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ code: string, status: number | null, message: string } | null} error
     * @param {() => void} onRetry
     */
    function failureCallout(t, error, onRetry) {
      const routeAbsent = error !== null && error.code === "route_absent";
      return h(
        "div",
        {
          className: "sec-callout",
          "data-tone": "error",
          role: "alert",
          key: "failure",
        },
        h(
          "h3",
          { className: "sec-callout-title" },
          routeAbsent ? t("routeAbsentTitle") : t("errorTitle"),
        ),
        h("p", { className: "sec-callout-text" }, failureReason(t, error)),
        h(
          "button",
          {
            type: "button",
            className: "sec-btn",
            onClick: onRetry,
            "data-action": "retry",
          },
          t("retry"),
        ),
      );
    }

    /**
     * The stale banner: the last payload stays visible, labelled with when it
     * was received and why the refresh failed.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ receivedAt: number | null, error: { code: string, status: number | null, message: string } | null }} entry
     * @param {() => void} onRetry
     */
    function staleBanner(t, entry, onRetry) {
      const receivedAt =
        formatReceivedAt(entry.receivedAt) ?? t("notAvailable");
      return h(
        "div",
        {
          className: "sec-callout",
          "data-tone": "warn",
          role: "status",
          key: "stale",
        },
        h(
          "p",
          { className: "sec-callout-text" },
          t("staleNotice", {
            time: receivedAt,
            reason: failureReason(t, entry.error),
          }),
        ),
        h(
          "button",
          {
            type: "button",
            className: "sec-btn",
            onClick: onRetry,
            "data-action": "retry-stale",
          },
          t("retry"),
        ),
      );
    }

    /**
     * The standard handling for one store entry: loading, failure, or payload
     * (with a stale banner kept above it when the last refresh failed).
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ payload: Record<string, unknown> | null, error: { code: string, status: number | null, message: string } | null }} entry
     * @param {() => void} onRetry
     * @param {() => unknown} renderPayload
     */
    function measuredSection(t, entry, onRetry, renderPayload) {
      if (entry.payload === null) {
        if (entry.error !== null)
          return failureCallout(t, entry.error, onRetry);
        return h("p", { className: "sec-loading" }, t("loading"));
      }
      const body = renderPayload();
      if (entry.error === null) return body;
      return h("div", null, staleBanner(t, entry, onRetry), body);
    }

    /**
     * The per-source rows (Overview matrix and the dossier's source freshness).
     * A source with `records: null` renders "not counted", never 0.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {ReturnType<typeof readSource>[]} sources
     */
    function sourceRows(t, sources) {
      if (sources.length === 0) {
        return h("p", { className: "sec-empty" }, t("sourceEmpty"));
      }
      return h(
        "div",
        { className: "sec-matrix" },
        sources.map((source) =>
          h(
            "div",
            {
              className: "sec-source",
              key: source.id,
              "data-state": source.state,
            },
            h(
              "div",
              { className: "sec-source-head" },
              h("span", {
                className: "sec-state-dot",
                "data-state": source.state,
                "aria-hidden": "true",
              }),
              h("span", { className: "sec-source-name" }, source.label),
              h("span", { className: "sec-source-id sec-mono" }, source.id),
              chip(sourceStateText(t, source.state), {
                key: "state",
                state: source.state,
                title: source.reason,
              }),
              source.provenance === null
                ? null
                : chip(labelOf(t, PROVENANCE_LABEL_KEYS, source.provenance), {
                    key: "provenance",
                    provenance: source.provenance,
                  }),
              h(
                "span",
                { className: "sec-source-stat" },
                `${t("sourceRecords")}: ${formatInteger(source.records) ?? t("recordsMissing")}`,
              ),
              h(
                "span",
                { className: "sec-source-stat" },
                `${t("sourceAge")}: ${formatDuration(t, source.ageSeconds) ?? t("notAvailable")}`,
              ),
            ),
            source.path === null
              ? null
              : h(
                  "div",
                  { className: "sec-source-line" },
                  h("span", { className: "sec-muted" }, `${t("sourcePath")}: `),
                  h("span", { className: "sec-mono" }, source.path),
                ),
            source.sha256 === null
              ? null
              : h(
                  "div",
                  { className: "sec-source-line" },
                  h("span", { className: "sec-muted" }, `${t("sourceSha")}: `),
                  h("span", { className: "sec-mono" }, source.sha256),
                ),
            source.note === null
              ? null
              : h(
                  "div",
                  {
                    className: "sec-source-line sec-muted",
                    title: source.note,
                  },
                  truncateText(source.note, MAX_NOTE_CHARS),
                ),
            source.state === "ok" || source.reason === null
              ? null
              : h(
                  "div",
                  {
                    className: "sec-source-line sec-source-reason",
                    "data-state": source.state,
                  },
                  `${t("sourceReason")}: ${source.reason}`,
                ),
          ),
        ),
      );
    }

    /**
     * A plain metric cell list.
     * @param {{ label: string, value: string | null }[]} metrics
     */
    function metricGrid(metrics) {
      if (metrics.length === 0) return null;
      return h(
        "div",
        { className: "sec-grid" },
        metrics.map((metric) =>
          h(
            "div",
            { className: "sec-metric", key: metric.label },
            h("span", { className: "sec-metric-label" }, metric.label),
            h("span", { className: "sec-metric-value" }, metric.value ?? "—"),
          ),
        ),
      );
    }

    /**
     * A string list whose rows are bounded for readability; the full text stays
     * in each row's title tooltip. The queue's limits/insufficient lists are long
     * backend sentences, so they use this instead of the plain list.
     * @param {string[]} rows
     * @param {string} emptyText
     * @param {string} [key]
     */
    function boundedTextList(rows, emptyText, key) {
      if (rows.length === 0) {
        return h("p", { className: "sec-empty", key }, emptyText);
      }
      return h(
        "ul",
        { className: "sec-list", key },
        rows.map((row) =>
          h("li", { key: row, title: row }, truncateText(row, MAX_NOTE_CHARS)),
        ),
      );
    }

    /**
     * A string list (limits, insufficient notes, drift, provenance).
     * @param {string[]} rows
     * @param {string} emptyText
     * @param {string} [key]
     */
    function textList(rows, emptyText, key) {
      if (rows.length === 0) {
        return h("p", { className: "sec-empty", key }, emptyText);
      }
      return h(
        "ul",
        { className: "sec-list", key },
        rows.map((row) => h("li", { key: row }, row)),
      );
    }

    /**
     * The four API-vocabulary breakdown groups of a bets aggregate (sport,
     * sub-sport, period, wager type). A bucket whose API value is null means
     * the SOURCE does not carry that column — it is labelled explicitly, never
     * rendered as 0 or "—". Lists are bounded with a "+N more" note.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown> | null} aggregate
     */
    function breakdownsBlock(t, aggregate) {
      const groups = readBreakdowns(aggregate);
      if (groups.length === 0) return null;
      return h(
        "div",
        { className: "sec-breakdowns" },
        groups.map((group) =>
          h(
            "div",
            { className: "sec-breakdown", key: group.key },
            h("h4", { className: "sec-breakdown-title" }, t(group.titleKey)),
            group.rows.length === 0
              ? h("p", { className: "sec-empty" }, t("breakdownEmpty"))
              : h(
                  "ul",
                  { className: "sec-list" },
                  group.rows.slice(0, MAX_BREAKDOWN_ROWS).map((row, index) =>
                    h(
                      "li",
                      {
                        key: `${group.key}-${index}`,
                        title:
                          row.value === null
                            ? t("breakdownNotCarried")
                            : row.value,
                      },
                      h(
                        "span",
                        {
                          className:
                            row.value === null ? "sec-muted" : "sec-mono",
                        },
                        row.value ?? t("breakdownNotCarried"),
                      ),
                      h(
                        "span",
                        { className: "sec-mono sec-breakdown-rows" },
                        ` — ${formatInteger(row.rows) ?? t("notAvailable")}`,
                      ),
                    ),
                  ),
                ),
            group.rows.length > MAX_BREAKDOWN_ROWS
              ? h(
                  "p",
                  { className: "sec-muted" },
                  t("breakdownMore", {
                    count: group.rows.length - MAX_BREAKDOWN_ROWS,
                  }),
                )
              : null,
          ),
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Overview                                                              */
    /* -------------------------------------------------------------------- */

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {() => void} onRetry
     */
    function renderOverview(t, snapshot, onRetry) {
      const statusEntry = snapshot.status;
      const statusPayload = statusEntry.payload;
      const sources = readSources(statusPayload);
      const corpus = readCorpus(statusPayload);
      const model = readModelState(statusPayload);
      const nextStep = readNextStep(statusPayload);
      const integrity = readIntegrity(statusPayload);
      const settlement = readSettlementVerification(statusPayload);
      const weblogEntry = snapshot.weblog;
      const weblog = readWeblog(weblogEntry.payload);
      const betsEntry = snapshot.bets;
      const aggregate = readBetsAggregate(betsEntry.payload);

      const sourceCard = card(
        t("sourcesTitle"),
        measuredSection(t, statusEntry, onRetry, () => sourceRows(t, sources)),
        { key: "sources", sub: t("sourcesSub") },
      );

      const corpusCard =
        corpus === null
          ? card(
              t("overviewCorpus"),
              h(
                "p",
                { className: "sec-empty" },
                statusPayload === null
                  ? statusEntry.error === null
                    ? t("loading")
                    : t("corpusUnavailable")
                  : t("corpusMissing"),
              ),
              {
                key: "corpus",
              },
            )
          : card(
              t("overviewCorpus"),
              [
                metricGrid([
                  { label: t("corpusRows"), value: formatInteger(corpus.rows) },
                  {
                    label: t("corpusAccounts"),
                    value: formatInteger(corpus.accounts),
                  },
                  {
                    label: t("corpusAgents"),
                    value: formatInteger(corpus.agents),
                  },
                  { label: t("corpusIps"), value: formatInteger(corpus.ips) },
                ]),
                metaList([
                  {
                    label: t("corpusWindow"),
                    value: formatIsoWindow(corpus.window) ?? t("notAvailable"),
                    key: "window",
                  },
                  {
                    label: t("corpusSha"),
                    value:
                      corpus.sha256 === null
                        ? t("notAvailable")
                        : h("span", { className: "sec-mono" }, corpus.sha256),
                    key: "sha",
                  },
                ]),
              ],
              { key: "corpus" },
            );

      const modelMetrics = model === null ? null : model.metrics;
      const modelCard = card(
        t("overviewModel"),
        [
          h(
            "div",
            { className: "sec-chips", key: "model-state" },
            model === null
              ? chip(t("modelUnknown"), { state: "stale" })
              : model.present
                ? chip(t("modelFitted"), { state: "ok" })
                : chip(t("modelNotFitted"), { state: "missing" }),
          ),
          h(
            "p",
            { className: "sec-proxy-note", key: "proxy" },
            t("modelProxyNote"),
          ),
          model === null
            ? h(
                "p",
                { className: "sec-empty", key: "model-empty" },
                t("modelUnknownBody"),
              )
            : h(
                "div",
                { key: "model-body" },
                model.present
                  ? metricGrid([
                      {
                        label: t("modelFittedAt"),
                        value: formatTimestamp(model.fittedAt),
                      },
                      {
                        label: t("modelAuc"),
                        value: formatFixed(modelMetrics?.aucRoc, 3),
                      },
                      {
                        label: t("modelAp"),
                        value: formatFixed(modelMetrics?.averagePrecision, 3),
                      },
                    ])
                  : [
                      model.reason === null
                        ? null
                        : h(
                            "p",
                            { className: "sec-muted", key: "reason" },
                            `${t("modelReason")}: ${model.reason}`,
                          ),
                      model.command === null
                        ? null
                        : h(
                            "div",
                            { className: "sec-command-block", key: "command" },
                            h(
                              "span",
                              { className: "sec-muted" },
                              `${t("modelFitCommand")}: `,
                            ),
                            h("code", { className: "sec-code" }, model.command),
                          ),
                    ],
              ),
          model !== null && model.limits.length > 0
            ? h(
                "div",
                { className: "sec-subsection", key: "limits" },
                h("h3", { className: "sec-subtitle" }, t("modelLimitsTitle")),
                textList(
                  model.limits.slice(0, MAX_OVERVIEW_LIMITS),
                  t("noLimits"),
                  "model-limits",
                ),
                model.limits.length > MAX_OVERVIEW_LIMITS
                  ? h(
                      "p",
                      { className: "sec-muted" },
                      t("limitsMore", {
                        count: model.limits.length - MAX_OVERVIEW_LIMITS,
                      }),
                    )
                  : null,
              )
            : null,
          nextStep === null
            ? null
            : h(
                "div",
                { className: "sec-subsection", key: "next" },
                h("h3", { className: "sec-subtitle" }, t("modelNextStep")),
                h("p", { className: "sec-muted" }, nextStep),
              ),
        ],
        { key: "model" },
      );

      const weblogPosture = weblog.posture;
      const weblogCard = card(
        t("overviewWeblog"),
        measuredSection(t, weblogEntry, onRetry, () => {
          if (weblogPosture === null) {
            return h(
              "div",
              null,
              h("p", { className: "sec-empty" }, t("weblogMissing")),
              weblog.insufficientReason === null
                ? null
                : h(
                    "p",
                    { className: "sec-muted" },
                    `${t("weblogInsufficient")}: ${weblog.insufficientReason}`,
                  ),
            );
          }
          const rows = isRecord(weblogPosture.rows) ? weblogPosture.rows : null;
          const sessions = isRecord(weblogPosture.sessions)
            ? weblogPosture.sessions
            : null;
          return h(
            "div",
            null,
            metaList([
              {
                label: t("weblogWindow"),
                value:
                  formatIsoWindow(weblogPosture.window) ?? t("notAvailable"),
                key: "window",
              },
              {
                label: t("weblogRows"),
                value: formatInteger(rows?.total) ?? t("notAvailable"),
                key: "rows",
              },
              {
                label: t("weblogSessions"),
                value: formatInteger(sessions?.sessions) ?? t("notAvailable"),
                key: "sessions",
              },
            ]),
            h("h3", { className: "sec-subtitle" }, t("weblogFlags")),
            weblog.flags.length === 0
              ? h("p", { className: "sec-empty" }, t("notAvailable"))
              : h(
                  "div",
                  { className: "sec-chips" },
                  weblog.flags.map((flag, index) => {
                    const title =
                      readText(flag.title) ?? readText(flag.id) ?? "flag";
                    const count = formatInteger(flag.count);
                    return chip(count === null ? title : `${title}: ${count}`, {
                      key: `flag-${index}`,
                      severity: readText(flag.severity),
                      title: readText(flag.id),
                    });
                  }),
                ),
            h("h3", { className: "sec-subtitle" }, t("weblogGates")),
            weblog.gates.length === 0
              ? h("p", { className: "sec-empty" }, t("notAvailable"))
              : h(
                  "ul",
                  { className: "sec-list" },
                  weblog.gates.map((gate, index) =>
                    h(
                      "li",
                      { key: `gate-${index}` },
                      h(
                        "span",
                        { className: "sec-mono" },
                        readText(gate.gate) ?? "gate",
                      ),
                      " ",
                      chip(readText(gate.status) ?? t("notAvailable"), {
                        key: "status",
                        state: readText(gate.status) === "ok" ? "ok" : "stale",
                      }),
                      readText(gate.detail) === null
                        ? null
                        : h(
                            "span",
                            { className: "sec-muted" },
                            ` ${gate.detail}`,
                          ),
                    ),
                  ),
                ),
            weblog.insufficientReason === null
              ? null
              : h(
                  "p",
                  { className: "sec-muted" },
                  `${t("weblogInsufficient")}: ${weblog.insufficientReason}`,
                ),
          );
        }),
        { key: "weblog" },
      );

      const betsCard = card(
        t("overviewBets"),
        measuredSection(t, betsEntry, onRetry, () =>
          aggregate === null
            ? h("p", { className: "sec-empty" }, t("betsEmpty"))
            : h(
                "div",
                null,
                metricGrid([
                  {
                    label: t("betsRows"),
                    value: formatInteger(aggregate.rows),
                  },
                  {
                    label: t("betsAccounts"),
                    value: formatInteger(aggregate.accounts),
                  },
                  {
                    label: t("betsAgents"),
                    value: formatInteger(aggregate.agents),
                  },
                  {
                    label: t("betsSuspectedBot"),
                    value: formatInteger(aggregate.suspectedBot),
                  },
                  {
                    label: t("betsReversedCredit"),
                    value: formatInteger(aggregate.reversedCredit),
                  },
                  {
                    label: t("betsManualLog"),
                    value: formatInteger(aggregate.manualLog),
                  },
                  {
                    label: t("betsOddsDrift"),
                    value: formatInteger(aggregate.oddsDrift),
                  },
                ]),
                isRecord(aggregate.states)
                  ? h(
                      "p",
                      { className: "sec-muted" },
                      `${t("betsStates")}: ${serializeCounts(aggregate.states)}`,
                    )
                  : null,
                breakdownsBlock(t, aggregate),
              ),
        ),
        { key: "bets" },
      );

      /**
       * Posture strip: the first questions an operator asks, answered from the payloads
       * already measured above. Every value is derived — no pinned counts.
       */
      const okSources = sources.filter(
        (source) => source.state === "ok",
      ).length;
      const staleSources = sources.filter(
        (source) => source.state === "stale",
      ).length;
      const missingSources = sources.filter(
        (source) =>
          source.state === "missing" ||
          source.state === "session_expired" ||
          source.state === "unreadable",
      ).length;
      const postureTone =
        missingSources > 0
          ? "error"
          : staleSources > 0
            ? "warn"
            : sources.length === 0
              ? "muted"
              : "ok";
      // Compose every non-ok state, so "6/11" is explained rather than guessed.
      const postureParts = [];
      if (staleSources > 0) {
        postureParts.push(t("postureStale", { count: staleSources }));
      }
      if (missingSources > 0) {
        postureParts.push(t("postureMissing", { count: missingSources }));
      }
      const postureSub =
        sources.length === 0
          ? t("notAvailable")
          : postureParts.length === 0
            ? t("postureAllOk")
            : postureParts.join(" · ");
      const postureTile = (key, tone, label, value, sub) =>
        h(
          "div",
          { className: "sec-posture-tile", key, "data-tone": tone },
          h("span", { className: "sec-posture-label" }, label),
          h("span", { className: "sec-posture-value" }, value),
          sub === null
            ? null
            : h("span", { className: "sec-posture-sub" }, sub),
        );
      const posture = h(
        "div",
        { className: "sec-posture", key: "posture" },
        postureTile(
          "sources",
          postureTone,
          t("postureSources"),
          `${formatInteger(okSources) ?? "0"} / ${formatInteger(sources.length) ?? "0"}`,
          postureSub,
        ),
        postureTile(
          "corpus",
          "muted",
          t("postureCorpus"),
          formatInteger(corpus?.rows) ?? t("notAvailable"),
          `${t("corpusAccounts")}: ${formatInteger(corpus?.accounts) ?? t("notAvailable")}`,
        ),
        postureTile(
          "model",
          model === null ? "muted" : model.present ? "ok" : "warn",
          t("postureModel"),
          model === null
            ? t("modelUnknown")
            : model.present
              ? t("modelFitted")
              : t("modelNotFitted"),
          model !== null && model.present
            ? `${t("modelAuc")}: ${formatFixed(model.metrics?.aucRoc, 3) ?? t("notAvailable")}`
            : null,
        ),
        postureTile(
          "flags",
          "muted",
          t("postureFlags"),
          formatInteger(aggregate?.suspectedBot) ?? t("notAvailable"),
          `${t("sourceRecords")}: ${formatInteger(aggregate?.rows) ?? t("notAvailable")}`,
        ),
        postureTile(
          "integrity",
          integrity === null
            ? "muted"
            : integrity.status === "verified"
              ? "ok"
              : integrity.status === "invalid"
                ? "error"
                : integrity.status === "unavailable"
                  ? "muted"
                  : "warn",
          t("postureIntegrity"),
          integrity === null
            ? t("integrityNotReported")
            : labelOf(t, INTEGRITY_STATUS_KEYS, integrity.status),
          integrity === null
            ? null
            : `${t("integrityGroups")}: ${formatInteger(integrity.groups) ?? t("notAvailable")} · ${t("integrityCrossPlayer")}: ${formatInteger(integrity.crossPlayer) ?? t("notAvailable")} · ${t("integrityConflicts")}: ${formatInteger(integrity.conflicts) ?? t("notAvailable")}`,
        ),
        postureTile(
          "settlement",
          settlement === null
            ? "muted"
            : settlement.status === "unverified"
              ? "warn"
              : "muted",
          t("postureSettlement"),
          settlement === null
            ? t("integrityNotReported")
            : labelOf(t, SETTLEMENT_STATUS_KEYS, settlement.status),
          settlement === null || settlement.blockedBy === null
            ? null
            : t("settlementNoLedger"),
        ),
      );

      return h(
        "div",
        {
          className: "sec-tabpanel",
          id: "sec-panel-overview",
          role: "tabpanel",
        },
        posture,
        sourceCard,
        h("div", { className: "sec-overview-pair" }, [corpusCard, modelCard]),
        h("div", { className: "sec-overview-pair" }, [weblogCard, betsCard]),
        h("p", { className: "sec-note" }, t("overviewHint")),
      );
    }

    /**
     * Render a flat count record as "key count · key count". Data keys stay
     * as reported; a missing count is omitted rather than shown as 0.
     * @param {Record<string, unknown>} record
     * @returns {string}
     */
    function serializeCounts(record) {
      const parts = [];
      for (const [key, value] of Object.entries(record)) {
        const count = formatInteger(value);
        if (count !== null) parts.push(`${key} ${count}`);
      }
      return parts.length === 0 ? "—" : parts.join(" · ");
    }

    /* -------------------------------------------------------------------- */
    /* Queue                                                                 */
    /* -------------------------------------------------------------------- */

    /**
     * Model cell for one queue row: score + band, or the honest absence. A
     * measured row can carry a model object with a null score (account absent
     * from the feature matrix); that is "no score", not "no model".
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readQueueRow>>["model"]} model
     */
    function queueModelCell(t, model) {
      if (model === null) {
        return h("span", { className: "sec-muted" }, t("queueNoModel"));
      }
      if (model.score === null) {
        return h("span", { className: "sec-muted" }, t("queueNoScore"));
      }
      return h(
        "span",
        { className: "sec-queue-model" },
        h(
          "span",
          { className: "sec-mono" },
          formatFixed(model.score, 1) ?? t("notAvailable"),
        ),
        model.band === null
          ? null
          : chip(labelOf(t, SEVERITY_LABEL_KEYS, model.band), {
              key: "band",
              severity: model.band,
            }),
      );
    }

    /**
     * Desk-flag counts for one queue row. These are measured counts, so a zero
     * is shown as 0 (unlike a missing source, which is never zeroed).
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readQueueRow>>["flags"]} flags
     */
    function queueFlagsText(t, flags) {
      if (flags === null) return t("notAvailable");
      const pairs = [
        ["queueFlagsBot", flags.suspectedBot],
        ["queueFlagsReversed", flags.reversedCredit],
        ["queueFlagsManual", flags.manualLog],
        ["queueFlagsDrift", flags.oddsDrift],
      ];
      const parts = [];
      for (const [key, count] of pairs) {
        const formatted = formatInteger(count);
        if (formatted !== null) parts.push(`${t(key)} ${formatted}`);
      }
      return parts.length === 0 ? t("notAvailable") : parts.join(" · ");
    }

    /**
     * One clickable queue row. The row and the account button both open the
     * account's dossier through the panel's existing submit path; the button
     * stops propagation so one click resolves once. The tab does not change.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readQueueRow>>} row
     * @param {(account: string) => void} onOpenDossier
     */
    function queueRow(t, row, onOpenDossier) {
      const reasons =
        row.reasons.length === 0
          ? t("notAvailable")
          : `${row.reasons
              .slice(0, MAX_QUEUE_REASONS)
              .join(
                " · ",
              )}${row.reasons.length > MAX_QUEUE_REASONS ? " …" : ""}`;
      return h(
        "tr",
        {
          className: "sec-queue-row",
          key: `${row.rank === null ? "?" : row.rank}:${row.account}`,
          title: t("dossierOpen"),
          onClick: () => onOpenDossier(row.account),
        },
        h(
          "td",
          { className: "sec-mono" },
          formatInteger(row.rank) ?? t("notAvailable"),
        ),
        h(
          "td",
          null,
          h(
            "button",
            {
              type: "button",
              className: "sec-link-btn",
              "data-action": "open-dossier",
              "data-account": row.account,
              onClick: (event) => {
                if (event && typeof event.stopPropagation === "function") {
                  event.stopPropagation();
                }
                onOpenDossier(row.account);
              },
            },
            row.account,
          ),
        ),
        h("td", null, row.agent ?? t("notAvailable")),
        h("td", null, queueModelCell(t, row.model)),
        h(
          "td",
          { className: "sec-mono" },
          row.findings === null
            ? t("notAvailable")
            : `${formatInteger(row.findings.critical) ?? "?"} / ${
                formatInteger(row.findings.high) ?? "?"
              }`,
        ),
        h("td", null, queueFlagsText(t, row.flags)),
        h(
          "td",
          { className: "sec-mono" },
          formatInteger(row.bets) ?? t("notAvailable"),
        ),
        h(
          "td",
          {
            className: "sec-queue-reasons",
            title:
              row.reasons.length === 0 ? undefined : row.reasons.join(" · "),
          },
          reasons,
        ),
      );
    }

    /**
     * The Queue tab: totals, method/eligibility/rank basis, model presence,
     * limits, insufficient notes and the ranked table. Rows are advisory; a
     * row click loads that account's dossier in the background.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {() => void} onRetry
     * @param {(account: string) => void} onOpenDossier
     * @param {string | null} loadedDossierAccount
     */
    function renderQueue(
      t,
      snapshot,
      onRetry,
      onOpenDossier,
      loadedDossierAccount,
    ) {
      const entry = snapshot.queue;
      return h(
        "div",
        { className: "sec-tabpanel", id: "sec-panel-queue", role: "tabpanel" },
        card(
          t("queueTitle"),
          measuredSection(t, entry, onRetry, () => {
            const queue = readQueue(entry.payload);
            if (queue === null) {
              return h("p", { className: "sec-empty" }, t("loading"));
            }
            const totals = queue.totals;
            const totalsBlock =
              totals === null
                ? null
                : metricGrid(
                    [
                      {
                        label: t("queueAccounts"),
                        value: formatInteger(totals.accounts),
                      },
                      {
                        label: t("queueEligible"),
                        value: formatInteger(totals.eligible),
                      },
                      {
                        label: t("queueReturned"),
                        value: formatInteger(totals.returned),
                      },
                      {
                        label: t("queueAgents"),
                        value: formatInteger(totals.agents),
                      },
                      {
                        label: t("queueScored"),
                        value: formatInteger(totals.scored),
                      },
                    ].filter((metric) => metric.value !== null),
                  );
            const infoRows = [];
            if (queue.method !== null) {
              infoRows.push({
                label: t("queueMethod"),
                value: queue.method,
                key: "method",
              });
            }
            if (queue.eligibility !== null) {
              infoRows.push({
                label: t("queueEligibility"),
                value: queue.eligibility,
                key: "eligibility",
              });
            }
            if (queue.rankBasis.length > 0) {
              infoRows.push({
                label: t("queueRankBasis"),
                value: queue.rankBasis.join(" · "),
                key: "rank-basis",
              });
            }
            const model = queue.model;
            const modelBlock =
              model === null
                ? h("div", { className: "sec-chips" }, [
                    chip(t("modelUnknown"), { key: "unknown", state: "stale" }),
                  ])
                : h(
                    "div",
                    null,
                    h(
                      "div",
                      { className: "sec-chips" },
                      model.present
                        ? chip(t("modelFitted"), { key: "fitted", state: "ok" })
                        : chip(t("modelNotFitted"), {
                            key: "not-fitted",
                            state: "missing",
                          }),
                    ),
                    model.present
                      ? metaList([
                          {
                            label: t("modelFittedAt"),
                            value:
                              formatTimestamp(model.fittedAt) ??
                              t("notAvailable"),
                            key: "fitted-at",
                          },
                          {
                            label: t("labelProxy"),
                            value: model.proxy ?? t("notAvailable"),
                            key: "proxy",
                          },
                        ])
                      : model.reason === null
                        ? null
                        : h(
                            "p",
                            { className: "sec-muted" },
                            `${t("modelReason")}: ${model.reason}`,
                          ),
                    model.present
                      ? h(
                          "p",
                          { className: "sec-proxy-note" },
                          t("modelProxyNote"),
                        )
                      : null,
                  );
            const rows =
              queue.rows.length === 0
                ? h("p", { className: "sec-empty" }, t("queueEmpty"))
                : h(
                    "div",
                    { className: "sec-table-wrap" },
                    h(
                      "table",
                      { className: "sec-table sec-queue-table" },
                      h(
                        "thead",
                        null,
                        h(
                          "tr",
                          null,
                          h("th", null, t("queueColRank")),
                          h("th", null, t("queueColAccount")),
                          h("th", null, t("queueColAgent")),
                          h("th", null, t("queueColModel")),
                          h("th", null, t("queueColCriticalHigh")),
                          h("th", null, t("queueColFlags")),
                          h("th", null, t("queueColBets")),
                          h("th", null, t("queueColReasons")),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        queue.rows.map((row) =>
                          queueRow(t, row, onOpenDossier),
                        ),
                      ),
                    ),
                  );
            return h(
              "div",
              null,
              totalsBlock,
              infoRows.length === 0 ? null : metaList(infoRows),
              h("h3", { className: "sec-subtitle" }, t("overviewModel")),
              modelBlock,
              queue.limits.length === 0
                ? null
                : h(
                    "div",
                    { className: "sec-subsection" },
                    h("h3", { className: "sec-subtitle" }, t("limitsTitle")),
                    boundedTextList(
                      queue.limits,
                      t("noLimits"),
                      "queue-limits",
                    ),
                  ),
              queue.insufficient.length === 0
                ? null
                : h(
                    "div",
                    { className: "sec-subsection" },
                    h(
                      "h3",
                      { className: "sec-subtitle" },
                      t("insufficientTitle"),
                    ),
                    boundedTextList(
                      queue.insufficient,
                      t("insufficientEmpty"),
                      "queue-insufficient",
                    ),
                  ),
              h("h3", { className: "sec-subtitle" }, t("betsRows")),
              rows,
              loadedDossierAccount === null
                ? null
                : h(
                    "p",
                    { className: "sec-note" },
                    t("queueDossierHint", {
                      account: loadedDossierAccount,
                    }),
                  ),
            );
          }),
          { sub: t("queueSub") },
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Explore                                                               */
    /* -------------------------------------------------------------------- */

    /**
     * Account cell used by every exploration table: a real button that loads the
     * account's dossier through the panel's existing path, without leaving the
     * tab. The cells are not rows of a findings list, so no severity styling.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {string | null} account
     * @param {(account: string) => void} onOpenDossier
     */
    function exploreAccountCell(t, account, onOpenDossier) {
      if (account === null) {
        return h("td", null, t("notAvailable"));
      }
      return h(
        "td",
        null,
        h(
          "button",
          {
            type: "button",
            className: "sec-link-btn",
            "data-action": "open-dossier",
            "data-account": account,
            onClick: (event) => {
              if (event && typeof event.stopPropagation === "function") {
                event.stopPropagation();
              }
              onOpenDossier(account);
            },
          },
          account,
        ),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {string | null} value
     */
    function exploreTextCell(t, value) {
      return h("td", null, value ?? t("notAvailable"));
    }

    /**
     * @param {unknown} value
     */
    function exploreIntegerCell(value) {
      return h("td", { className: "sec-mono" }, formatInteger(value) ?? "—");
    }

    /**
     * @param {unknown} value
     * @param {number} digits
     */
    function exploreFixedCell(value, digits) {
      return h(
        "td",
        { className: "sec-mono" },
        formatFixed(value, digits) ?? "—",
      );
    }

    /**
     * @param {unknown} value
     */
    function explorePercentCell(value) {
      return h("td", { className: "sec-mono" }, formatPercent(value) ?? "—");
    }

    /**
     * @param {unknown} value
     */
    function exploreUsdCell(value) {
      return h("td", { className: "sec-mono" }, formatUsd(value) ?? "—");
    }

    /**
     * Column cells for the market-entropy candidate.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown>} row
     * @param {(account: string) => void} onOpenDossier
     */
    function exploreEntropyCells(t, row, onOpenDossier) {
      return [
        exploreAccountCell(t, readText(row.account), onOpenDossier),
        exploreTextCell(t, readText(row.agent)),
        exploreIntegerCell(row.bets),
        exploreFixedCell(row.entropyBits, 2),
        exploreIntegerCell(row.bucketCount),
        explorePercentCell(row.topBucketShare),
      ];
    }

    /**
     * Column cells for the unattributed-override candidate.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown>} row
     * @param {(account: string) => void} onOpenDossier
     */
    function exploreOverrideCells(t, row, onOpenDossier) {
      return [
        exploreAccountCell(t, readText(row.account), onOpenDossier),
        exploreTextCell(t, readText(row.agent)),
        exploreIntegerCell(row.manualLogRows),
        exploreIntegerCell(row.rowsWithoutAdminUser),
        explorePercentCell(row.share),
      ];
    }

    /**
     * Column cells for the stake-concentration candidate.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown>} row
     * @param {(account: string) => void} onOpenDossier
     */
    function exploreStakeCells(t, row, onOpenDossier) {
      return [
        exploreAccountCell(t, readText(row.account), onOpenDossier),
        exploreTextCell(t, readText(row.agent)),
        exploreIntegerCell(row.bets),
        explorePercentCell(row.topStakeShare),
        exploreUsdCell(row.topStakeUsd),
      ];
    }

    /**
     * One exploration candidate section: the explicit "not a finding" badge, the
     * question/method/caveat text, the compact table and the omitted-row count.
     * A candidate with no rows states that it is empty instead of rendering a
     * table of zeros.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {string} titleKey
     * @param {ReturnType<typeof readExploreCandidate>} candidate
     * @param {string[]} columns
     * @param {(t: (key: string, params?: Record<string, unknown>) => string, row: Record<string, unknown>, onOpenDossier: (account: string) => void) => unknown[]} rowCells
     * @param {(account: string) => void} onOpenDossier
     */
    function exploreCandidateBlock(
      t,
      titleKey,
      candidate,
      columns,
      rowCells,
      onOpenDossier,
    ) {
      const title = h("h3", { className: "sec-subtitle" }, t(titleKey));
      if (candidate === null) {
        return h(
          "div",
          { className: "sec-subsection", key: titleKey },
          title,
          h("p", { className: "sec-empty" }, t("notAvailable")),
        );
      }
      const badges = h(
        "div",
        { className: "sec-chips", key: "badge" },
        h(
          "span",
          { className: "sec-badge sec-explore-badge" },
          t("exploreNotAFinding"),
        ),
        candidate.id === null ? null : chip(candidate.id, { key: "id" }),
      );
      const infoRows = [
        candidate.question === null
          ? null
          : {
              label: t("exploreQuestion"),
              value: candidate.question,
              key: "question",
            },
        candidate.method === null
          ? null
          : {
              label: t("exploreMethod"),
              value: candidate.method,
              key: "method",
            },
        candidate.caveat === null
          ? null
          : {
              label: t("exploreCaveat"),
              value: candidate.caveat,
              key: "caveat",
            },
      ].filter((row) => row !== null);
      const table =
        candidate.rows.length === 0
          ? h("p", { className: "sec-empty", key: "empty" }, t("exploreNoRows"))
          : h(
              "div",
              { className: "sec-table-wrap", key: "table" },
              h(
                "table",
                { className: "sec-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    columns.map((key) => h("th", { key }, t(key))),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  candidate.rows.map((row, index) =>
                    h(
                      "tr",
                      { key: `row-${index}` },
                      rowCells(t, row, onOpenDossier),
                    ),
                  ),
                ),
              ),
            );
      return h(
        "div",
        { className: "sec-subsection", key: titleKey },
        title,
        badges,
        infoRows.length === 0 ? null : metaList(infoRows),
        table,
        candidate.omittedRows === null
          ? null
          : h(
              "p",
              { className: "sec-muted" },
              t("exploreOmittedRows", {
                count:
                  formatInteger(candidate.omittedRows) ?? t("notAvailable"),
              }),
            ),
      );
    }

    /**
     * One backlog row: detector id + rationale, status chip and the per-field
     * availability chips with their bounded `via` accessor.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readBacklogEntry>>} entry
     */
    function exploreBacklogRow(t, entry) {
      const status =
        entry.status === null
          ? entry.implemented
            ? t("exploreStatusImplemented")
            : t("exploreStatusProposed")
          : labelOf(t, EXPLORE_STATUS_LABEL_KEYS, entry.status);
      const fields = entry.fields.map((field) =>
        h(
          "div",
          { className: "sec-explore-field", key: field.field },
          chip(
            `${field.field}: ${
              field.available
                ? t("exploreFieldAvailable")
                : t("exploreFieldMissing")
            }`,
            { key: "availability", state: field.available ? "ok" : "missing" },
          ),
          field.via === null
            ? null
            : h(
                "span",
                { className: "sec-muted sec-explore-via", title: field.via },
                truncateText(field.via, MAX_NOTE_CHARS),
              ),
        ),
      );
      fields.push(
        chip(
          entry.allListedFieldsAvailable
            ? t("exploreFieldsAllAvailable")
            : t("exploreFieldsMissing"),
          {
            key: "all-fields",
            state: entry.allListedFieldsAvailable ? "ok" : "missing",
          },
        ),
      );
      return h(
        "tr",
        { key: entry.id },
        h(
          "td",
          null,
          h("span", { className: "sec-mono" }, entry.id),
          entry.rationale === null
            ? null
            : h(
                "div",
                { className: "sec-muted", title: entry.rationale },
                truncateText(entry.rationale, MAX_NOTE_CHARS),
              ),
        ),
        h(
          "td",
          null,
          chip(status, {
            key: "status",
            state: entry.implemented ? "ok" : null,
          }),
        ),
        h("td", null, h("div", { className: "sec-explore-fields" }, fields)),
      );
    }

    /**
     * The explore API-vocabulary table: API field, normalized record field, the
     * raw source accessor and an optional note. Shows the API alignment instead
     * of leaving it implicit. Raw/note strings are bounded with tooltips.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readVocabulary>>} vocabulary
     */
    function exploreVocabularyBlock(t, vocabulary) {
      return h(
        "div",
        { className: "sec-subsection", key: "vocabulary" },
        h("h3", { className: "sec-subtitle" }, t("exploreVocabularyTitle")),
        h(
          "div",
          { className: "sec-table-wrap" },
          h(
            "table",
            { className: "sec-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, t("exploreColApiField")),
                h("th", null, t("exploreColNormalizedField")),
                h("th", null, t("exploreColRawSource")),
                h("th", null, t("exploreColNote")),
              ),
            ),
            h(
              "tbody",
              null,
              vocabulary.map((entry) =>
                h(
                  "tr",
                  { key: entry.field },
                  h(
                    "td",
                    null,
                    h(
                      "span",
                      null,
                      labelOf(t, VOCABULARY_LABEL_KEYS, entry.field),
                    ),
                    h(
                      "span",
                      { className: "sec-mono sec-muted" },
                      ` (${entry.field})`,
                    ),
                  ),
                  h(
                    "td",
                    { className: "sec-mono" },
                    entry.normalized ?? t("notAvailable"),
                  ),
                  h(
                    "td",
                    null,
                    entry.raw === null
                      ? t("notAvailable")
                      : h(
                          "span",
                          {
                            className: "sec-explore-via",
                            title: entry.raw,
                          },
                          truncateText(entry.raw, MAX_NOTE_CHARS),
                        ),
                  ),
                  h(
                    "td",
                    null,
                    entry.note === null
                      ? t("notAvailable")
                      : h(
                          "span",
                          {
                            className: "sec-muted sec-explore-via",
                            title: entry.note,
                          },
                          truncateText(entry.note, MAX_NOTE_CHARS),
                        ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * The Explore payload body: corpus/constants/catalog chips, the backlog
     * table and the three exploratory candidates. No candidate is styled as a
     * finding; the badge and the copy say "exploratory — not a finding".
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {NonNullable<ReturnType<typeof readExplore>>} explore
     * @param {(account: string) => void} onOpenDossier
     * @param {string | null} loadedDossierAccount
     */
    function exploreBody(t, explore, onOpenDossier, loadedDossierAccount) {
      const corpus = explore.corpus;
      const constants = explore.constants;
      const corpusGrid =
        corpus === null
          ? null
          : metricGrid([
              {
                label: t("corpusRows"),
                value: formatInteger(corpus.rows),
              },
              {
                label: t("corpusAccounts"),
                value: formatInteger(corpus.accounts),
              },
              {
                label: t("corpusAgents"),
                value: formatInteger(corpus.agents),
              },
            ]);
      const catalogChips = h(
        "div",
        { className: "sec-chips", key: "catalog" },
        explore.catalogPresent
          ? chip(t("exploreCatalogPresent"), { key: "present", state: "ok" })
          : chip(t("exploreCatalogMissing"), {
              key: "missing",
              state: "missing",
            }),
        chip(
          t("exploreFrozenDetectors", {
            count:
              formatInteger(explore.frozenDetectors.length) ??
              t("notAvailable"),
          }),
          {
            key: "frozen",
            title:
              explore.frozenDetectors.length === 0
                ? undefined
                : explore.frozenDetectors.join(" · "),
          },
        ),
      );
      const catalogInfo =
        explore.catalogPath === null
          ? null
          : metaList([
              {
                label: t("exploreCatalogPath"),
                value: h(
                  "span",
                  { className: "sec-mono" },
                  explore.catalogPath,
                ),
                key: "catalog-path",
              },
            ]);
      const catalogMissing = explore.catalogPresent
        ? null
        : h("p", { className: "sec-muted" }, t("exploreCatalogMissingBody"));
      const constantsBlock =
        constants === null
          ? null
          : h(
              "div",
              { className: "sec-subsection", key: "constants" },
              h(
                "h3",
                { className: "sec-subtitle" },
                t("exploreConstantsTitle"),
              ),
              metaList([
                {
                  label: t("exploreConstantMinBets"),
                  value: formatInteger(constants.minBets) ?? t("notAvailable"),
                  key: "min-bets",
                },
                {
                  label: t("exploreConstantMaxRows"),
                  value: formatInteger(constants.maxRows) ?? t("notAvailable"),
                  key: "max-rows",
                },
                {
                  label: t("exploreConstantEntropyBucket"),
                  value:
                    constants.entropyBucket === null
                      ? t("notAvailable")
                      : h(
                          "span",
                          { className: "sec-mono" },
                          constants.entropyBucket,
                        ),
                  key: "entropy-bucket",
                },
              ]),
            );
      const backlogBlock = h(
        "div",
        { className: "sec-subsection", key: "backlog" },
        h("h3", { className: "sec-subtitle" }, t("exploreBacklogTitle")),
        h("p", { className: "sec-muted" }, t("exploreBacklogNote")),
        explore.backlog.length === 0
          ? h("p", { className: "sec-empty" }, t("notAvailable"))
          : h(
              "div",
              { className: "sec-table-wrap" },
              h(
                "table",
                { className: "sec-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    h("th", null, t("exploreColDetector")),
                    h("th", null, t("exploreColStatus")),
                    h("th", null, t("exploreColFields")),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  explore.backlog.map((entry) => exploreBacklogRow(t, entry)),
                ),
              ),
            ),
      );
      const candidateBlocks = [
        exploreCandidateBlock(
          t,
          "exploreCandidateEntropyTitle",
          explore.candidates.marketEntropy,
          [
            "exploreColAccount",
            "exploreColAgent",
            "exploreColBets",
            "exploreColEntropyBits",
            "exploreColBuckets",
            "exploreColTopShare",
          ],
          exploreEntropyCells,
          onOpenDossier,
        ),
        exploreCandidateBlock(
          t,
          "exploreCandidateOverrideTitle",
          explore.candidates.unattributedOverride,
          [
            "exploreColAccount",
            "exploreColAgent",
            "exploreColManualRows",
            "exploreColWithoutAdmin",
            "exploreColShare",
          ],
          exploreOverrideCells,
          onOpenDossier,
        ),
        exploreCandidateBlock(
          t,
          "exploreCandidateStakeTitle",
          explore.candidates.stakeConcentration,
          [
            "exploreColAccount",
            "exploreColAgent",
            "exploreColBets",
            "exploreColTopShare",
            "exploreColTopStakeUsd",
          ],
          exploreStakeCells,
          onOpenDossier,
        ),
      ];
      const vocabularyBlock =
        explore.vocabulary === null
          ? null
          : exploreVocabularyBlock(t, explore.vocabulary);
      const limitsBlock =
        explore.limits.length === 0
          ? null
          : h(
              "div",
              { className: "sec-subsection", key: "limits" },
              h("h3", { className: "sec-subtitle" }, t("limitsTitle")),
              boundedTextList(explore.limits, t("noLimits"), "explore-limits"),
            );
      return h(
        "div",
        null,
        corpusGrid,
        catalogChips,
        catalogInfo,
        catalogMissing,
        constantsBlock,
        vocabularyBlock,
        backlogBlock,
        candidateBlocks,
        limitsBlock,
        loadedDossierAccount === null
          ? null
          : h(
              "p",
              { className: "sec-note" },
              t("queueDossierHint", { account: loadedDossierAccount }),
            ),
      );
    }

    /**
     * The Explore tab: one measured section for the whole payload.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {() => void} onRetry
     * @param {(account: string) => void} onOpenDossier
     * @param {string | null} loadedDossierAccount
     */
    function renderExplore(
      t,
      snapshot,
      onRetry,
      onOpenDossier,
      loadedDossierAccount,
    ) {
      const entry = snapshot.explore;
      return h(
        "div",
        {
          className: "sec-tabpanel",
          id: "sec-panel-explore",
          role: "tabpanel",
        },
        card(
          t("exploreTitle"),
          measuredSection(t, entry, onRetry, () => {
            const explore = readExplore(entry.payload);
            return explore === null
              ? h("p", { className: "sec-empty" }, t("loading"))
              : exploreBody(t, explore, onOpenDossier, loadedDossierAccount);
          }),
          { sub: t("exploreSub") },
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* IP graph                                                              */
    /* -------------------------------------------------------------------- */

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {() => void} onRetry
     */
    function renderIpGraph(t, snapshot, onRetry) {
      const entry = snapshot.ipGraph;
      const graph = readIpGraph(entry.payload);
      const summary = graph.summary;
      const clusters = [];
      for (const raw of graph.clusters) {
        const cluster = readCluster(raw);
        if (cluster !== null) clusters.push(cluster);
      }
      const visible = clusters.slice(0, MAX_CLUSTERS);
      return h(
        "div",
        { className: "sec-tabpanel", id: "sec-panel-ip", role: "tabpanel" },
        card(
          t("ipTitle"),
          measuredSection(t, entry, onRetry, () =>
            h(
              "div",
              null,
              metricGrid([
                {
                  label: t("ipDistinctIps"),
                  value: formatInteger(summary?.distinctIps),
                },
                {
                  label: t("ipSharedIps"),
                  value: formatInteger(summary?.sharedIps),
                },
                {
                  label: t("ipAccountsMultiIp"),
                  value: formatInteger(summary?.accountsMultiIp),
                },
                {
                  label: t("ipMaxAccountsPerIp"),
                  value: formatInteger(summary?.maxAccountsPerIp),
                },
              ]),
              visible.length === 0
                ? h("p", { className: "sec-empty" }, t("ipEmpty"))
                : h(
                    "div",
                    { className: "sec-clusters" },
                    visible.map((cluster) =>
                      h(
                        "div",
                        { className: "sec-cluster", key: cluster.key },
                        h(
                          "div",
                          { className: "sec-cluster-head" },
                          h(
                            "span",
                            { className: "sec-cluster-masked sec-mono" },
                            cluster.masked ?? t("notAvailable"),
                          ),
                          chip(cluster.key, { key: "key" }),
                          h(
                            "span",
                            { className: "sec-source-stat" },
                            `${t("ipAccounts")}: ${formatInteger(cluster.accounts) ?? t("recordsMissing")}`,
                          ),
                          h(
                            "span",
                            { className: "sec-source-stat" },
                            `${t("ipBets")}: ${formatInteger(cluster.bets) ?? t("recordsMissing")}`,
                          ),
                        ),
                        h(
                          "div",
                          { className: "sec-chips" },
                          cluster.sharedIp
                            ? chip(t("ipSharedFlag"), {
                                key: "shared",
                                state: "stale",
                              })
                            : null,
                          cluster.botRingRange
                            ? chip(t("ipBotRingFlag"), {
                                key: "botring",
                                state: "missing",
                              })
                            : null,
                          cluster.datacenterClass === null
                            ? null
                            : chip(
                                `${t("ipDatacenter")}: ${cluster.datacenterClass}`,
                                { key: "dc" },
                              ),
                          ...cluster.samples.map((sample) =>
                            chip(sample, { key: `s-${sample}` }),
                          ),
                        ),
                      ),
                    ),
                  ),
            ),
          ),
          { sub: t("ipSub") },
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Findings                                                              */
    /* -------------------------------------------------------------------- */

    /**
     * One finding card: header chips, explanation, observed/threshold values,
     * provenance and the expandable evidence list.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {ReturnType<typeof readFinding>} finding
     * @param {boolean} expanded
     * @param {(id: string) => void} onToggleEvidence
     */
    function findingCard(t, finding, expanded, onToggleEvidence) {
      const evidence = finding.evidence.slice(0, MAX_EVIDENCE);
      return h(
        "article",
        {
          className: "sec-finding",
          key: finding.id,
          "data-insufficient": finding.insufficientData ? "true" : "false",
        },
        h(
          "div",
          { className: "sec-finding-head" },
          h("h3", { className: "sec-finding-title" }, finding.title),
          h(
            "div",
            { className: "sec-chips" },
            ...findingChips(t, {
              severity: finding.severity,
              category: finding.category,
            }),
            finding.insufficientData
              ? chip(t("insufficientData"), {
                  key: "insufficient",
                  state: "missing",
                })
              : null,
          ),
        ),
        h(
          "div",
          { className: "sec-finding-meta" },
          h("span", { className: "sec-mono" }, finding.id),
          finding.subject === null
            ? null
            : h(
                "span",
                { className: "sec-muted" },
                `${t("subjectLabel")}: ${readText(finding.subject.kind) ?? "?"} ${readText(finding.subject.id) ?? "?"}`,
              ),
        ),
        finding.explanation === null
          ? null
          : h("p", { className: "sec-finding-text" }, finding.explanation),
        finding.observed === null
          ? null
          : h(
              "div",
              { className: "sec-subsection" },
              h("h4", { className: "sec-subtitle" }, t("observedTitle")),
              metaList(
                Object.entries(finding.observed).map(([key, value]) => ({
                  label: key,
                  value: describeValue(t, value),
                  key,
                })),
              ),
            ),
        finding.threshold === null
          ? null
          : h(
              "div",
              { className: "sec-subsection" },
              h("h4", { className: "sec-subtitle" }, t("thresholdTitle")),
              metaList(
                Object.entries(finding.threshold).map(([key, value]) => ({
                  label: key,
                  value: describeValue(t, value),
                  key,
                })),
              ),
            ),
        finding.provenance.length === 0
          ? null
          : h(
              "div",
              { className: "sec-chips sec-subsection" },
              ...finding.provenance.map((provenance) =>
                chip(labelOf(t, PROVENANCE_LABEL_KEYS, provenance), {
                  key: provenance,
                  provenance,
                }),
              ),
            ),
        evidence.length === 0
          ? null
          : [
              h(
                "button",
                {
                  type: "button",
                  className: "sec-btn",
                  key: "toggle",
                  "data-action": "toggle-evidence",
                  "data-finding": finding.id,
                  "aria-expanded": expanded ? "true" : "false",
                  onClick: () => onToggleEvidence(finding.id),
                },
                expanded ? t("collapseEvidence") : t("expandEvidence"),
              ),
              expanded
                ? h(
                    "div",
                    { className: "sec-evidence", key: "evidence" },
                    h("h4", { className: "sec-subtitle" }, t("evidenceTitle")),
                    h(
                      "ul",
                      { className: "sec-list" },
                      evidence.map((row, index) =>
                        h(
                          "li",
                          { key: `ev-${index}` },
                          h(
                            "span",
                            { className: "sec-mono" },
                            readText(row.source) ?? "?",
                          ),
                          " ",
                          h(
                            "span",
                            { className: "sec-muted" },
                            readText(row.path) ?? "?",
                          ),
                          readText(row.pointer) === null
                            ? null
                            : h(
                                "span",
                                { className: "sec-mono" },
                                ` ${row.pointer}`,
                              ),
                        ),
                      ),
                    ),
                  )
                : null,
            ],
      );
    }

    /**
     * Render a finding's observed/threshold value: primitives as text, null as
     * the not-available marker (never a fabricated 0).
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {unknown} value
     */
    function describeValue(t, value) {
      if (value === null || value === undefined) return t("notAvailable");
      if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : t("notAvailable");
      }
      if (typeof value === "boolean") return value ? "true" : "false";
      if (typeof value === "string") return value;
      return t("notAvailable");
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {{ severity: string, category: string }} filters
     * @param {Record<string, boolean>} expanded
     * @param {() => void} onRetry
     * @param {(key: string, value: string) => void} onFilter
     * @param {(id: string) => void} onToggleEvidence
     */
    function renderFindings(
      t,
      snapshot,
      filters,
      expanded,
      onRetry,
      onFilter,
      onToggleEvidence,
    ) {
      const entry = snapshot.patterns;
      const patterns = readPatterns(entry.payload);
      const severityCounts = isRecord(patterns.counts?.bySeverity)
        ? patterns.counts.bySeverity
        : null;
      const categoryCounts = isRecord(patterns.counts?.byCategory)
        ? patterns.counts.byCategory
        : null;
      const findings = patterns.findings
        .map(readFinding)
        .filter((finding) => finding !== null)
        .filter(
          (finding) =>
            filters.severity === "all" || finding.severity === filters.severity,
        )
        .filter(
          (finding) =>
            filters.category === "all" || finding.category === filters.category,
        )
        .sort((left, right) => {
          const leftRank = SEVERITY_ORDER.indexOf(left.severity);
          const rightRank = SEVERITY_ORDER.indexOf(right.severity);
          const a = leftRank === -1 ? SEVERITY_ORDER.length : leftRank;
          const b = rightRank === -1 ? SEVERITY_ORDER.length : rightRank;
          if (a !== b) return a - b;
          return left.title.localeCompare(right.title);
        })
        .slice(0, MAX_FINDINGS);

      const countChips = [];
      if (severityCounts !== null) {
        for (const severity of SEVERITY_ORDER) {
          const count = formatInteger(severityCounts[severity]);
          if (count === null) continue;
          countChips.push(
            chip(
              t("countChip", {
                label: labelOf(t, SEVERITY_LABEL_KEYS, severity),
                count,
              }),
              { key: `count-${severity}`, severity },
            ),
          );
        }
      }

      const filterRow = h(
        "div",
        { className: "sec-filters" },
        h(
          "label",
          { className: "sec-field", key: "severity" },
          h("span", { className: "sec-field-label" }, t("severityFilter")),
          h(
            "select",
            {
              className: "sec-select",
              value: filters.severity,
              "data-filter": "severity",
              onChange: (event) => onFilter("severity", event.target.value),
            },
            h("option", { value: "all" }, t("filterAll")),
            SEVERITY_ORDER.map((severity) =>
              h(
                "option",
                { value: severity, key: severity },
                labelOf(t, SEVERITY_LABEL_KEYS, severity),
              ),
            ),
          ),
        ),
        h(
          "label",
          { className: "sec-field", key: "category" },
          h("span", { className: "sec-field-label" }, t("categoryFilter")),
          h(
            "select",
            {
              className: "sec-select",
              value: filters.category,
              "data-filter": "category",
              onChange: (event) => onFilter("category", event.target.value),
            },
            h("option", { value: "all" }, t("filterAll")),
            CATEGORY_ORDER.map((category) =>
              h(
                "option",
                { value: category, key: category },
                labelOf(t, CATEGORY_LABEL_KEYS, category),
              ),
            ),
          ),
        ),
      );

      const countsBlock =
        categoryCounts === null
          ? null
          : h(
              "p",
              { className: "sec-muted" },
              Object.entries(categoryCounts)
                .map(([category, count]) => {
                  const formatted = formatInteger(count);
                  return formatted === null
                    ? null
                    : `${labelOf(t, CATEGORY_LABEL_KEYS, category)} ${formatted}`;
                })
                .filter((part) => part !== null)
                .join(" · "),
            );

      return h(
        "div",
        {
          className: "sec-tabpanel",
          id: "sec-panel-findings",
          role: "tabpanel",
        },
        card(
          t("findingsTitle"),
          measuredSection(t, entry, onRetry, () =>
            h(
              "div",
              null,
              countChips.length === 0
                ? null
                : h("div", { className: "sec-chips" }, countChips),
              countsBlock,
              filterRow,
              patterns.insufficient.length === 0
                ? null
                : h(
                    "div",
                    { className: "sec-subsection" },
                    h(
                      "h3",
                      { className: "sec-subtitle" },
                      t("insufficientTitle"),
                    ),
                    textList(
                      patterns.insufficient,
                      t("insufficientEmpty"),
                      "insufficient",
                    ),
                  ),
              findings.length === 0
                ? h("p", { className: "sec-empty" }, t("noFindings"))
                : h(
                    "div",
                    { className: "sec-findings" },
                    findings.map((finding) =>
                      findingCard(
                        t,
                        finding,
                        expanded[finding.id] === true,
                        onToggleEvidence,
                      ),
                    ),
                  ),
            ),
          ),
          { sub: t("findingsSub") },
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Model                                                                 */
    /* -------------------------------------------------------------------- */

    /**
     * The not-fitted panel. The fit command comes from the status payload
     * (`model.command`, and `nextStep` verbatim); when neither is available the
     * page says so instead of inventing a command.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {ReturnType<typeof readModelState>} model
     * @param {string | null} nextStep
     * @param {string | null} failureMessage
     */
    function notFittedPanel(t, model, nextStep, failureMessage) {
      const command = model?.command ?? null;
      const limits = model?.limits ?? [];
      return h(
        "div",
        { className: "sec-not-fitted" },
        h("h3", { className: "sec-subtitle" }, t("modelNotFittedTitle")),
        h(
          "div",
          { className: "sec-chips" },
          chip(t("modelNotFitted"), { state: "missing" }),
        ),
        h("p", { className: "sec-card-sub" }, t("modelNotFittedBody")),
        h("p", { className: "sec-proxy-note" }, t("modelProxyNote")),
        model !== null && model.reason !== null
          ? h(
              "p",
              { className: "sec-muted" },
              `${t("modelReason")}: ${model.reason}`,
            )
          : null,
        h(
          "div",
          { className: "sec-subsection" },
          h("h3", { className: "sec-subtitle" }, t("modelFitCommandTitle")),
          command === null
            ? h(
                "p",
                { className: "sec-empty" },
                failureMessage === null ? t("noMetrics") : failureMessage,
              )
            : h("code", { className: "sec-code" }, command),
        ),
        nextStep === null
          ? null
          : h(
              "div",
              { className: "sec-subsection" },
              h("h3", { className: "sec-subtitle" }, t("modelNextStepTitle")),
              h("p", { className: "sec-muted" }, nextStep),
            ),
        limits.length === 0
          ? null
          : h(
              "div",
              { className: "sec-subsection" },
              h("h3", { className: "sec-subtitle" }, t("limitsTitle")),
              textList(limits, t("noLimits"), "model-limits"),
            ),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {() => void} onRetry
     */
    function renderModel(t, snapshot, onRetry) {
      const entry = snapshot.model;
      const report = readModelReport(entry.payload);
      const statusModel = readModelState(snapshot.status.payload);
      const nextStep = readNextStep(snapshot.status.payload);
      const research = readResearch(snapshot.research.payload);

      let body;
      if (report !== null) {
        body = h(
          "div",
          { className: "sec-model" },
          metricGrid([
            { label: t("modelReportPath"), value: report.path },
            {
              label: t("modelFittedAt"),
              value: formatTimestamp(report.fittedAt),
            },
            {
              label: t("modelSpecProxy"),
              value: readText(report.spec?.proxy),
            },
            {
              label: t("modelSpecRows"),
              value: formatInteger(report.spec?.corpusRows),
            },
          ]),
          h("p", { className: "sec-proxy-note" }, t("modelProxyNote")),
          h("h3", { className: "sec-subtitle" }, t("featuresTitle")),
          featureTable(t, report.features),
          h("h3", { className: "sec-subtitle" }, t("metricsTitle")),
          metricsSection(t, report.metrics),
          h("h3", { className: "sec-subtitle" }, t("validationTitle")),
          validationSection(t, report.validation),
          h("h3", { className: "sec-subtitle" }, t("limitsTitle")),
          textList(report.limits, t("noLimits"), "limits"),
        );
      } else if (entry.payload !== null) {
        // A 200 response that says the model is absent is still "not fitted".
        body = notFittedPanel(t, statusModel, nextStep, null);
      } else if (entry.error !== null) {
        if (entry.error.code === "model_missing") {
          body = notFittedPanel(t, statusModel, nextStep, entry.error.message);
        } else {
          body = failureCallout(t, entry.error, onRetry);
        }
      } else {
        body = h("p", { className: "sec-loading" }, t("loading"));
      }

      const researchLimits =
        research === null ? [] : report === null ? research.modelLimits : [];
      const researchBlock =
        snapshot.research.payload === null && snapshot.research.error !== null
          ? researchFailure(t, snapshot.research.error, onRetry)
          : report !== null || researchLimits.length === 0
            ? null
            : card(
                t("limitsTitle"),
                textList(researchLimits, t("noLimits"), "research-limits"),
                { key: "research-limits" },
              );

      return h(
        "div",
        { className: "sec-tabpanel", id: "sec-panel-model", role: "tabpanel" },
        card(t("modelTitle"), body, { sub: t("modelSub") }),
        researchBlock,
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {{ code: string, status: number | null, message: string }} error
     * @param {() => void} onRetry
     */
    function researchFailure(t, error, onRetry) {
      return h(
        "div",
        { className: "sec-callout", "data-tone": "warn", role: "status" },
        h("p", { className: "sec-callout-text" }, failureReason(t, error)),
        h(
          "button",
          {
            type: "button",
            className: "sec-btn",
            onClick: onRetry,
            "data-action": "retry-research",
          },
          t("retry"),
        ),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown>[]} features
     */
    function featureTable(t, features) {
      if (features.length === 0) {
        return h("p", { className: "sec-empty" }, t("noFeatures"));
      }
      return h(
        "div",
        { className: "sec-table-wrap" },
        h(
          "table",
          { className: "sec-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, t("featureId")),
              h("th", null, t("featureLabel")),
              h("th", null, t("featureKind")),
              h("th", null, t("featureWeight")),
              h("th", null, t("featureStats")),
            ),
          ),
          h(
            "tbody",
            null,
            features.slice(0, MAX_FEATURES).map((feature, index) => {
              const stats = isRecord(feature.stats) ? feature.stats : null;
              const mean = formatFixed(stats?.trainMean ?? stats?.mean, 3);
              const std = formatFixed(stats?.std, 3);
              return h(
                "tr",
                { key: readText(feature.id) ?? `feature-${index}` },
                h("td", { className: "sec-mono" }, readText(feature.id) ?? "?"),
                h("td", null, readText(feature.label) ?? "?"),
                h("td", null, readText(feature.kind) ?? "?"),
                h(
                  "td",
                  { className: "sec-mono" },
                  formatSigned(feature.weight, 4) ?? t("notAvailable"),
                ),
                h(
                  "td",
                  { className: "sec-mono" },
                  mean === null && std === null
                    ? t("notAvailable")
                    : `${mean ?? "?"} / ${std ?? "?"}`,
                ),
              );
            }),
          ),
        ),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown> | null} metrics
     */
    function metricsSection(t, metrics) {
      if (metrics === null) {
        return h("p", { className: "sec-empty" }, t("noMetrics"));
      }
      const labelSupport = isRecord(metrics.labelSupport)
        ? metrics.labelSupport
        : null;
      return h(
        "div",
        null,
        metricGrid([
          { label: t("metricAucRoc"), value: formatFixed(metrics.aucRoc, 3) },
          {
            label: t("metricAveragePrecision"),
            value: formatFixed(metrics.averagePrecision, 3),
          },
          {
            label: t("metricPrecisionAt1"),
            value: formatFixed(metrics.precisionAt1Pct, 3),
          },
          {
            label: t("metricPrecisionAt5"),
            value: formatFixed(metrics.precisionAt5Pct, 3),
          },
          {
            label: t("metricBrier"),
            value: formatFixed(metrics.brier, 3),
          },
        ]),
        metaList([
          {
            label: t("metricTrainWindow"),
            value: formatIsoWindow(metrics.trainWindow) ?? t("notAvailable"),
            key: "train-window",
          },
          {
            label: t("metricHoldoutWindow"),
            value: formatIsoWindow(metrics.holdoutWindow) ?? t("notAvailable"),
            key: "holdout-window",
          },
          {
            label: t("labelProxy"),
            value: readText(labelSupport?.proxy) ?? t("notAvailable"),
            key: "proxy",
          },
          {
            label: t("labelPositives"),
            value:
              formatInteger(labelSupport?.totalPositives) ?? t("notAvailable"),
            key: "positives",
          },
          {
            label: t("labelNegatives"),
            value:
              formatInteger(labelSupport?.trainNegatives) ?? t("notAvailable"),
            key: "negatives",
          },
          {
            label: t("labelPrevalence"),
            value: formatPercent(labelSupport?.prevalence) ?? t("notAvailable"),
            key: "prevalence",
          },
          {
            label: t("metricEpochsRun"),
            value: formatInteger(metrics.epochsRun) ?? t("notAvailable"),
            key: "epochs",
          },
          {
            label: t("metricConverged"),
            value: describeValue(t, metrics.converged),
            key: "converged",
          },
        ]),
        h("h4", { className: "sec-subtitle" }, t("calibrationTitle")),
        calibrationTable(t, metrics.calibrationBins),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {unknown} bins
     */
    function calibrationTable(t, bins) {
      const rows = asArray(bins)
        .filter(isRecord)
        .slice(0, MAX_CALIBRATION_BINS);
      if (rows.length === 0) {
        return h("p", { className: "sec-empty" }, t("calibrationEmpty"));
      }
      return h(
        "div",
        { className: "sec-table-wrap" },
        h(
          "table",
          { className: "sec-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, t("calibrationBin")),
              h("th", null, t("calibrationPredicted")),
              h("th", null, t("calibrationObserved")),
              h("th", null, t("calibrationCount")),
            ),
          ),
          h(
            "tbody",
            null,
            rows.map((bin, index) => {
              const lower = formatFixed(bin.lower, 2) ?? "?";
              const upper = formatFixed(bin.upper, 2) ?? "?";
              return h(
                "tr",
                { key: `bin-${index}` },
                h("td", { className: "sec-mono" }, `${lower}–${upper}`),
                h(
                  "td",
                  { className: "sec-mono" },
                  formatFixed(bin.predictedMean, 3) ?? t("notAvailable"),
                ),
                h(
                  "td",
                  { className: "sec-mono" },
                  formatFixed(bin.observedRate, 3) ?? t("notAvailable"),
                ),
                h(
                  "td",
                  { className: "sec-mono" },
                  formatInteger(bin.count) ?? t("notAvailable"),
                ),
              );
            }),
          ),
        ),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown> | null} validation
     */
    function validationSection(t, validation) {
      if (validation === null) {
        return h("p", { className: "sec-empty" }, t("noMetrics"));
      }
      const holdout = isRecord(validation.holdout) ? validation.holdout : null;
      const stability = isRecord(validation.stability)
        ? validation.stability
        : null;
      const drift = asArray(validation.drift).filter(isRecord);
      const warnings = asArray(validation.warnings).filter(isRecord);
      return h(
        "div",
        null,
        h("h4", { className: "sec-subtitle" }, t("validationHoldout")),
        metricGrid([
          {
            label: t("metricAucRoc"),
            value: formatFixed(holdout?.aucRoc, 3),
          },
          {
            label: t("metricAveragePrecision"),
            value: formatFixed(holdout?.averagePrecision, 3),
          },
          {
            label: t("metricPrecisionAt1"),
            value: formatFixed(holdout?.precisionAt1Pct, 3),
          },
          {
            label: t("metricPrecisionAt5"),
            value: formatFixed(holdout?.precisionAt5Pct, 3),
          },
          {
            label: t("metricBrier"),
            value: formatFixed(holdout?.brier, 3),
          },
        ]),
        h("h4", { className: "sec-subtitle" }, t("validationStability")),
        metaList([
          {
            label: t("stabilityFirstHalf"),
            value: formatFixed(stability?.firstHalfAuc, 3) ?? t("notAvailable"),
            key: "first",
          },
          {
            label: t("stabilitySecondHalf"),
            value:
              formatFixed(stability?.secondHalfAuc, 3) ?? t("notAvailable"),
            key: "second",
          },
          {
            label: t("stabilityDelta"),
            value: formatFixed(stability?.absDelta, 3) ?? t("notAvailable"),
            key: "delta",
          },
        ]),
        h("h4", { className: "sec-subtitle" }, t("driftTitle")),
        drift.length === 0
          ? h("p", { className: "sec-empty" }, t("driftEmpty"))
          : h(
              "ul",
              { className: "sec-list" },
              drift.map((row, index) =>
                h(
                  "li",
                  { key: `drift-${index}` },
                  h(
                    "span",
                    { className: "sec-mono" },
                    readText(row.feature) ?? "?",
                  ),
                  " ",
                  formatSigned(row.standardizedMeanShift, 3) ??
                    t("notAvailable"),
                ),
              ),
            ),
        warnings.length === 0
          ? null
          : h(
              "div",
              { className: "sec-subsection", key: "warnings" },
              h("h4", { className: "sec-subtitle" }, t("validationWarnings")),
              h(
                "div",
                { className: "sec-warnings" },
                warnings.map((warning, index) => {
                  const code = readText(warning.code) ?? "warning";
                  return h(
                    "div",
                    { className: "sec-warning", key: `warning-${index}` },
                    h(
                      "div",
                      { className: "sec-chips", key: "chips" },
                      chip(code, { key: "code", state: "stale" }),
                      warning.observed === undefined ||
                        warning.observed === null
                        ? null
                        : chip(
                            t("warningObserved", {
                              value: describeValue(t, warning.observed),
                            }),
                            { key: "observed" },
                          ),
                    ),
                    readText(warning.message) === null
                      ? null
                      : h("p", { className: "sec-muted" }, warning.message),
                  );
                }),
              ),
            ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Dossier                                                               */
    /* -------------------------------------------------------------------- */

    /**
     * A bet aggregate record rendered as metrics. Only keys the payload
     * actually reports are shown; absent values are omitted, not zeroed.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, unknown> | null} bets
     */
    function dossierBets(t, bets) {
      if (bets === null)
        return h("p", { className: "sec-empty" }, t("betsEmpty"));
      const metrics = [
        { label: t("betsRows"), value: formatInteger(bets.rows) },
        { label: t("betsAccounts"), value: formatInteger(bets.accounts) },
        { label: t("betsAgents"), value: formatInteger(bets.agents) },
        {
          label: t("betsSuspectedBot"),
          value: formatInteger(bets.suspectedBot),
        },
        {
          label: t("betsReversedCredit"),
          value: formatInteger(bets.reversedCredit),
        },
        {
          label: t("betsManualLog"),
          value: formatInteger(bets.manualLog),
        },
        {
          label: t("betsOddsDrift"),
          value: formatInteger(bets.oddsDrift),
        },
      ].filter((metric) => metric.value !== null);
      return h(
        "div",
        null,
        metricGrid(metrics),
        isRecord(bets.states)
          ? h(
              "p",
              { className: "sec-muted" },
              `${t("betsStates")}: ${serializeCounts(bets.states)}`,
            )
          : null,
        h(
          "div",
          { className: "sec-chips" },
          formatUsd(bets.stakeUsd) === null
            ? null
            : chip(formatUsd(bets.stakeUsd), { key: "stake" }),
          formatUsd(bets.toWinUsd) === null
            ? null
            : chip(formatUsd(bets.toWinUsd), { key: "towin" }),
          formatTimestamp(bets.lastPlacedAtIso) === null
            ? null
            : chip(formatTimestamp(bets.lastPlacedAtIso), { key: "last" }),
        ),
        breakdownsBlock(t, bets),
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {ReturnType<typeof readDossier>} dossier
     * @param {Record<string, boolean>} expanded
     * @param {(id: string) => void} onToggleEvidence
     */
    function dossierBody(t, dossier, expanded, onToggleEvidence, submittedId) {
      const subject = dossier.subject;
      const subjectKind = readText(subject?.kind);
      const subjectId = readText(subject?.id) ?? submittedId;
      const model = dossier.model;
      const modelBlock = h(
        "div",
        { className: "sec-subsection" },
        h("h3", { className: "sec-subtitle" }, t("dossierScore")),
        model === null
          ? h("p", { className: "sec-empty" }, t("dossierNotScored"))
          : [
              h(
                "div",
                { className: "sec-score-row", key: "score" },
                h(
                  "span",
                  { className: "sec-score" },
                  formatFixed(model.score, 1) ?? t("dossierNotScored"),
                ),
                model.band === null
                  ? null
                  : chip(labelOf(t, SEVERITY_LABEL_KEYS, model.band), {
                      key: "band",
                      severity: model.band,
                    }),
                model.present
                  ? null
                  : chip(t("modelNotFitted"), {
                      key: "not-fitted",
                      state: "missing",
                    }),
              ),
              h("p", { className: "sec-proxy-note" }, t("modelProxyNote")),
              model.reason === null
                ? null
                : h(
                    "p",
                    { className: "sec-muted" },
                    `${t("dossierModelReason")}: ${model.reason}`,
                  ),
              model.command === null
                ? null
                : h(
                    "div",
                    { className: "sec-command-block" },
                    h(
                      "span",
                      { className: "sec-muted" },
                      `${t("dossierModelCommand")}: `,
                    ),
                    h("code", { className: "sec-code" }, model.command),
                  ),
              h(
                "h4",
                { className: "sec-subtitle", key: "contrib-title" },
                t("dossierContributions"),
              ),
              model.contributions.length === 0
                ? h(
                    "p",
                    { className: "sec-empty", key: "no-contrib" },
                    t("dossierNoContributions"),
                  )
                : h(
                    "div",
                    { className: "sec-table-wrap", key: "contrib" },
                    h(
                      "table",
                      { className: "sec-table" },
                      h(
                        "thead",
                        null,
                        h(
                          "tr",
                          null,
                          h("th", null, t("contributionFeature")),
                          h("th", null, t("contributionWeight")),
                          h("th", null, t("contributionValue")),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        model.contributions.map((row, index) =>
                          h(
                            "tr",
                            { key: `contrib-${index}` },
                            h(
                              "td",
                              { className: "sec-mono" },
                              readText(row.feature) ?? "?",
                            ),
                            h(
                              "td",
                              { className: "sec-mono" },
                              formatSigned(row.weight, 3) ?? t("notAvailable"),
                            ),
                            h(
                              "td",
                              { className: "sec-mono" },
                              formatSigned(row.contribution, 3) ??
                                t("notAvailable"),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
            ],
      );

      const hierarchy = dossier.hierarchy;
      const hierarchyBlock =
        hierarchy === null
          ? null
          : h(
              "div",
              { className: "sec-subsection" },
              h(
                "h3",
                { className: "sec-subtitle" },
                t("dossierHierarchyTitle"),
              ),
              metaList([
                {
                  label: t("hierarchyAgent"),
                  value: readText(hierarchy.agentId) ?? t("notAvailable"),
                  key: "agent",
                },
                {
                  label: t("hierarchyParent"),
                  value: readText(hierarchy.parentAgent) ?? t("notAvailable"),
                  key: "parent",
                },
                {
                  label: t("hierarchyLevel"),
                  value: formatInteger(hierarchy.level) ?? t("notAvailable"),
                  key: "level",
                },
                {
                  label: t("hierarchyType"),
                  value: readText(hierarchy.agentType) ?? t("notAvailable"),
                  key: "type",
                },
                {
                  label: t("hierarchyChain"),
                  value:
                    asArray(hierarchy.chain)
                      .filter(isRecord)
                      .map((node) => readText(node.id))
                      .filter((id) => id !== null)
                      .join(" → ") || t("notAvailable"),
                  key: "chain",
                },
              ]),
            );

      const findingsBlock = h(
        "div",
        { className: "sec-subsection" },
        h("h3", { className: "sec-subtitle" }, t("dossierFindingsTitle")),
        dossier.findings.length === 0
          ? h("p", { className: "sec-empty" }, t("dossierNoFindings"))
          : h(
              "div",
              { className: "sec-findings" },
              dossier.findings.map((finding) =>
                findingCard(
                  t,
                  finding,
                  expanded[finding.id] === true,
                  onToggleEvidence,
                ),
              ),
            ),
      );

      const clusterBlock = h(
        "div",
        { className: "sec-subsection" },
        h("h3", { className: "sec-subtitle" }, t("dossierClustersTitle")),
        dossier.clusters.length === 0
          ? h("p", { className: "sec-empty" }, t("dossierNoClusters"))
          : h(
              "div",
              { className: "sec-chips" },
              dossier.clusters.map((cluster) =>
                chip(
                  `${cluster.masked ?? cluster.key} · ${t("ipAccounts")} ${formatInteger(cluster.accounts) ?? t("recordsMissing")}`,
                  { key: cluster.key },
                ),
              ),
            ),
      );

      const evidenceBlock = h(
        "div",
        { className: "sec-subsection" },
        h("h3", { className: "sec-subtitle" }, t("dossierEvidenceTitle")),
        dossier.evidence.length === 0
          ? h("p", { className: "sec-empty" }, t("dossierNoEvidence"))
          : h(
              "ul",
              { className: "sec-list" },
              dossier.evidence
                .slice(0, MAX_EVIDENCE)
                .map((row, index) =>
                  h(
                    "li",
                    { key: `evidence-${index}` },
                    h(
                      "span",
                      { className: "sec-mono" },
                      readText(row.source) ?? "?",
                    ),
                    " ",
                    h(
                      "span",
                      { className: "sec-muted" },
                      readText(row.path) ?? "?",
                    ),
                    readText(row.pointer) === null
                      ? null
                      : h("span", { className: "sec-mono" }, ` ${row.pointer}`),
                  ),
                ),
            ),
      );

      const sourceBlock = h(
        "div",
        { className: "sec-subsection" },
        h("h3", { className: "sec-subtitle" }, t("dossierSourcesTitle")),
        sourceRows(t, dossier.sources),
      );

      return h(
        "div",
        null,
        h(
          "div",
          { className: "sec-chips", key: "subject" },
          chip(
            `${labelOf(t, SUBJECT_KIND_LABEL_KEYS, subjectKind)}: ${subjectId}`,
          ),
        ),
        h("h3", { className: "sec-subtitle" }, t("dossierBetsTitle")),
        dossierBets(t, dossier.bets),
        modelBlock,
        hierarchyBlock,
        findingsBlock,
        clusterBlock,
        evidenceBlock,
        sourceBlock,
      );
    }

    /**
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     * @param {Record<string, ReturnType<typeof initialEntry>>} snapshot
     * @param {string | null} submittedId
     * @param {string} inputValue
     * @param {Record<string, boolean>} expanded
     * @param {(value: string) => void} onInput
     * @param {(event: { preventDefault?: () => void }) => void} onSubmit
     * @param {() => void} onRetry
     * @param {(id: string) => void} onToggleEvidence
     */
    function renderDossier(
      t,
      snapshot,
      submittedId,
      inputValue,
      expanded,
      onInput,
      onSubmit,
      onRetry,
      onToggleEvidence,
    ) {
      const entry = snapshot.dossier;
      const dossier = readDossier(entry.payload);
      let body;
      if (submittedId === null) {
        body = h("p", { className: "sec-empty" }, t("dossierEmptyHint"));
      } else if (dossier !== null) {
        body = dossierBody(t, dossier, expanded, onToggleEvidence, submittedId);
      } else if (entry.error !== null) {
        const unknownSubject =
          entry.error.code === "unknown_subject" ||
          entry.error.code === "source_missing";
        body = unknownSubject
          ? h(
              "div",
              {
                className: "sec-callout",
                "data-tone": "error",
                role: "alert",
              },
              h("h3", { className: "sec-callout-title" }, t("errorTitle")),
              h(
                "p",
                { className: "sec-callout-text" },
                t("dossierUnknownSubject", { id: submittedId }),
              ),
              entry.error.message === ""
                ? null
                : h(
                    "p",
                    { className: "sec-callout-text sec-mono" },
                    entry.error.message,
                  ),
              h(
                "button",
                {
                  type: "button",
                  className: "sec-btn",
                  onClick: onRetry,
                  "data-action": "retry-dossier",
                },
                t("retry"),
              ),
            )
          : failureCallout(t, entry.error, onRetry);
      } else {
        body = h("p", { className: "sec-loading" }, t("loading"));
      }

      return h(
        "div",
        {
          className: "sec-tabpanel",
          id: "sec-panel-dossier",
          role: "tabpanel",
        },
        card(
          t("dossierTitle"),
          [
            h(
              "form",
              {
                className: "sec-lookup",
                key: "lookup",
                onSubmit: onSubmit,
              },
              h(
                "label",
                { className: "sec-field" },
                h("span", { className: "sec-field-label" }, t("dossierId")),
                h("input", {
                  type: "text",
                  className: "sec-input",
                  value: inputValue,
                  placeholder: t("dossierIdPlaceholder"),
                  onChange: (event) => onInput(event.target.value),
                }),
              ),
              h(
                "button",
                {
                  type: "submit",
                  className: "sec-btn sec-btn-strong",
                  "data-action": "lookup",
                },
                t("dossierOpen"),
              ),
            ),
            h("div", { className: "sec-subsection", key: "body" }, body),
          ],
          { sub: t("dossierSub") },
        ),
      );
    }

    /* -------------------------------------------------------------------- */
    /* Page chrome                                                           */
    /* -------------------------------------------------------------------- */

    /** Host tokens only: every color is a theme alias, every glyph currentColor. */
    const CSS = `
.sec-page { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.6; }
.sec-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.sec-content { max-width: 1080px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.sec-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 28px; margin-bottom: 16px; }
.sec-heading { flex: 1 1 360px; min-width: 0; }
.sec-head h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.sec-sub { margin: 6px 0 0; max-width: 72ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.sec-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 8px; }
.sec-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; text-decoration: none; cursor: pointer; }
.sec-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.sec-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.sec-btn:disabled { cursor: progress; opacity: 0.6; }
.sec-btn-strong { border-color: var(--dsw-alias-brand-primary); font-weight: 500; }
.sec-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; letter-spacing: 0.04em; }
.sec-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sec-tab { appearance: none; border: 0; border-bottom: 2px solid var(--dsw-alias-bg-base); background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; padding: 8px 12px; cursor: pointer; }
.sec-tab:hover { color: var(--dsw-alias-label-primary); }
.sec-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.sec-tab[aria-selected='true'] { border-bottom-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-weight: 500; }
.sec-tabpanel { display: flex; flex-direction: column; gap: 16px; }
.sec-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 20px; }
.sec-card-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 500; }
.sec-card-sub { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.sec-subsection { margin-top: 16px; }
.sec-subtitle { margin: 16px 0 8px; font-size: 13px; line-height: 18px; font-weight: 500; }
.sec-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.sec-code { display: inline-block; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.sec-command-block { margin-top: 8px; }
.sec-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.sec-chip { display: inline-flex; align-items: center; max-width: 100%; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 18px; overflow-wrap: anywhere; }
.sec-chip[data-state='ok'] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.sec-chip[data-state='stale'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sec-chip[data-state='missing'], .sec-chip[data-state='session_expired'], .sec-chip[data-state='unreadable'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sec-chip[data-severity='critical'], .sec-chip[data-severity='high'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sec-chip[data-severity='medium'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sec-chip[data-severity='low'], .sec-chip[data-severity='info'] { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.sec-chip[data-provenance='fixture'] { border-style: dashed; border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sec-callout { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
.sec-callout[data-tone='error'] { border-color: var(--dsw-alias-state-error-primary); }
.sec-callout[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); }
.sec-callout-title { margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 500; }
.sec-callout-text { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.sec-loading { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.sec-empty { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 16px; margin: 12px 0 0; }
.sec-meta dt { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.sec-meta dd { margin: 2px 0 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.sec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
.sec-metric { display: flex; flex-direction: column; gap: 2px; }
.sec-metric-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.sec-metric-value { font-size: 15px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.sec-matrix { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.sec-source { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; }
.sec-source:first-child { border-top: 0; padding-top: 0; }
.sec-source-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sec-source-name { font-size: 13px; line-height: 18px; font-weight: 500; }
.sec-source-id { color: var(--dsw-alias-label-secondary); }
.sec-source-stat { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 18px; }
.sec-source-line { margin-top: 4px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.sec-source-reason { color: var(--dsw-alias-state-warn-primary); }
.sec-source-reason[data-state='missing'], .sec-source-reason[data-state='session_expired'], .sec-source-reason[data-state='unreadable'] { color: var(--dsw-alias-state-error-primary); }
.sec-clusters { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.sec-cluster { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; }
.sec-cluster:first-child { border-top: 0; padding-top: 0; }
.sec-cluster-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sec-cluster-masked { font-size: 13px; font-weight: 500; }
.sec-findings { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.sec-finding { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-base); padding: 14px 16px; }
.sec-finding[data-insufficient='true'] { border-style: dashed; }
.sec-finding-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
.sec-finding-title { margin: 0; font-size: 13px; line-height: 18px; font-weight: 500; }
.sec-finding-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; }
.sec-finding-text { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-finding .sec-btn { margin-top: 10px; }
.sec-evidence { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.sec-list { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.sec-filters { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.sec-field { display: flex; flex-direction: column; gap: 2px; min-width: 160px; }
.sec-field-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.sec-select { box-sizing: border-box; height: 28px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; }
.sec-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.sec-lookup { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; margin-top: 12px; }
.sec-input { box-sizing: border-box; width: min(320px, 100%); height: 28px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; }
.sec-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.sec-table-wrap { overflow-x: auto; margin-top: 8px; }
.sec-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.sec-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-weight: 500; }
.sec-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.sec-score-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-top: 4px; }
.sec-score { font-size: 28px; line-height: 34px; font-weight: 500; }
.sec-warnings { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.sec-warning { border-left: 2px solid var(--dsw-alias-state-warn-primary); padding: 6px 12px; }
.sec-warning .sec-chips { margin-top: 0; }
.sec-proxy-note { margin: 10px 0 0; padding: 8px 12px; border-left: 2px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-not-fitted { display: flex; flex-direction: column; gap: 4px; }
.sec-link-btn { appearance: none; border: 0; background: none; padding: 0; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 12px; line-height: 18px; text-align: left; text-decoration: underline; cursor: pointer; }
.sec-link-btn:hover { text-decoration: none; }
.sec-link-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.sec-queue-row { cursor: pointer; }
.sec-queue-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sec-queue-model { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sec-queue-reasons { max-width: 320px; overflow-wrap: anywhere; }
.sec-explore-badge { border-style: dashed; }
.sec-explore-fields { display: flex; flex-direction: column; gap: 4px; }
.sec-explore-field { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.sec-explore-via { overflow-wrap: anywhere; }
.sec-breakdowns { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px 20px; margin-top: 16px; }
.sec-breakdown-title { margin: 0 0 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; font-weight: 500; }
.sec-breakdown .sec-list { margin-top: 0; padding-left: 0; list-style: none; gap: 2px; }
.sec-breakdown-rows { color: var(--dsw-alias-label-secondary); }
.sec-tabpanel > .sec-note { margin-top: 4px; }
/* Overview posture strip: derived values, tone-accented, tabular numerals. */
.sec-posture { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.sec-posture-tile { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 14px 16px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); overflow: hidden; }
.sec-posture-tile::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--dsw-alias-border-l2); }
.sec-posture-tile[data-tone='ok']::before { background: var(--dsw-alias-state-success-primary); }
.sec-posture-tile[data-tone='warn']::before { background: var(--dsw-alias-state-warn-primary); }
.sec-posture-tile[data-tone='error']::before { background: var(--dsw-alias-state-error-primary); }
.sec-posture-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; letter-spacing: 0.06em; text-transform: uppercase; }
.sec-posture-value { font-size: 20px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.sec-posture-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.sec-overview-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: start; }
/* Sources stay scannable: two columns on wide pages, one on narrow ones. */
.sec-matrix { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 0 24px; }
.sec-source { min-width: 0; }
.sec-source:nth-child(-n + 2) { border-top: 0; padding-top: 0; }
.sec-source-line { overflow-wrap: anywhere; }
.sec-state-dot { flex: none; width: 8px; height: 8px; border-radius: 999px; background: var(--dsw-alias-label-secondary); }
.sec-state-dot[data-state='ok'] { background: var(--dsw-alias-state-success-primary); }
.sec-state-dot[data-state='stale'] { background: var(--dsw-alias-state-warn-primary); }
.sec-state-dot[data-state='missing'], .sec-state-dot[data-state='session_expired'], .sec-state-dot[data-state='unreadable'] { background: var(--dsw-alias-state-error-primary); }
.sec-source { transition: border-top-color 120ms ease; }
.sec-source[data-state='missing'], .sec-source[data-state='session_expired'], .sec-source[data-state='unreadable'] { border-top-color: var(--dsw-alias-state-error-primary); }
.sec-card { transition: border-color 120ms ease; }
.sec-card:hover { border-color: var(--dsw-alias-border-l2); }
.sec-card-title { letter-spacing: 0.01em; }
`;

    /** Decorative sidebar glyph; the host owns the entry's color and label. */
    function SecurityIconSvg({ size }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          "aria-hidden": true,
          focusable: "false",
          style: { display: "block" },
        },
        h("path", {
          d: "M12 3 5 6v5.5c0 4.2 2.9 7.7 7 9.5 4.1-1.8 7-5.3 7-9.5V6l-7-3Z",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M9 12.2l2.1 2.1 4-4.4",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    /** The sidebar entry: a shield glyph, no data dependency. */
    const SecurityIcon = React.memo(function SecurityIcon(props) {
      const size =
        typeof props.size === "number" && props.size > 0 ? props.size : 20;
      return h(SecurityIconSvg, { size });
    });

    /**
     * The main-column console page. All data comes from the one measured store;
     * the first render is unmeasured, so nothing looks green before a response.
     */
    const SecurityPanel = React.memo(function SecurityPanel(props) {
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const snapshot = useStore();
      const [tab, setTab] = React.useState("overview");
      const [severity, setSeverity] = React.useState("all");
      const [category, setCategory] = React.useState("all");
      const [expanded, setExpanded] = React.useState({});
      const [dossierInput, setDossierInput] = React.useState("");
      const [dossierId, setDossierId] = React.useState(null);
      const tabRefs = React.useRef({});

      // Activation: measure the Overview sources, and abort whatever is still
      // in flight when the panel closes (nothing may publish for a gone page).
      React.useEffect(() => {
        loadSource("status", { force: true });
        loadSource("weblog", { force: true });
        loadSource("bets", { force: true });
        return () => {
          abortAll();
        };
      }, []);

      // A tab loads its own route on first activation; Refresh re-measures.
      React.useEffect(() => {
        if (tab === "queue") {
          ensureSource("queue");
        } else if (tab === "explore") {
          ensureSource("explore");
        } else if (tab === "ip") {
          ensureSource("ipGraph");
        } else if (tab === "findings") {
          ensureSource("patterns");
        } else if (tab === "model") {
          ensureSource("model");
          ensureSource("research");
        }
      }, [tab]);

      const selectTab = (next) => {
        setTab(next);
        const node = tabRefs.current[next];
        if (
          node !== null &&
          node !== undefined &&
          typeof node.focus === "function"
        ) {
          node.focus();
        }
      };

      const onTabKeyDown = (event, current) => {
        const index = TAB_ORDER.indexOf(current);
        if (index < 0) return;
        let nextIndex = null;
        if (event.key === "ArrowRight") {
          nextIndex = (index + 1) % TAB_ORDER.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = TAB_ORDER.length - 1;
        }
        if (nextIndex === null) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        selectTab(TAB_ORDER[nextIndex]);
      };

      const refresh = () => {
        for (const key of TAB_SOURCE_KEYS[tab]) {
          if (key === "dossier") {
            if (dossierId !== null) loadDossier(dossierId);
          } else {
            loadSource(key, { force: true });
          }
        }
      };

      const reloadDossier = () => {
        if (dossierId !== null) loadDossier(dossierId);
      };

      const submitDossier = (event) => {
        if (event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        const id = dossierInput.trim();
        if (id === "") return;
        setDossierId(id);
        loadDossier(id);
      };

      /**
       * Queue row click: load that account's dossier through the same loader
       * the Dossier submit uses, without changing the active tab.
       * @param {string} account
       */
      const openDossier = (account) => {
        const id = typeof account === "string" ? account.trim() : "";
        if (id === "") return;
        setDossierInput(id);
        setDossierId(id);
        loadDossier(id);
      };

      const toggleEvidence = (id) => {
        setExpanded((previous) => ({
          ...previous,
          [id]: previous[id] !== true,
        }));
      };

      const setFilter = (key, value) => {
        if (key === "severity") setSeverity(value);
        else if (key === "category") setCategory(value);
      };

      const dossierView = readDossier(snapshot.dossier.payload);
      const loadedDossierAccount =
        dossierId !== null &&
        dossierView !== null &&
        dossierView.subject !== null
          ? readText(dossierView.subject.id)
          : null;

      const refreshing = TAB_SOURCE_KEYS[tab].some((key) =>
        key === "dossier"
          ? dossierId !== null && snapshot.dossier.refreshing
          : snapshot[key].refreshing,
      );

      let body;
      if (tab === "overview") {
        body = renderOverview(t, snapshot, refresh);
      } else if (tab === "queue") {
        body = renderQueue(
          t,
          snapshot,
          refresh,
          openDossier,
          loadedDossierAccount,
        );
      } else if (tab === "explore") {
        body = renderExplore(
          t,
          snapshot,
          refresh,
          openDossier,
          loadedDossierAccount,
        );
      } else if (tab === "ip") {
        body = renderIpGraph(t, snapshot, refresh);
      } else if (tab === "findings") {
        body = renderFindings(
          t,
          snapshot,
          { severity, category },
          expanded,
          refresh,
          setFilter,
          toggleEvidence,
        );
      } else if (tab === "model") {
        body = renderModel(t, snapshot, refresh);
      } else {
        body = renderDossier(
          t,
          snapshot,
          dossierId,
          dossierInput,
          expanded,
          setDossierInput,
          submitDossier,
          reloadDossier,
          toggleEvidence,
        );
      }

      return h(
        "div",
        { className: "sec-page" },
        h("style", null, CSS),
        h(
          "div",
          { className: "sec-scroll" },
          h(
            "div",
            { className: "sec-content" },
            h(
              "header",
              { className: "sec-head" },
              h(
                "div",
                { className: "sec-heading" },
                h("h1", null, t("title")),
                h("p", { className: "sec-sub" }, t("subtitle")),
              ),
              h(
                "div",
                { className: "sec-actions" },
                h("span", { className: "sec-badge" }, t("readOnly")),
                h(
                  "button",
                  {
                    type: "button",
                    className: "sec-btn sec-btn-strong",
                    "data-action": "refresh",
                    disabled: refreshing,
                    onClick: refresh,
                  },
                  refreshing ? t("refreshing") : t("refresh"),
                ),
              ),
            ),
            h(
              "div",
              {
                className: "sec-tabs",
                role: "tablist",
                "aria-label": t("tabsLabel"),
              },
              TAB_ORDER.map((tabId) =>
                h(
                  "button",
                  {
                    key: tabId,
                    type: "button",
                    role: "tab",
                    id: `sec-tab-${tabId}`,
                    className: "sec-tab",
                    "data-tab": tabId,
                    "aria-selected": tab === tabId ? "true" : "false",
                    tabIndex: tab === tabId ? 0 : -1,
                    ref: (node) => {
                      tabRefs.current[tabId] = node;
                    },
                    onClick: () => selectTab(tabId),
                    onKeyDown: (event) => onTabKeyDown(event, tabId),
                  },
                  t(TAB_LABEL_KEYS[tabId]),
                ),
              ),
            ),
            body,
          ),
        ),
      );
    });

    /* -------------------------------------------------------------------- */
    /* Plugin wiring                                                          */
    /* -------------------------------------------------------------------- */

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        // Owns the store lifetime: disposal aborts in-flight requests, drops
        // listeners and forbids every later publish.
        ctx.effect(() => {
          disposed = false;
          return () => {
            disposed = true;
            abortAll();
            listeners.clear();
          };
        }, "sportsdesk security: store lifetime");

        // Dictionaries are owned effects: they unregister with the plugin and
        // the sidebar label plus every card re-render on a language switch.
        ctx.effect(
          () => ctx.locale.register(NS, DICTS),
          "sportsdesk security: locale dictionaries",
        );
        const t = ctx.locale.bind(NS);

        // The page and the sidebar entry share one id: the sidebar selects the
        // panel by this key, so both registrations must use PANEL_ID.
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              locale: NS,
            },
            SecurityPanel,
          ),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 140,
              locale: NS,
              label: () => t("panel"),
            },
            SecurityIcon,
          ),
        );
      },
    };
  },
});
