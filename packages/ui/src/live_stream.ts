/**
 * @file packages/ui/src/live_stream.ts
 * @description Streaming bookkeeping for the wager feed: which tickets are new since the
 * previous snapshot. Kept pure so the "first load is not news" rule is testable.
 */

/**
 * Ticket ids present in `next` but not in `previous`.
 *
 * `previous === null` means "the feed has not loaded yet", so nothing is new: the first
 * snapshot is the baseline, not an arrival burst.
 */
export function newTicketIds(
  previous: ReadonlySet<string> | null,
  next: Iterable<string>,
): readonly string[] {
  if (previous === null) return [];
  const fresh: string[] = [];
  for (const ticketId of next) {
    if (!previous.has(ticketId)) fresh.push(ticketId);
  }
  return fresh;
}
