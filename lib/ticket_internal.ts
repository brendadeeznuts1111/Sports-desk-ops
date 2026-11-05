/**
 * @file ticket_internal.ts
 * @description Non-serializable customer/agent identity attached to a parsed ticket.
 *
 * The public ticket views (`NormalizedTicket`, `HtmlBetTicket`) deliberately omit customer
 * and agent identifiers. Anomaly rules still need them to group same-customer activity, so
 * they live in a WeakMap keyed by the ticket object: `JSON.stringify`, `toSafeJson` and
 * `Object.keys` can never see them, and they are collected with the ticket.
 */
export interface TicketInternal {
  readonly customer: string;
  readonly agent: string;
}

const INTERNAL = new WeakMap<object, TicketInternal>();

export function setTicketInternal(
  ticket: object,
  internal: TicketInternal,
): void {
  INTERNAL.set(ticket, {
    customer: internal.customer.trim(),
    agent: internal.agent.trim(),
  });
}

export function getTicketInternal(ticket: object): TicketInternal | undefined {
  return INTERNAL.get(ticket);
}
