/**
 * @file lib/live_writer_policy.ts
 * @description Which ticker writers are book positions, alert mirrors, or blocked rows.
 *
 * The capture pads `TicketWriter` with spaces; the harvester trims and lowercases before comparing,
 * but the direct capture→profile merge did not, so 63 `ALERT` mirror rows became positions. One
 * policy, used by both readers, keeps that filter from diverging again.
 */

export type TicketWriterDisposition = "book" | "alert" | "blocked";

export function ticketWriterDisposition(raw: unknown): TicketWriterDisposition {
  const writer = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (writer === "alert") return "alert";
  if (writer === "blocked") return "blocked";
  return "book";
}
