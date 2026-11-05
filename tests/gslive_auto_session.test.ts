import { describe, expect, test } from "bun:test";

import {
  mintGsid,
  type GsliveCredentialReader,
} from "../lib/gslive_auto_session.ts";

const credentials: GsliveCredentialReader = {
  get: async (name) => (name === "GSLIVE_USERNAME" ? "user" : "pass"),
};

function fetchResponse(init: ResponseInit, body = ""): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("mintGsid", () => {
  test("fails closed when credentials are absent", async () => {
    const reader: GsliveCredentialReader = { get: async () => null };
    await expect(
      mintGsid(fetchResponse({ status: 403 }), reader),
    ).rejects.toThrow(/not in Bun\.secrets/);
  });

  test("reports rejected credentials without persisting a session", async () => {
    await expect(
      mintGsid(fetchResponse({ status: 403 }), credentials),
    ).rejects.toThrow(/rejected the keychain credentials/);
  });

  test("reports a signin response without a GSID", async () => {
    const fetchImpl = fetchResponse(
      { status: 200, headers: { "content-type": "application/json" } },
      JSON.stringify({ ok: true }),
    );
    await expect(mintGsid(fetchImpl, credentials)).rejects.toThrow(
      /without a GSID cookie/,
    );
  });
});
