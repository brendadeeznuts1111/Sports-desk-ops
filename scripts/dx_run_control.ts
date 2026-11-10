#!/usr/bin/env bun
/**
 * @file scripts/dx_run_control.ts
 * @description Connects Bun's live `bun run --help` surface to `./bin/dx` and `cli/sportsdesk_cli.ts`,
 * providing controlled script execution (`run`), live process/daemon/profile telemetry (`monitor`),
 * and v2 live-bets control & monitoring (`live-bets`).
 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  extractCpuHotspots,
  extractTopRetainedTypes,
  pruneDiagnosticArtifacts,
  type PruneResult,
} from "../lib/agent_diagnostics.ts";
import {
  BUN_RUN_FLAG_CATEGORIES,
  formatConnectedBunRunHelp,
  readBunRunCliSurface,
  suggestBunRunFlag,
  type BunRunCliSurface,
  type BunRunFlagCategory,
} from "../lib/bun_cli_flags.ts";
import { SECRET_MANIFEST } from "../lib/secret_manifest.ts";
import {
  isLiveBetsFallback,
  isLiveBetsSource,
  type LiveBetsFallback,
  type LiveBetsSource,
  type LiveBetsV2Response,
} from "../src/contracts/live_bets.v2.ts";
import { resolveLiveBets } from "../src/live_bets/resolve.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

const SHORT_BUN_FLAGS_WITH_VALUE = new Set([
  "-F",
  "-r",
  "-e",
  "-p",
  "-d",
  "-l",
  "-c",
]);
const SHORT_BUN_SWITCH_FLAGS = new Set(["-b", "-i"]);

const VALUE_BEARING_LONG_BUN_FLAGS = new Set([
  "--elide-lines",
  "--filter",
  "--shell",
  "--watch-kill-signal",
  "--preload",
  "--require",
  "--import",
  "--inspect",
  "--inspect-wait",
  "--inspect-brk",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--install",
  "--eval",
  "--print",
  "--port",
  "--conditions",
  "--fetch-preconnect",
  "--max-http-header-size",
  "--dns-result-order",
  "--redirect-warnings",
  "--disable-warning",
  "--title",
  "--unhandled-rejections",
  "--console-depth",
  "--user-agent",
  "--cron-title",
  "--cron-period",
  "--main-fields",
  "--extension-order",
  "--tsconfig-override",
  "--define",
  "--drop",
  "--feature",
  "--loader",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--env-file",
  "--cwd",
  "--config",
]);

export interface ActiveSecretCheck {
  readonly blocked: boolean;
  readonly reason: string | null;
}

/**
 * Enforces AGENTS.md hard rule: never allow `BUN_CONFIG_VERBOSE_FETCH` when any registered
 * secret/token/cookie is present in the process environment.
 */
export function checkVerboseFetchSecretSafety(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): ActiveSecretCheck {
  const verbose = env.BUN_CONFIG_VERBOSE_FETCH?.trim().toLowerCase();
  if (
    verbose === undefined ||
    verbose === "" ||
    verbose === "0" ||
    verbose === "false"
  ) {
    return { blocked: false, reason: null };
  }
  const activeNames: string[] = [];
  for (const entry of SECRET_MANIFEST) {
    const candidates = [entry.envName, ...(entry.aliases ?? [])];
    for (const key of candidates) {
      const val = env[key];
      if (typeof val === "string" && val.trim() !== "") {
        activeNames.push(key);
      }
    }
  }
  if (activeNames.length === 0) {
    return { blocked: false, reason: null };
  }
  return {
    blocked: true,
    reason:
      `BUN_CONFIG_VERBOSE_FETCH is set while secret env var(s) [${activeNames.join(", ")}] are populated. ` +
      "Bun logs Authorization/Cookie headers verbatim in verbose fetch mode; unset BUN_CONFIG_VERBOSE_FETCH or use --dry-run.",
  };
}

export interface ResolvedDxRunPlan {
  readonly cmd: readonly string[];
  readonly target: string;
  readonly targetArgs: readonly string[];
  readonly bunFlags: readonly string[];
  readonly cpuProfilePath: string | null;
  readonly heapProfilePath: string | null;
  readonly timeoutMs: number | null;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export function splitShellTokens(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

export function buildDxRunPlan(
  argv: readonly string[],
  surface: BunRunCliSurface,
  options: {
    readonly envFlags?: string | undefined;
    readonly bunPath?: string | undefined;
    readonly stamp?: string | undefined;
  } = {},
): ResolvedDxRunPlan {
  const bunPath = options.bunPath ?? process.execPath;
  const envTokens = options.envFlags ? splitShellTokens(options.envFlags) : [];
  const combined = [...envTokens, ...argv];

  let containment = true;
  let isolatedEnv = false;
  let profileCpu = false;
  let profileHeap = false;
  let profileDir = "scratch/profiles";
  let lowMem = false;
  let watchSafe = false;
  let debugAddr: string | null = null;
  let debugBrkAddr: string | null = null;
  let timeoutMs: number | null = null;
  let dryRun = false;
  let json = false;

  const explicitBunFlags: string[] = [];
  let target: string | null = null;
  const targetArgs: string[] = [];

  for (let i = 0; i < combined.length; i += 1) {
    const token = combined[i]!;
    if (target !== null) {
      targetArgs.push(token);
      continue;
    }
    if (token === "--") {
      const next = combined[i + 1];
      if (next === undefined) {
        throw new Error("dx run: missing <script|file> after '--'");
      }
      target = next;
      targetArgs.push(...combined.slice(i + 2));
      break;
    }

    // DX operator control & monitoring presets
    if (token === "--containment") {
      containment = true;
      continue;
    }
    if (token === "--no-containment") {
      containment = false;
      continue;
    }
    if (token === "--isolated-env") {
      isolatedEnv = true;
      continue;
    }
    if (token === "--profile") {
      profileCpu = true;
      profileHeap = true;
      continue;
    }
    if (token === "--profile-cpu") {
      profileCpu = true;
      continue;
    }
    if (token === "--profile-heap") {
      profileHeap = true;
      continue;
    }
    if (token.startsWith("--profile-dir=")) {
      profileDir = token.slice("--profile-dir=".length).trim() || profileDir;
      continue;
    }
    if (token === "--low-mem") {
      lowMem = true;
      continue;
    }
    if (token === "--watch-safe") {
      watchSafe = true;
      continue;
    }
    if (token === "--debug") {
      debugAddr = "127.0.0.1:6499";
      continue;
    }
    if (token.startsWith("--debug=")) {
      debugAddr = token.slice("--debug=".length) || "127.0.0.1:6499";
      continue;
    }
    if (token === "--debug-brk") {
      debugBrkAddr = "127.0.0.1:6499";
      continue;
    }
    if (token.startsWith("--debug-brk=")) {
      debugBrkAddr = token.slice("--debug-brk=".length) || "127.0.0.1:6499";
      continue;
    }
    if (token.startsWith("--timeout-ms=")) {
      const parsed = Number(token.slice("--timeout-ms=".length));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `dx run: --timeout-ms must be a positive number (got "${token}")`,
        );
      }
      timeoutMs = Math.floor(parsed);
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }

    // Native `bun run` flags (validated live against `bun run --help`)
    if (token.startsWith("--")) {
      const flagName = token.includes("=")
        ? token.slice(0, token.indexOf("="))
        : token;
      if (!surface.flags.has(flagName)) {
        const hint = suggestBunRunFlag(flagName, surface);
        throw new Error(
          `dx run: unknown Bun run flag "${flagName}"${hint ? ` (did you mean ${hint}?)` : ""}. Run './bin/dx run --help' to inspect live 'bun run --help' flags.`,
        );
      }
      explicitBunFlags.push(token);
      if (
        !token.includes("=") &&
        VALUE_BEARING_LONG_BUN_FLAGS.has(flagName) &&
        combined[i + 1] !== undefined &&
        !combined[i + 1]!.startsWith("-")
      ) {
        explicitBunFlags.push(combined[i + 1]!);
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-") && token.length === 2) {
      if (SHORT_BUN_SWITCH_FLAGS.has(token)) {
        explicitBunFlags.push(token);
        continue;
      }
      if (SHORT_BUN_FLAGS_WITH_VALUE.has(token)) {
        const val = combined[i + 1];
        if (val === undefined) {
          throw new Error(`dx run: short Bun flag "${token}" requires a value`);
        }
        explicitBunFlags.push(token, val);
        i += 1;
        continue;
      }
      throw new Error(
        `dx run: unknown short flag "${token}". Run './bin/dx run --help' for supported flags.`,
      );
    }

    target = token;
  }

  if (target === null || target.trim() === "") {
    throw new Error(
      "dx run: missing <script|file> target. Usage: ./bin/dx run [presets|bun-flags] <script|file> [args...]",
    );
  }

  const bunFlags: string[] = [];
  const hasExplicit = (prefix: string): boolean =>
    explicitBunFlags.some((f) => f === prefix || f.startsWith(`${prefix}=`));

  if (containment) {
    if (!hasExplicit("--no-orphans")) bunFlags.push("--no-orphans");
    if (!hasExplicit("--unhandled-rejections")) {
      bunFlags.push("--unhandled-rejections=strict");
    }
    if (!hasExplicit("--title")) {
      const cleanName = basename(target).replace(/[^a-zA-Z0-9:._-]/g, "_");
      bunFlags.push(`--title=dx:${cleanName}`);
    }
  }

  if (isolatedEnv && !hasExplicit("--no-env-file")) {
    bunFlags.push("--no-env-file");
  }
  if (lowMem && !hasExplicit("--smol")) {
    bunFlags.push("--smol");
  }
  if (watchSafe) {
    if (!hasExplicit("--watch")) bunFlags.push("--watch");
    if (!hasExplicit("--no-clear-screen")) bunFlags.push("--no-clear-screen");
    if (!hasExplicit("--no-orphans")) bunFlags.push("--no-orphans");
    if (!hasExplicit("--watch-kill-signal")) {
      bunFlags.push("--watch-kill-signal=SIGTERM");
    }
  }
  if (debugAddr !== null && !hasExplicit("--inspect-wait")) {
    bunFlags.push(`--inspect-wait=${debugAddr}`);
  }
  if (debugBrkAddr !== null && !hasExplicit("--inspect-brk")) {
    bunFlags.push(`--inspect-brk=${debugBrkAddr}`);
  }

  const stamp = options.stamp ?? `${Date.now()}`;
  const slug = basename(target).replace(/[^a-zA-Z0-9_-]/g, "_");
  let cpuProfilePath: string | null = null;
  let heapProfilePath: string | null = null;

  if (profileCpu) {
    const cpuName = `dx_${slug}_${stamp}.cpuprofile.md`;
    cpuProfilePath = join(profileDir, cpuName);
    bunFlags.push(
      "--cpu-prof-md",
      `--cpu-prof-dir=${profileDir}`,
      `--cpu-prof-name=${cpuName}`,
    );
  }
  if (profileHeap) {
    const heapName = `dx_${slug}_${stamp}.heapprofile.md`;
    heapProfilePath = join(profileDir, heapName);
    bunFlags.push(
      "--heap-prof-md",
      `--heap-prof-dir=${profileDir}`,
      `--heap-prof-name=${heapName}`,
    );
  }

  bunFlags.push(...explicitBunFlags);

  const cmd = [bunPath, ...bunFlags, "run", target, ...targetArgs];
  return {
    cmd,
    target,
    targetArgs,
    bunFlags,
    cpuProfilePath,
    heapProfilePath,
    timeoutMs,
    dryRun,
    json,
  };
}

const DX_RUN_HELP_HEADER = `dx run — Controlled & Monitored Bun Runner (connected to live \`bun run --help\`)

Usage:
  ./bin/dx run [dx-presets | bun-run-flags] <script|file> [script-args...]
  DX_BUN_FLAGS="--smol --cpu-prof-md --cpu-prof-dir=scratch/profiles" ./bin/dx <command>

DX Control & Monitoring Presets:
  --containment          Default ON: injects --no-orphans, --unhandled-rejections=strict, --title=dx:<target>
  --no-containment       Disable automatic containment flags
  --isolated-env         Inject --no-env-file (prevents .env 1Password FIFO blocks on daemons/cron)
  --profile-cpu          Inject --cpu-prof-md into scratch/profiles/ and print top hot functions on exit
  --profile-heap         Inject --heap-prof-md into scratch/profiles/ and print top retained types on exit
  --profile              Enable both --profile-cpu and --profile-heap
  --profile-dir=<dir>    Directory for CPU/heap markdown profiles (default: scratch/profiles)
  --low-mem              Inject --smol (lower RSS footprint, more frequent GC)
  --watch-safe           Inject --watch --no-clear-screen --no-orphans --watch-kill-signal=SIGTERM
  --debug[=<host:port>]  Inject --inspect-wait (default: 127.0.0.1:6499)
  --debug-brk[=<addr>]   Inject --inspect-brk (default: 127.0.0.1:6499)
  --timeout-ms=<ms>      Terminate child with SIGTERM after <ms> (exits 124 on timeout)
  --dry-run [--json]     Print the resolved Bun argv without executing

Examples:
  ./bin/dx run --profile-cpu scripts/market_edge_dashboard.ts -- --min-wagers=25
  ./bin/dx run --isolated-env --low-mem live:stream-signals
  ./bin/dx run --parallel --no-exit-on-error "schema:*"
  ./bin/dx run --dry-run --profile scripts/shadow_price.ts
`;

export interface MonitoredBunProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKiB: number;
  readonly cpuPct: number;
  readonly elapsed: string;
  readonly title: string | null;
  readonly noOrphans: boolean;
  readonly command: string;
}

export function parsePsBunProcesses(
  psOutput: string,
  selfPid = process.pid,
): readonly MonitoredBunProcess[] {
  const rows: MonitoredBunProcess[] = [];
  for (const rawLine of psOutput.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = line.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)\s+(.+)$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKiB = Number(match[3]);
    const cpuPct = Number(match[4]);
    const elapsed = match[5]!;
    const command = match[6]!;
    if (pid === selfPid) continue;
    const exe = command.split(/\s+/)[0] ?? "";
    const exeBase = basename(exe);
    const isBunExecutable =
      exeBase === "bun" ||
      exeBase === "bunx" ||
      exe.startsWith("dx:") ||
      (exeBase !== "zsh" &&
        exeBase !== "bash" &&
        exeBase !== "sh" &&
        command.includes("--cron-title"));
    if (!isBunExecutable) {
      continue;
    }
    const titleMatch =
      command.match(/--(?:cron-)?title(?:=|\s+)([^\s]+)/) ??
      (command.startsWith("dx:") ? [command, command.split(/\s+/)[0]!] : null);
    rows.push({
      pid,
      ppid,
      rssKiB,
      cpuPct,
      elapsed,
      title: titleMatch?.[1] ?? null,
      noOrphans: command.includes("--no-orphans"),
      command,
    });
  }
  return rows;
}

export interface MonitorSnapshot {
  readonly measuredAt: string;
  readonly bunVersion: string;
  readonly processes: readonly MonitoredBunProcess[];
  readonly daemon: {
    readonly url: string;
    readonly probed: boolean;
    readonly healthOk: boolean | null;
    readonly healthStatus: number | null;
    readonly liveBetsV2: {
      readonly status: number;
      readonly dataSource: string | null;
      readonly fallbackUsed: boolean | null;
      readonly pendingCount: number | null;
      readonly hash: string | null;
      readonly warnings: readonly string[];
    } | null;
    readonly note: string;
  };
  readonly profiles: {
    readonly dir: string;
    readonly count: number;
    readonly latestCpuFile: string | null;
    readonly latestHeapFile: string | null;
    readonly latestCpuHotspots: string | null;
    readonly latestHeapRetained: string | null;
    readonly pruned: PruneResult | null;
  };
}

export async function collectMonitorSnapshot(options: {
  readonly daemonUrl: string;
  readonly offline: boolean;
  readonly profileDir: string;
  readonly prune: boolean;
  readonly maxFiles: number;
}): Promise<MonitorSnapshot> {
  const measuredAt = new Date().toISOString();
  const psRes = Bun.spawnSync(
    ["ps", "-axo", "pid=,ppid=,rss=,%cpu=,etime=,command="],
    { stdout: "pipe", stderr: "pipe" },
  );
  const processes =
    psRes.exitCode === 0 ? parsePsBunProcesses(psRes.stdout.toString()) : [];

  let daemon: MonitorSnapshot["daemon"];
  if (options.offline) {
    daemon = {
      url: options.daemonUrl,
      probed: false,
      healthOk: null,
      healthStatus: null,
      liveBetsV2: null,
      note: "not probed (--offline or DX_STATUS_OFFLINE=1)",
    };
  } else {
    const base = options.daemonUrl.replace(/\/+$/, "");
    let healthOk = false;
    let healthStatus: number | null = null;
    let note = "unreachable";
    let liveBetsV2: MonitorSnapshot["daemon"]["liveBetsV2"] = null;
    try {
      const healthRes = await fetch(`${base}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(1500),
      });
      healthStatus = healthRes.status;
      healthOk = healthRes.ok;
      note = `HTTP ${healthRes.status}`;

      const lbRes = await fetch(
        `${base}/api/v2/live-bets?source=file&fallback=strict`,
        {
          method: "GET",
          signal: AbortSignal.timeout(1500),
        },
      );
      if (lbRes.ok) {
        const body = (await lbRes.json()) as Partial<LiveBetsV2Response>;
        liveBetsV2 = {
          status: lbRes.status,
          dataSource:
            typeof body.dataSource === "string" ? body.dataSource : null,
          fallbackUsed:
            typeof body.fallbackUsed === "boolean" ? body.fallbackUsed : null,
          pendingCount:
            typeof body.pendingCount === "number" ? body.pendingCount : null,
          hash: body.provenance?.hash ?? null,
          warnings: Array.isArray(body.warnings) ? body.warnings : [],
        };
      } else {
        liveBetsV2 = {
          status: lbRes.status,
          dataSource: null,
          fallbackUsed: null,
          pendingCount: null,
          hash: null,
          warnings: [`HTTP ${lbRes.status}`],
        };
      }
    } catch (err) {
      note = `unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
    daemon = {
      url: base,
      probed: true,
      healthOk,
      healthStatus,
      liveBetsV2,
      note,
    };
  }

  const absProfileDir = resolve(REPO_ROOT, options.profileDir);
  const pruned = options.prune
    ? await pruneDiagnosticArtifacts({
        profileDir: absProfileDir,
        maxFiles: options.maxFiles,
      })
    : null;

  let profileFiles: { name: string; fullPath: string; mtimeMs: number }[] = [];
  try {
    const entries = readdirSync(absProfileDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        entry.name.endsWith(".cpuprofile.md") ||
        entry.name.endsWith(".heapprofile.md") ||
        entry.name.startsWith("CPU.") ||
        entry.name.startsWith("Heap.")
      ) {
        const fullPath = join(absProfileDir, entry.name);
        const st = statSync(fullPath);
        profileFiles.push({ name: entry.name, fullPath, mtimeMs: st.mtimeMs });
      }
    }
    profileFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    // signal-honesty: intentional-absent-profile-dir
    profileFiles = [];
  }

  const latestCpu =
    profileFiles.find((f) => f.name.endsWith(".cpuprofile.md")) ?? null;
  const latestHeap =
    profileFiles.find((f) => f.name.endsWith(".heapprofile.md")) ?? null;
  const latestCpuHotspots = latestCpu
    ? ((await extractCpuHotspots(latestCpu.fullPath)) ?? null)
    : null;
  const latestHeapRetained = latestHeap
    ? ((await extractTopRetainedTypes(latestHeap.fullPath)) ?? null)
    : null;

  return {
    measuredAt,
    bunVersion: Bun.version,
    processes,
    daemon,
    profiles: {
      dir: options.profileDir,
      count: profileFiles.length,
      latestCpuFile: latestCpu?.name ?? null,
      latestHeapFile: latestHeap?.name ?? null,
      latestCpuHotspots,
      latestHeapRetained,
      pruned,
    },
  };
}

function renderMonitorHuman(snap: MonitorSnapshot): string {
  const lines: string[] = [
    `SportsDesk CLI Monitor (measured ${snap.measuredAt} · Bun ${snap.bunVersion})`,
    "================================================================================",
    `1. Active Bun Processes (${snap.processes.length} observed via ps):`,
  ];
  if (snap.processes.length === 0) {
    lines.push("   (none other than current probe)");
  } else {
    for (const p of snap.processes) {
      const rssMib = (p.rssKiB / 1024).toFixed(1);
      const orphanBadge = p.noOrphans ? "[--no-orphans]" : "[uncontained]";
      const titleBadge = p.title ? ` title=${p.title}` : "";
      lines.push(
        `   • pid=${p.pid} ppid=${p.ppid} rss=${rssMib}MiB cpu=${p.cpuPct.toFixed(1)}% up=${p.elapsed} ${orphanBadge}${titleBadge}`,
      );
      lines.push(`     ${p.command.slice(0, 110)}`);
    }
  }

  lines.push("");
  lines.push(`2. Daemon & /api/v2/live-bets (${snap.daemon.url}):`);
  if (!snap.daemon.probed) {
    lines.push(`   • Status       : ${snap.daemon.note}`);
  } else {
    lines.push(
      `   • /health      : ${snap.daemon.healthOk ? "OK" : "UNHEALTHY"} (${snap.daemon.note})`,
    );
    if (snap.daemon.liveBetsV2 !== null) {
      const lb = snap.daemon.liveBetsV2;
      lines.push(
        `   • /api/v2/live-bets : HTTP ${lb.status} · dataSource=${lb.dataSource ?? "n/a"} · fallbackUsed=${String(lb.fallbackUsed)} · pending=${lb.pendingCount ?? "n/a"} · hash=${lb.hash ? lb.hash.slice(0, 12) : "null"}`,
      );
      if (lb.warnings.length > 0) {
        lines.push(`   • Warnings     : ${lb.warnings.join(" | ")}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `3. Diagnostic Profiles (${snap.profiles.dir} · ${snap.profiles.count} artifact(s)):`,
  );
  if (snap.profiles.pruned !== null) {
    lines.push(
      `   • Prune Sweep  : examined=${snap.profiles.pruned.examined}, pruned=${snap.profiles.pruned.pruned}, retained=${snap.profiles.pruned.retained}`,
    );
  }
  lines.push(
    `   • Latest CPU   : ${snap.profiles.latestCpuFile ?? "(none — record with './bin/dx run --profile-cpu <script>')"}`,
  );
  if (snap.profiles.latestCpuHotspots) {
    for (const row of snap.profiles.latestCpuHotspots.split("\n")) {
      lines.push(`       ${row}`);
    }
  }
  lines.push(
    `   • Latest Heap  : ${snap.profiles.latestHeapFile ?? "(none — record with './bin/dx run --profile-heap <script>')"}`,
  );
  if (snap.profiles.latestHeapRetained) {
    for (const row of snap.profiles.latestHeapRetained.split("\n")) {
      lines.push(`       ${row}`);
    }
  }
  lines.push(
    "================================================================================",
  );
  return lines.join("\n");
}

function renderLiveBetsHuman(res: LiveBetsV2Response, via: string): string {
  const lines: string[] = [
    `SportsDesk Live Bets v${res.apiVersion} (${via} · generated ${res.provenance.generatedAt})`,
    "================================================================================",
    `  • dataSource     : ${res.dataSource} (fallbackUsed=${String(res.fallbackUsed)})`,
    `  • provenance     : path=${res.provenance.path ?? "null"} · sha256=${res.provenance.hash ?? "null"}`,
    `  • pendingCount   : ${res.pendingCount} (${res.summary.totalGames} game(s))`,
    `  • exposure       : wagered=${(res.summary.totalWagered / 100).toFixed(2)} USD (${res.summary.totalWagered}¢) · toWin=${(res.summary.totalToWin / 100).toFixed(2)} USD (${res.summary.totalToWin}¢)`,
    `  • agents         : hierarchyLoaded=${String(res.agents.hierarchyLoaded)} · resolved=${res.agents.agents.length} · unresolved=${res.agents.unresolved.length} · maxLevel=${res.agents.maxLevel ?? "null"}`,
    `  • scoreboard     : ${res.scoreboard ? `${res.scoreboard.summary.games} board game(s) (${res.scoreboard.source})` : "null"}`,
    `  • categories     : ${res.sports.categories.map((c) => `${c.category}=${c.games} (live=${c.live})`).join(", ") || "(none)"}`,
  ];
  if (res.warnings.length > 0) {
    lines.push(`  • warnings       : ${res.warnings.join(" | ")}`);
  }
  lines.push(
    "================================================================================",
  );
  return lines.join("\n");
}

async function handleHelpCommand(argv: readonly string[]): Promise<number> {
  const surface = readBunRunCliSurface();
  let full = false;
  let raw = false;
  let category: BunRunFlagCategory | undefined;
  let filter: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--connected-footer") {
      continue;
    }
    if (
      arg === "--bun" ||
      arg === "--bun-help" ||
      arg === "--bun-run" ||
      arg === "--full" ||
      arg === "bun"
    ) {
      full = true;
      continue;
    }
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--control") {
      category = "control";
      full = true;
      continue;
    }
    if (arg === "--monitor") {
      category = "monitor";
      full = true;
      continue;
    }
    if (arg.startsWith("--category=")) {
      const val = arg.slice("--category=".length) as BunRunFlagCategory;
      if (!(BUN_RUN_FLAG_CATEGORIES as readonly string[]).includes(val)) {
        console.error(
          `dx help: invalid --category="${val}"; expected one of ${BUN_RUN_FLAG_CATEGORIES.join(", ")}`,
        );
        return 2;
      }
      category = val;
      full = true;
      continue;
    }
    if (arg.startsWith("--filter=")) {
      filter = arg.slice("--filter=".length);
      full = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      filter = arg;
      full = true;
      continue;
    }
    console.error(
      `dx help: unknown option "${arg}". Usage: ./bin/dx help [--bun] [--category=control|monitor|workspace|environment|network|transpiler] [--filter=TEXT] [--raw]`,
    );
    return 2;
  }

  console.log(
    formatConnectedBunRunHelp(surface, {
      full,
      raw,
      category,
      filter,
    }),
  );
  return 0;
}

async function handleRunCommand(argv: readonly string[]): Promise<number> {
  const surface = readBunRunCliSurface();
  if (
    argv.length === 0 ||
    argv[0] === "-h" ||
    argv[0] === "--help" ||
    argv[0] === "help"
  ) {
    console.log(DX_RUN_HELP_HEADER);
    console.log(formatConnectedBunRunHelp(surface, { full: true }));
    return 0;
  }

  let plan: ResolvedDxRunPlan;
  try {
    plan = buildDxRunPlan(argv, surface, {
      envFlags: Bun.env.DX_BUN_FLAGS,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (plan.dryRun) {
    if (plan.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(plan.cmd.join(" "));
    }
    return 0;
  }

  const safety = checkVerboseFetchSecretSafety(Bun.env);
  if (safety.blocked) {
    console.error(`dx run: refused — ${safety.reason}`);
    return 2;
  }

  if (plan.cpuProfilePath !== null) {
    mkdirSync(resolve(REPO_ROOT, plan.cpuProfilePath, ".."), {
      recursive: true,
    });
  }
  if (plan.heapProfilePath !== null) {
    mkdirSync(resolve(REPO_ROOT, plan.heapProfilePath, ".."), {
      recursive: true,
    });
  }

  const proc = Bun.spawn([...plan.cmd], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (plan.timeoutMs !== null) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, plan.timeoutMs);
  }

  const exitCode = await proc.exited;
  if (timer !== null) clearTimeout(timer);

  if (plan.cpuProfilePath !== null) {
    const absCpu = resolve(REPO_ROOT, plan.cpuProfilePath);
    const hotspots = await extractCpuHotspots(absCpu);
    console.error(`[dx run] CPU profile written: ${plan.cpuProfilePath}`);
    if (hotspots) {
      console.error(hotspots);
    }
  }
  if (plan.heapProfilePath !== null) {
    const absHeap = resolve(REPO_ROOT, plan.heapProfilePath);
    const retained = await extractTopRetainedTypes(absHeap);
    console.error(`[dx run] Heap profile written: ${plan.heapProfilePath}`);
    if (retained) {
      console.error(retained);
    }
  }

  if (timedOut) {
    console.error(
      `[dx run] process timed out after ${plan.timeoutMs}ms (SIGTERM sent)`,
    );
    return 124;
  }
  return exitCode;
}

const DX_MONITOR_USAGE = `dx monitor — Monitor Bun processes, daemon /health + /api/v2/live-bets, and diagnostic profiles

Usage:
  ./bin/dx monitor [--url=<http://127.0.0.1:4020>] [--offline] [--watch] [--interval=<sec>] [--prune] [--max-files=<n>] [--profile-dir=<dir>] [--json]

Options:
  --url=<origin>       Daemon origin to probe (default: http://127.0.0.1:4020)
  --offline            Skip HTTP probes (also honored when DX_STATUS_OFFLINE=1)
  --watch              Continuously refresh telemetry until SIGINT/SIGTERM
  --interval=<sec>     Refresh cadence in seconds when --watch is active (default: 5)
  --prune              Prune old CPU/heap markdown profiles in --profile-dir
  --max-files=<n>      Maximum profile artifacts retained by --prune (default: 20)
  --profile-dir=<dir>  Profile artifact directory (default: scratch/profiles)
  --json               Emit machine-readable JSON snapshot
  -h, --help           Print this help text
`;

async function handleMonitorCommand(argv: readonly string[]): Promise<number> {
  let daemonUrl = "http://127.0.0.1:4020";
  let offline = Bun.env.DX_STATUS_OFFLINE === "1";
  let watch = false;
  let intervalSec = 5;
  let prune = false;
  let maxFiles = 20;
  let profileDir = "scratch/profiles";
  let json = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help" || arg === "help") {
      console.log(DX_MONITOR_USAGE.trimEnd());
      return 0;
    }
    if (arg === "--offline") {
      offline = true;
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg === "--prune") {
      prune = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--url=")) {
      daemonUrl = arg.slice("--url=".length);
      continue;
    }
    if (arg.startsWith("--interval=")) {
      const n = Number(arg.slice("--interval=".length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error("dx monitor: --interval must be a positive number");
        return 2;
      }
      intervalSec = n;
      continue;
    }
    if (arg.startsWith("--max-files=")) {
      const n = Number(arg.slice("--max-files=".length));
      if (!Number.isInteger(n) || n < 0) {
        console.error("dx monitor: --max-files must be a non-negative integer");
        return 2;
      }
      maxFiles = n;
      continue;
    }
    if (arg.startsWith("--profile-dir=")) {
      profileDir = arg.slice("--profile-dir=".length);
      continue;
    }
    console.error(
      `dx monitor: unknown option "${arg}". Run './bin/dx monitor --help'.`,
    );
    return 2;
  }

  let stopRequested = false;
  const onStop = () => {
    stopRequested = true;
  };
  if (watch) {
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);
  }

  do {
    const snap = await collectMonitorSnapshot({
      daemonUrl,
      offline,
      profileDir,
      prune,
      maxFiles,
    });
    prune = false; // only prune on initial tick in --watch mode
    if (json) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(renderMonitorHuman(snap));
    }
    if (!watch || stopRequested) break;
    await Bun.sleep(intervalSec * 1000);
  } while (!stopRequested);

  return 0;
}

const DX_LIVE_BETS_USAGE = `dx live-bets — Control & Monitor v2 Live Bets (explicit source/fallback contract)

Usage:
  ./bin/dx live-bets [--source=db|file|fixture|none] [--fallback=strict|sample] [--path=<file>] [--daemon[=<url>]] [--watch] [--interval=<sec>] [--json]

Options:
  --source=<kind>      Explicit source: db | file | fixture | none (default: file; "auto" is rejected)
  --fallback=<mode>    Fallback policy: strict | sample (default: strict)
  --path=<path>        Snapshot or fixture path relative to repo root (for file/fixture)
  --daemon[=<origin>]  Query HTTP GET <origin>/api/v2/live-bets instead of in-process resolveLiveBets
                       (default origin when flag has no value: http://127.0.0.1:4020)
  --watch              Poll continuously at --interval seconds until SIGINT/SIGTERM
  --interval=<sec>     Poll cadence in seconds when --watch is active (default: 5)
  --json               Emit the full LiveBetsV2Response JSON payload
  -h, --help           Print this help text

Examples:
  ./bin/dx live-bets --source=file --fallback=strict
  ./bin/dx live-bets --source=fixture --fallback=sample --path=tests/f402-pending-wager-sample.json
  ./bin/dx live-bets --daemon --source=db --fallback=strict --json
`;

async function handleLiveBetsCommand(argv: readonly string[]): Promise<number> {
  let rawSource = "file";
  let rawFallback = "strict";
  let targetPath: string | undefined;
  let daemonOrigin: string | null = null;
  let watch = false;
  let intervalSec = 5;
  let json = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help" || arg === "help") {
      console.log(DX_LIVE_BETS_USAGE.trimEnd());
      return 0;
    }
    if (arg.startsWith("--source=")) {
      rawSource = arg.slice("--source=".length).trim();
      continue;
    }
    if (arg.startsWith("--fallback=")) {
      rawFallback = arg.slice("--fallback=".length).trim();
      continue;
    }
    if (arg.startsWith("--path=")) {
      targetPath = arg.slice("--path=".length).trim();
      continue;
    }
    if (arg === "--daemon") {
      daemonOrigin = "http://127.0.0.1:4020";
      continue;
    }
    if (arg.startsWith("--daemon=")) {
      daemonOrigin =
        arg.slice("--daemon=".length).trim() || "http://127.0.0.1:4020";
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg.startsWith("--interval=")) {
      const n = Number(arg.slice("--interval=".length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error("dx live-bets: --interval must be a positive number");
        return 2;
      }
      intervalSec = n;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    console.error(
      `dx live-bets: unknown option "${arg}". Run './bin/dx live-bets --help'.`,
    );
    return 2;
  }

  if (!isLiveBetsSource(rawSource)) {
    console.error(
      `dx live-bets: invalid --source="${rawSource}" (expected db, file, fixture, or none; "auto" is not permitted in v2)`,
    );
    return 2;
  }
  if (!isLiveBetsFallback(rawFallback)) {
    console.error(
      `dx live-bets: invalid --fallback="${rawFallback}" (expected strict or sample)`,
    );
    return 2;
  }

  const source: LiveBetsSource = rawSource;
  const fallback: LiveBetsFallback = rawFallback;

  let stopRequested = false;
  const onStop = () => {
    stopRequested = true;
  };
  if (watch) {
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);
  }

  do {
    let response: LiveBetsV2Response;
    let via: string;
    if (daemonOrigin !== null) {
      const base = daemonOrigin.replace(/\/+$/, "");
      const params = new URLSearchParams({
        source,
        fallback,
        ...(targetPath === undefined ? {} : { path: targetPath }),
      });
      const url = `${base}/api/v2/live-bets?${params.toString()}`;
      via = `daemon ${url}`;
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error(
            `dx live-bets: ${url} returned HTTP ${res.status}: ${errText.slice(0, 240)}`,
          );
          return 1;
        }
        response = (await res.json()) as LiveBetsV2Response;
      } catch (err) {
        console.error(
          `dx live-bets: failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    } else {
      via = "in-process resolveLiveBets";
      response = await resolveLiveBets(
        {
          source,
          fallback,
          ...(targetPath === undefined ? {} : { path: targetPath }),
        },
        { repoRoot: REPO_ROOT },
      );
    }

    if (json) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.log(renderLiveBetsHuman(response, via));
    }

    if (!watch || stopRequested) break;
    await Bun.sleep(intervalSec * 1000);
  } while (!stopRequested);

  return 0;
}

export async function runDxControlCli(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
  const mode = argv[0] ?? "help";
  const rest = argv.slice(1);
  switch (mode) {
    case "help":
      return handleHelpCommand(rest);
    case "run":
      return handleRunCommand(rest);
    case "monitor":
      return handleMonitorCommand(rest);
    case "live-bets":
      return handleLiveBetsCommand(rest);
    case "check-env": {
      const check = checkVerboseFetchSecretSafety(Bun.env);
      if (check.blocked) {
        console.error(`dx: refused — ${check.reason}`);
        return 2;
      }
      return 0;
    }
    default:
      console.error(
        `dx_run_control: unknown mode "${mode}" (expected help, run, monitor, live-bets, or check-env)`,
      );
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await runDxControlCli());
}
