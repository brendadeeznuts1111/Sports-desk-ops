/**
 * Copy-paste blocks for humans and coding agents — Fantasy402 manager session hygiene.
 * Never embed live credentials; transport injects cookies via WebView dataStore / session file.
 */

/** Use as its own markdown section (do not merge with procedural steps). */
export const F402_AGENT_SECURITY_WARNING_MARKDOWN = `### ⚠️ SECURITY WARNING

If a **live Bearer JWT**, session cookie, or portal password appears in chat, logs, HAR, or a commit:

1. **Revoke the session now** — log out of the manager portal or force expiration upstream.
2. **Do not paste it again** — not in issues, commits, fixtures, or agent prompts.
3. **Do not hardcode tokens in scripts** — use \`createF402ReplayTransport()\` (WebView profile \`F402_WEBVIEW_PROFILE\`, \`F402_SESSION_FILE\`, or \`F402_REPLAY_PROXY_URL\`).

Active JWTs grant **full manager API access**. Treat pasted tokens as a credential incident.` as const;

/** Second block when repeating the notice (e.g. before sharing artifacts). */
export const F402_AGENT_SECURITY_WARNING_AGAIN_MARKDOWN = `### ⚠️ SECURITY WARNING (AGAIN)

Before sharing graph JSON, HAR, probe logs, or agent transcripts externally:

1. **Revoke** any session that ever appeared in plaintext.
2. **Redact** — run manager HAR redaction gates; no live \`Authorization\` headers in attachments.
3. **Never** re-paste Bearer tokens to tools or commits.` as const;

export const F402_AGENT_GRAPH_OPERATOR_DOC =
  "docs/evidence/agent-graph-operator.md" as const;

export const F402_AGENT_FORBIDDEN_IN_REPO = [
  "Authorization: Bearer eyJ",
  "Bearer eyJ",
  "paste.*token",
  "hardcode.*Bearer",
] as const;
