/**
 * Child used by tests/desk_fetch_proxy_transports.test.ts. Runs in a fresh
 * process so HTTP_PROXY / HTTPS_PROXY can be set without racing the suite.
 * Argv: <kind> <url>
 */
import { fetchPortalArtifactBytes } from "../../lib/f402_portal_bundle_fetch.ts";
import { fetchLiveVersionJs } from "../../lib/f402_portal_version_pin.ts";
import { createF402ReplayTransport } from "../../lib/f402_replay_transport.ts";
import { fetchManagerJson, postManagerJson } from "../../lib/manager_fetch.ts";

const [kind, url] = Bun.argv.slice(2);
if (kind === undefined || url === undefined) {
  throw new Error("usage: desk_fetch_transports_child.ts <kind> <url>");
}

const emptyEnv = {
  F402_REPLAY_PROXY_URL: "",
  F402_COOKIE: "",
} as const;

let status = 0;
let body = "";

if (kind === "manager") {
  const response = await fetchManagerJson(url, "GSID=test");
  status = response.status;
  body = await response.text();
} else if (kind === "manager-post") {
  const response = await postManagerJson(url, "GSID=test", { ok: true });
  status = response.status;
  body = await response.text();
} else if (kind === "portal-version") {
  const live = await fetchLiveVersionJs(url, "1.0.280");
  status = 200;
  body = live.text;
} else if (kind === "portal-bundle") {
  const artifact = `${url.replace(/\/$/, "")}/app/setting/version.js?bust=1.0.280`;
  const outcome = await fetchPortalArtifactBytes(artifact);
  if (outcome.kind !== "ok") {
    throw new Error(`portal-bundle ${JSON.stringify(outcome)}`);
  }
  status = 200;
  body = new TextDecoder().decode(outcome.body);
} else if (kind === "replay-session") {
  const transport = await createF402ReplayTransport({
    env: { ...emptyEnv },
    readSession: () => ({
      cookieHeader: "session=test",
      cookieNames: ["session"],
      obtainedAtIso: new Date().toISOString(),
      expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  const response = await transport.fetch(url, {});
  status = response.status;
  body = await response.text();
  await transport.close();
} else if (kind === "replay-local-proxy") {
  const target = new URL(url);
  const base = `${target.protocol}//${target.host}`;
  const transport = await createF402ReplayTransport({
    env: { ...emptyEnv },
    proxyUrl: base,
  });
  const response = await transport.fetch(`${base}/upstream-path?q=1`, {});
  status = response.status;
  body = await response.text();
  await transport.close();
} else {
  throw new Error(`unknown kind ${kind}`);
}

process.stdout.write(JSON.stringify({ kind, status, body }));
