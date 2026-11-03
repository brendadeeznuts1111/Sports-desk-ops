/**
 * Host half of the desk-status bundle.
 *
 * It deliberately does nothing: the row is rendered by the Client module
 * (`client.js`, declared through `dsh.client` in package.json). Keeping the
 * Host half empty means the bundle has no Host services to inject, no tools,
 * and no side effects — so it can be installed or removed without touching the
 * `dsh-plugin-sportsdesk-ops` tools bundle.
 *
 * @module dsh-plugin-sportsdesk-desk-status
 */

export function apply() {}
