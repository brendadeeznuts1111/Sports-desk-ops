import { describe, expect, test } from "bun:test";
import { ticketWriterDisposition } from "./live_writer_policy.ts";

describe("ticket writer policy", () => {
  test("padded and lowercased alert writers are alert mirrors", () => {
    expect(
      ticketWriterDisposition(
        "ALERT                                             ",
      ),
    ).toBe("alert");
    expect(ticketWriterDisposition("alert")).toBe("alert");
  });

  test("blocked writers are excluded", () => {
    expect(ticketWriterDisposition(" blocked ")).toBe("blocked");
  });

  test("book writers keep their rows", () => {
    expect(ticketWriterDisposition("Internet   ")).toBe("book");
    expect(ticketWriterDisposition("GSLIVE")).toBe("book");
    expect(ticketWriterDisposition(null)).toBe("book");
  });
});
