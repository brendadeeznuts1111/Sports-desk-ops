import { describe, expect, test } from "bun:test";
import {
  parseCustomerProfileXml,
  customerRowFromXml,
} from "../lib/customer_profile.ts";

describe("parseCustomerProfileXml", () => {
  test("parses a customer profile document", () => {
    const xml = `<profile id="C1"><name>Alice</name><ticket risk="10" result="W"/></profile>`;
    const out = parseCustomerProfileXml(xml) as {
      profile: { "@id": string; name: string };
    };
    expect(out.profile["@id"]).toBe("C1");
    expect(out.profile.name).toBe("Alice");
  });

  test("throws on malformed XML", () => {
    expect(() => parseCustomerProfileXml("<unclosed")).toThrow();
  });

  test("customerRowFromXml maps fields", () => {
    const xml = `<profile id="C1"><agent_id>A1</agent_id><status>active</status><lifetime_net_usd>42</lifetime_net_usd></profile>`;
    const row = customerRowFromXml(xml);
    expect(row.customer_id).toBe("C1");
    expect(row.agent_id).toBe("A1");
    expect(row.status).toBe("active");
    expect(row.lifetime_net_usd).toBe(42);
  });
});
