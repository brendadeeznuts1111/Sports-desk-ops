// Node-parity pin for `util.types.isModuleNamespaceObject`.
//
// Nothing imports `node:util/types` yet, so this test is the contract a future
// loader may depend on: an API that accepts "a module or an inline object" can
// guard with this predicate. The forged-tag case is the reason to use it rather
// than `Object.prototype.toString`, which any object can spoof.
import { describe, expect, test } from "bun:test";
import { types } from "node:util";

describe("util.types.isModuleNamespaceObject", () => {
  test("a real namespace object is recognised", async () => {
    const nodeUtil = await import("node:util");
    expect(types.isModuleNamespaceObject(nodeUtil)).toBe(true);
    // Real namespace objects are sealed and non-extensible in both runtimes.
    expect(Object.isSealed(nodeUtil)).toBe(true);
    expect(Object.isExtensible(nodeUtil)).toBe(false);
    expect(Object.prototype.toString.call(nodeUtil)).toBe("[object Module]");
    // MEASURED DIVERGENCE: Node 26 returns `null` for the prototype of a module
    // namespace object; Bun 1.4.4 returns a null-prototype object whose own
    // prototype is null. Pinned as Bun's actual shape, not as Node's docs say.
    const proto = Object.getPrototypeOf(nodeUtil) as object | null;
    expect(proto).not.toBeNull();
    expect(Object.getPrototypeOf(proto as object)).toBeNull();
  });

  test("a local module's namespace is recognised too", async () => {
    const brand = await import("../lib/brand.ts");
    expect(types.isModuleNamespaceObject(brand)).toBe(true);
  });

  test("plain values are not namespace objects", async () => {
    expect(types.isModuleNamespaceObject({ a: 1 })).toBe(false);
    expect(types.isModuleNamespaceObject([])).toBe(false);
    expect(types.isModuleNamespaceObject(function f() {})).toBe(false);
    expect(types.isModuleNamespaceObject(null)).toBe(false);
    expect(types.isModuleNamespaceObject(42)).toBe(false);
    // `(await import(...)).default` is the VALUE, not a namespace.
    const mod = await import("node:util");
    expect(
      types.isModuleNamespaceObject(
        (mod as { default?: unknown }).default ?? null,
      ),
    ).toBe(false);
  });

  test("a forged Symbol.toStringTag does not pass the check", () => {
    const forged = { [Symbol.toStringTag]: "Module", a: 1 };
    expect(Object.prototype.toString.call(forged)).toBe("[object Module]");
    expect(types.isModuleNamespaceObject(forged)).toBe(false);
  });
});
