import { describe, expect, test } from "bun:test";
import { sanitizeCaptureText } from "../packages/ui/src/capture_text.ts";

describe("capture_text · portal markup", () => {
  test("strips a TicketWriter strong tag and its padding", () => {
    expect(
      sanitizeCaptureText(
        '<strong style="color:#D90000">ALERT                                             </strong>',
      ),
    ).toBe("ALERT");
  });

  test("strips inline formatting but keeps the text", () => {
    expect(sanitizeCaptureText("<em>Pick</em> &lt;3")).toBe("Pick <3");
    expect(sanitizeCaptureText("line<br>two")).toBe("line two");
  });

  test("leaves a lone comparison sign alone", () => {
    expect(sanitizeCaptureText("Over < 47.5")).toBe("Over < 47.5");
  });
});

describe("capture_text · entities", () => {
  test("decodes the numeric half-point references in captures", () => {
    expect(sanitizeCaptureText("Thunder/Kings U 112&#189; -110")).toBe(
      "Thunder/Kings U 112½ -110",
    );
    expect(sanitizeCaptureText("Kings +4&#189; -115")).toBe("Kings +4½ -115");
  });

  test("decodes hex references and removes control references", () => {
    expect(sanitizeCaptureText("line&#x0D;break")).toBe("line break");
    expect(sanitizeCaptureText("A&#x26;B")).toBe("A&B");
  });

  test("decodes double-encoded references once more", () => {
    expect(sanitizeCaptureText("&amp;#189;")).toBe("½");
    expect(sanitizeCaptureText("A &amp; B")).toBe("A & B");
  });

  test("preserves unknown entities instead of guessing", () => {
    expect(sanitizeCaptureText("&unknown; stays")).toBe("&unknown; stays");
  });

  test("collapses padding and control characters", () => {
    expect(sanitizeCaptureText("  Kings\u0000 +4  \n")).toBe("Kings +4");
    expect(sanitizeCaptureText("")).toBe("");
  });
});
