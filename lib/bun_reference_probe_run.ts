/**
 * @file lib/bun_reference_probe_run.ts
 * @description Runner for bundle-probe.ts: prints the observations as JSON so the whole-tree audit
 * can compare a plain run with `--feature=TEST` and prove the substitution.
 */
import {
  dynamicImportBehavior,
  featureBindingType,
  featureFlagTakesTheOnBranch,
  namespaceImportBinding,
} from "./bun_reference_probe.ts";

console.log(
  JSON.stringify({
    featureFlagTakesTheOnBranch,
    featureBindingType,
    namespaceImportBinding,
    dynamicImportBehavior,
  }),
);
