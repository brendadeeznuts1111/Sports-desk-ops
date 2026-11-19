import { $ } from "bun";
import { parseArgs } from "node:util";

const usage =
  "bun run registry:probe <package> [--runs N | -n N] [--expect-host host[:port]] [--json]";
function safeUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Expected an HTTP(S) URL");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      runs: { type: "string", short: "n", default: "3" },
      "expect-host": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      usage +
        "\nChecks the tarball host advertised by bun info on every run. Latency includes Bun process startup and cache effects.",
    );
    return 0;
  }
  const pkg = positionals[0];
  const runs = Number(values.runs);
  if (
    positionals.length !== 1 ||
    !pkg ||
    pkg.startsWith("-") ||
    !Number.isSafeInteger(runs) ||
    runs < 1
  )
    throw new Error(usage);
  const expectedHost = values["expect-host"]?.trim().toLowerCase() ?? null;
  if (expectedHost === "") throw new Error("--expect-host requires a host");
  const env = process.env;
  const override = env.NPM_CONFIG_REGISTRY;
  const context = {
    pkg,
    profile:
      env.SPORTSDESK_PROFILE ??
      env.TERM_PROFILE ??
      env.ITERM_PROFILE ??
      env.WT_PROFILE_NAME ??
      "default",
    configPath: env.NPM_CONFIG_USERCONFIG ?? null,
    registryOverride: override ? safeUrl(override).origin : null,
    expectedHost,
  };
  const samples: {
    version: string;
    tarballUrl: string;
    tarballHost: string;
    elapsedMs: number;
  }[] = [];
  for (let attempt = 1; attempt <= runs; attempt++) {
    const start = performance.now();
    const result =
      await $`${process.execPath} info ${pkg} version dist.tarball --json`
        .nothrow()
        .quiet();
    const elapsedMs = performance.now() - start;
    try {
      if (result.exitCode !== 0) throw new Error("bun info failed");
      const metadata = result.json();
      if (
        typeof metadata?.version !== "string" ||
        !metadata.version ||
        typeof metadata["dist.tarball"] !== "string"
      )
        throw new Error("Missing version or dist.tarball");
      const url = safeUrl(metadata["dist.tarball"]);
      samples.push({
        version: metadata.version,
        tarballHost: url.host,
        tarballUrl: url.href,
        elapsedMs,
      });
    } catch {
      console.error(
        JSON.stringify({
          ...context,
          ok: false,
          attempt,
          elapsedMs,
          exitCode: result.exitCode,
          error: result.exitCode
            ? "bun info failed"
            : "Invalid registry metadata",
        }),
      );
      return 1;
    }
  }
  const samplesMs = samples.map((s) => s.elapsedMs);
  const sorted = samplesMs.toSorted((a, b) => a - b);
  const mid = Math.floor(runs / 2);
  const medianMs = (sorted[mid]! + sorted[Math.floor((runs - 1) / 2)]!) / 2;
  const hosts = [...new Set(samples.map((s) => s.tarballHost))];
  const ok =
    expectedHost === null || hosts.every((host) => host === expectedHost);
  const report = {
    ...context,
    ok,
    runs,
    samples,
    samplesMs,
    minMs: sorted[0],
    medianMs,
    maxMs: sorted.at(-1),
  };
  if (values.json || !process.stdout.isTTY)
    console.log(JSON.stringify(report, null, 2));
  else {
    const badge = ok ? "PASS" : "HOST MISMATCH";
    const label =
      env.NO_COLOR === undefined
        ? Bun.color(ok ? "#22c55e" : "#ef4444", "ansi") + badge + "\x1b[0m"
        : badge;
    console.log(
      `${label} [${context.profile}] ${pkg}\n  Tarball hosts: ${hosts.join(", ")}${expectedHost ? " (expected " + expectedHost + ")" : ""}\n  User config: ${context.configPath ?? "(default)"}\n  bun info elapsed (ms): min ${sorted[0]!.toFixed(2)}, median ${medianMs.toFixed(2)}, max ${sorted.at(-1)!.toFixed(2)} (${runs} runs)`,
    );
  }
  return ok ? 0 : 2;
}
try {
  process.exitCode = await main();
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      error: "Invalid arguments or registry configuration",
      usage,
    }),
  );
  process.exitCode = 1;
}
