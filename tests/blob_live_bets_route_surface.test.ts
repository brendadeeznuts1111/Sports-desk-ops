import { describe, expect, test } from "bun:test";

import { BLOB_LIVE_BETS_ROUTES } from "../services/blob_and_live_bets_server.ts";

interface OpenApiSpec {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const spec = (await Bun.file("docs/openapi.json").json()) as OpenApiSpec;

function operationFor(
  path: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathItem = spec.paths[path];
  if (pathItem === undefined) return undefined;
  const operation = pathItem[method.toLowerCase()];
  return operation !== undefined &&
    operation !== null &&
    typeof operation === "object"
    ? (operation as Record<string, unknown>)
    : undefined;
}

describe("blob/live-bets route surface vs docs/openapi.json", () => {
  test("every served gateway route is published as a tier B operation", () => {
    for (const route of BLOB_LIVE_BETS_ROUTES) {
      const operation = operationFor(route.path, route.method);
      expect(operation).toBeDefined();
      if (route.path === "/health") continue; // shared with the daemon
      expect(operation?.["x-evidence"]).toMatchObject({ tier: "B" });
    }
  });

  test("the published methods on gateway paths are exactly the served table", () => {
    const gatewaySpec = new Set<string>();
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (path === "/health") continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (
          operation !== null &&
          typeof operation === "object" &&
          (operation as Record<string, unknown>)["x-evidence"] !== null &&
          typeof (operation as Record<string, unknown>)["x-evidence"] ===
            "object" &&
          (
            (operation as Record<string, unknown>)["x-evidence"] as Record<
              string,
              unknown
            >
          ).tier === "B" &&
          BLOB_LIVE_BETS_ROUTES.some(
            (route) =>
              route.path === path && route.method === method.toUpperCase(),
          )
        ) {
          gatewaySpec.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    const served = new Set(
      BLOB_LIVE_BETS_ROUTES.filter((route) => route.path !== "/health").map(
        (route) => `${route.method} ${route.path}`,
      ),
    );
    expect([...gatewaySpec].sort()).toEqual([...served].sort());
  });

  test("the blobs path publishes both methods and the key parameter", () => {
    const get = operationFor("/api/v1/blobs/{key}", "GET");
    const put = operationFor("/api/v1/blobs/{key}", "PUT");
    expect(get).toBeDefined();
    expect(put).toBeDefined();
    const parameters = (path: Record<string, unknown> | undefined) =>
      Array.isArray(path?.parameters) ? path.parameters : [];
    expect(parameters(get)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "key", in: "path", required: true }),
      ]),
    );
  });
});
