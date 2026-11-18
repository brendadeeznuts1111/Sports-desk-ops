import { expect, test } from "bun:test";
import { auditInventory, type Inventory } from "../scripts/cloudflare/edge_audit.ts";

const zone = { id: "zone1", name: "example.com" };
const tunnelId = "11111111-1111-1111-1111-111111111111";
function fixture(): Inventory {
  return {
    zones: [zone],
    dns: {
      [zone.id]: [
        {
          name: "portal.example.com",
          type: "CNAME",
          content: `${tunnelId}.cfargotunnel.com`,
        },
        {
          name: "api.example.com",
          type: "CNAME",
          content: "missing.example-account.workers.dev",
        },
        { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1" },
      ],
    },
    tunnels: [{ id: tunnelId, name: "remote", status: "down" }],
    ingress: {
      [tunnelId]: [
        { hostname: "other.example.com", service: "http://127.0.0.1:4020" },
        { service: "http_status:404" },
      ],
    },
    scripts: ["live-worker"],
    workerSubdomain: "example-account",
    routes: {
      [zone.id]: [
        { pattern: "unregistered.example.com/*", script: "live-worker" },
      ],
    },
  };
}

test("reports broken tunnel health, missing ingress, absent Worker and route DNS", () => {
  const findings = auditInventory(fixture());
  expect(findings.map((f) => f.code).sort()).toEqual(
    ["INGRESS_MISSING", "ROUTE_DNS_MISSING", "TUNNEL_UNHEALTHY", "WORKER_UNKNOWN"].sort(),
  );
  expect(findings.find((f) => f.code === "WORKER_UNKNOWN")?.hostname).toBe(
    "api.example.com",
  );
});

test("healthy tunnel ingress and matching resources produce no findings", () => {
  const f = fixture();
  f.tunnels[0]!.status = "healthy";
  f.ingress[tunnelId] = [
    { hostname: "portal.example.com", service: "http://127.0.0.1:4020" },
    { service: "http_status:404" },
  ];
  f.scripts.push("missing");
  f.dns[zone.id]!.push({
    name: "unregistered.example.com",
    type: "A",
    content: "192.0.2.1",
  });
  expect(auditInventory(f)).toEqual([]);
});

test("fails closed on missing Tunnel config instead of treating it as healthy", () => {
  const f = fixture();
  f.tunnels[0]!.status = "healthy";
  f.ingress = {};
  expect(auditInventory(f).some((x) => x.code === "INGRESS_MISSING")).toBe(
    true,
  );
});
