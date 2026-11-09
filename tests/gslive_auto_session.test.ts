import { describe, expect, test } from "bun:test";

import {
  ensureGsid,
  GSLIVE_CLOUDFLARE_BLOCKED_PREFIX,
  mintGsid,
  resetGsliveAutoSessionCache,
  resetGsliveMintFailureStreakForTests,
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
      mintGsid(
        fetchResponse(
          { status: 403 },
          JSON.stringify({ d: "Username or password are incorrect" }),
        ),
        credentials,
      ),
    ).rejects.toThrow(/rejected the keychain credentials/);
  });

  test("reports Cloudflare when sign-in returns an empty 200", async () => {
    await expect(
      mintGsid(
        fetchResponse({
          status: 200,
          headers: { "set-cookie": "GSID=bot-edge" },
        }),
        credentials,
      ),
    ).rejects.toThrow(new RegExp(GSLIVE_CLOUDFLARE_BLOCKED_PREFIX));
  });

  test("reports a signin response without a GSID", async () => {
    const fetchImpl = fetchResponse(
      { status: 200, headers: { "content-type": "application/json" } },
      JSON.stringify({ ok: true }),
    );
    await expect(mintGsid(fetchImpl, credentials)).rejects.toThrow(
      /no GSID in headers or JSON body/,
    );
  });

  test("skips checkSession bootstrap when credential JSON has ganchrowSessionId", async () => {
    let signinCalls = 0;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("signin")) {
        signinCalls += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes("checkSession")) {
          throw new Error(
            "bootstrapGanchrowSession should not run on credential mint",
          );
        }
        return new Response(
          JSON.stringify({
            ganchrowSessionId: "gate-body-only",
            adminUserName: "op",
            partner: 118,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "GSID=cookie-from-header; Path=/",
            },
          },
        );
      }
      return new Response('{"r":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await mintGsid(fetchImpl, credentials);
    expect(signinCalls).toBe(1);
  });

  test("accepts GSID from JSON when Set-Cookie is stripped", async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("ajax.php")) {
        return new Response('{"r":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          ganchrowSessionId: "gate-from-body",
          GSID: "gsid-from-body",
          adminUserName: "NOLAROSE",
          agentName: "agent",
          partner: 118,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const prevMeta = Bun.env.GSLIVE_SESSION_META_FILE;
    const metaPath = `${import.meta.dir}/../scratch/gslive-mint-meta-test.json`;
    Bun.env.GSLIVE_SESSION_META_FILE = metaPath;
    try {
      const gsid = await mintGsid(fetchImpl, credentials);
      expect(gsid).toBe("gsid-from-body");
      const meta = await Bun.file(metaPath).json();
      expect(meta.adminUserName).toBe("NOLAROSE");
      expect(meta.partner).toBe(118);
    } finally {
      if (prevMeta === undefined) delete Bun.env.GSLIVE_SESSION_META_FILE;
      else Bun.env.GSLIVE_SESSION_META_FILE = prevMeta;
      try {
        await Bun.write(metaPath, "");
      } catch {
        /* ignore */
      }
    }
  });
});

describe("ensureGsid", () => {
  test("escalates after three consecutive mint failures", async () => {
    resetGsliveMintFailureStreakForTests();
    resetGsliveAutoSessionCache();
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("signin")) {
        if (body.includes("checkSession")) {
          return new Response("", { status: 403 });
        }
        return new Response(
          JSON.stringify({ d: "Username or password are incorrect" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("ajax.php")) {
        return new Response("", { status: 403 });
      }
      return new Response("", { status: 403 });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 2; i++) {
      await expect(ensureGsid(fetchImpl)).rejects.toThrow(
        /rejected the keychain credentials|not in Bun\.secrets/,
      );
    }
    await expect(ensureGsid(fetchImpl)).rejects.toThrow(/GSLive_MINT_LOOP/);
    resetGsliveMintFailureStreakForTests();
    resetGsliveAutoSessionCache();
  });
});
