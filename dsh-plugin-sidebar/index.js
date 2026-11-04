/**
 * Host half of the SportsDesk desk-panel bundle.
 *
 * It deliberately does nothing: the left-sidebar entry and the panel it opens
 * are rendered by the Client module (`client.js`, declared through `dsh.client`
 * in package.json). Keeping the Host half empty means the bundle injects no Host
 * services, registers no tools, and has no side effects — so it can be
 * installed, enabled, disabled, or removed without touching the
 * `dsh-plugin-sportsdesk-ops` tools bundle or the `dsh-plugin-ui` composer row.
 *
 * @module dsh-plugin-sportsdesk-desk-panel
 */

export function apply() {}
