/**
 * @file packages/ui/src/links.ts
 * @description Local SportsDesk route builders and broken desk.bookdeskops.com URL sanitizer.
 */

const BROKEN_DESK_AGENT_RE =
  /^https?:\/\/desk\.bookdeskops\.com\/agent\/([^/?#]+)/i;

export function getLocalAgentHref(agentId: string): string {
  const clean = agentId.trim().toUpperCase();
  return `/agent/${encodeURIComponent(clean)}`;
}

export function getLocalCustomerHref(customerId: string): string {
  const clean = customerId.trim().toUpperCase();
  return `/customer/${encodeURIComponent(clean)}`;
}

export function rewriteBrokenDeskUrl(url: string): string {
  const match = BROKEN_DESK_AGENT_RE.exec(url.trim());
  if (match?.[1]) {
    return getLocalAgentHref(decodeURIComponent(match[1]));
  }
  return url;
}
