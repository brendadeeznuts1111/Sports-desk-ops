import { describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";

import {
  agentGraphArtifactPathsFromJsonOut,
  atomicWrite,
  isAgentGraphBuildFresh,
  isAgentGraphWebpFreshForManifest,
  writeAgentGraphBuildManifest,
  type AgentGraphBuildManifest,
} from "./f402_agent_graph_artifacts.ts";
import { sha256Hex } from "./f402_hierarchy_hash.ts";

const TMP = join(import.meta.dir, ".tmp-artifacts");

describe("f402_agent_graph_artifacts", () => {
  test("isAgentGraphBuildFresh compares envelope sha256 to manifest", async () => {
    const root = join(TMP, "build-fresh");
    const json = join(root, "agent-graph.json");
    const paths = agentGraphArtifactPathsFromJsonOut(json);
    const hash = await sha256Hex("envelope-v1");
    const manifest: AgentGraphBuildManifest = {
      version: 1,
      envelopePath: "/x.json",
      envelopeSha256: hash,
      envelopeGeneralRows: 10,
      ingestedRowCount: 9,
      skippedOverflowCount: 1,
      nodeCount: 9,
      edgeCount: 8,
      builtAt: new Date().toISOString(),
    };
    await atomicWrite(paths.graphJson, "{}");
    await atomicWrite(paths.graphSvg, "<svg/>");
    await atomicWrite(paths.graphCaptureHtml, "<html/>");
    await writeAgentGraphBuildManifest(paths.manifest, manifest);

    expect(
      await isAgentGraphBuildFresh({
        manifestPath: paths.manifest,
        artifactPaths: paths,
        envelopeSha256: hash,
      }),
    ).toBe(true);
    expect(
      await isAgentGraphBuildFresh({
        manifestPath: paths.manifest,
        artifactPaths: paths,
        envelopeSha256: await sha256Hex("envelope-v2"),
      }),
    ).toBe(false);
  });

  test("isAgentGraphWebpFreshForManifest requires webpEnvelopeSha256 match", async () => {
    const root = join(TMP, "webp-fresh");
    const json = join(root, "agent-graph.json");
    const paths = agentGraphArtifactPathsFromJsonOut(json);
    const hash = await sha256Hex("env");
    await writeAgentGraphBuildManifest(paths.manifest, {
      version: 1,
      envelopePath: "/x",
      envelopeSha256: hash,
      envelopeGeneralRows: 1,
      ingestedRowCount: 1,
      skippedOverflowCount: 0,
      nodeCount: 1,
      edgeCount: 0,
      builtAt: new Date().toISOString(),
      webpEnvelopeSha256: hash,
      webpBuiltAt: new Date().toISOString(),
    });
    await atomicWrite(paths.graphJson, "{}");
    await atomicWrite(paths.graphWebp, "RIFF....");
    const t = Date.now() / 1000;
    await utimes(paths.graphJson, t - 10, t - 10);
    await utimes(paths.graphWebp, t, t);

    expect(
      await isAgentGraphWebpFreshForManifest(paths.manifest, paths.graphWebp),
    ).toBe(true);
  });
});
