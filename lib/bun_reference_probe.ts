/**
 * @file lib/bun_reference_probe.ts
 * @description Evidence about `bun:bundle` on the pinned runtime.
 *
 * A static **named** import is substituted at parse time; a namespace import is erased (its binding
 * is undefined and referencing it throws), and a dynamic import cannot resolve the virtual module.
 * The flag branch is the observable proof that the substitution happened. Executed only as a child
 * process by lib/bun_reference_audit.ts (a compile-time module cannot be inspected in-process).
 */
import * as bundleNamespace from "bun:bundle";
import { feature } from "bun:bundle";

/** Rewritten at parse time, so this is a literal branch in the emitted code. */
export const featureFlagTakesTheOnBranch = feature("TEST") ? "on" : "off";

/** Observation only: the binding is not a callable runtime value. */
export const featureBindingType = typeof feature;

/** A namespace import of the virtual module is erased, not linked. */
export const namespaceImportBinding = (() => {
  try {
    return typeof bundleNamespace;
  } catch (error) {
    return `throws:${(error as Error).name}`;
  }
})();

/** A dynamic import cannot resolve the virtual module. */
export const dynamicImportBehavior = await import("bun:bundle").then(
  (module) => `resolves:${Object.keys(module).join(",")}`,
  (error: Error) => `rejects:${error.message.slice(0, 80)}`,
);
