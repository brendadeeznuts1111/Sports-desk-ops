import { describe, expect, test } from "bun:test";
import {
  E_DOC_SNAPSHOT_ENTITY_INVENTORY,
  deriveAmbientDtsKindNumbersFromProject,
} from "../bin/bun_types.ts";

describe("deriveAmbientDtsKindNumbers", () => {
  test("derives Bun namespace category counts from @types/bun AST", async () => {
    const inventory = await deriveAmbientDtsKindNumbersFromProject();
    expect(inventory.error).toBeNull();
    expect(inventory.doc).toBe(E_DOC_SNAPSHOT_ENTITY_INVENTORY);
    // Locked to the active `@types/bun` AST (Bun 1.4.4 today), not bun.com HTML totals.
    expect(inventory).toMatchObject({
      functions: 51,
      classes: 25,
      interfaces: 125,
      types: 93,
      variables: 23,
      namespaces: 20,
    });
    expect(inventory.total).toBe(
      inventory.functions +
        inventory.classes +
        inventory.interfaces +
        inventory.types +
        inventory.variables +
        inventory.namespaces,
    );
    expect(inventory.namespaces).toBeGreaterThanOrEqual(7);
  });
});
