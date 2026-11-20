/**
 * @file tests/runtime_preflight_isolated.ts
 * @description One bootstrap in a fresh process. The test file spawns this so
 * `sealGlobalBunS3()` cannot replace `Bun.s3` in the suite process.
 *
 * Not a `*.test.ts` file: `bun test` does not collect it.
 */

import {
  bootstrapSealedR2Client,
  PreflightError,
  type DnsCacheStatsSnapshot,
} from "../lib/runtime_preflight.ts";
import { SealedR2ManifestClient } from "../lib/sealed_r2_manifest_client.ts";

interface Scenario {
  readonly env: Record<string, string | undefined>;
  readonly bucket?: string;
  readonly allowAwsFallbackEnv?: boolean;
  readonly dns?: DnsCacheStatsSnapshot;
  readonly lockForeignS3?: boolean;
  readonly openS3?: boolean;
  readonly tlsCiphers?: string;
  readonly pinTlsCiphers?: boolean;
}

const raw = Bun.argv[2];
if (raw === undefined) {
  console.error("missing scenario JSON");
  process.exit(1);
}

const scenario = JSON.parse(raw) as Scenario;

if (scenario.lockForeignS3 === true) {
  Object.defineProperty(Bun, "s3", {
    value: Object.freeze({ locked: true }),
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

const hiddenInspect = {
  showHidden: true,
  depth: null,
} as unknown as NonNullable<Parameters<typeof Bun.inspect>[1]>;

try {
  const tlsSurface =
    scenario.tlsCiphers === undefined
      ? undefined
      : { DEFAULT_CIPHERS: scenario.tlsCiphers };
  const { report, client } = bootstrapSealedR2Client({
    env: scenario.env,
    ...(scenario.bucket === undefined ? {} : { bucket: scenario.bucket }),
    ...(scenario.allowAwsFallbackEnv === undefined
      ? {}
      : { allowAwsFallbackEnv: scenario.allowAwsFallbackEnv }),
    ...(scenario.dns === undefined
      ? {}
      : { getDnsCacheStats: () => scenario.dns as DnsCacheStatsSnapshot }),
    ...(tlsSurface === undefined ? {} : { tlsSurface }),
    ...(scenario.pinTlsCiphers === undefined
      ? {}
      : { pinTlsCiphers: scenario.pinTlsCiphers }),
  });
  const opened = scenario.openS3 === true ? client.s3Client() : null;
  console.log(
    JSON.stringify({
      status: "ok",
      sealedGlobalS3: report.sealedGlobalS3,
      errorRatioBps: report.dnsCache.errorRatioBps,
      bucket: client.bucket,
      endpointHost: client.endpointHost,
      frozenReport: Object.isFrozen(report),
      frozenClient: Object.isFrozen(client),
      clientIsSealed: client instanceof SealedR2ManifestClient,
      clientInspect: Bun.inspect(client, hiddenInspect),
      clientJson: JSON.stringify(client),
      reportJson: JSON.stringify(report),
      openedInspect:
        opened === null ? null : Bun.inspect(opened, hiddenInspect),
      openedJson: opened === null ? null : JSON.stringify(opened),
      activeCiphers:
        tlsSurface === undefined ? null : tlsSurface.DEFAULT_CIPHERS,
      tlsPinned: report.tlsCiphers.pinned,
      tls13Count: report.tlsCiphers.tls13Suites.length,
      aeadCount: report.tlsCiphers.aeadSuites.length,
      totalAllowedSuites: report.tlsCiphers.totalAllowedSuites,
    }),
  );
} catch (error) {
  if (error instanceof PreflightError) {
    console.log(
      JSON.stringify({
        status: "error",
        code: error.code,
        exitCode: error.exitCode,
      }),
    );
    process.exit(0);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
