/**
 * Identifier detection: does this text carry F402 logins?
 *
 * A pure transform from text to tokens — no fs, no server state — so it can be called from a test,
 * from a capture validator, or from a route boundary without dragging any of them in.
 *
 * The shape was chosen by measurement, not taste. Over this repo's artifacts:
 *
 *   loose `\b[A-Z][A-Z0-9]{2,15}\b` minus an HTTP/env denylist does not separate the classes
 *     identifying: graph.html 274 · feed 141 · live-wagers 50 · analysis 9 · agent-tree 2216
 *     benign:      contests 41 (!) · scoreboard 9 · index 2 · sports-catalog 0
 *   `contests.json` outscored the identifying analysis artifact because its tokens are league and
 *   market codes (MLB, NBA, OVER, TOTAL). No denylist keeps up with a domain's own vocabulary.
 *
 *   F402 login shape (letters then digits) does separate them
 *     identifying: 49 · 50 · 17 · 5 · 503
 *     benign:      0 · 0 · 0 · 0
 *
 * Letters-only logins carry no digits and are named explicitly. Tests calibrate both classes so a
 * future tweak cannot become a matcher that matches everything or nothing.
 */

/** `BILLY666`, `EGGT3`, `CUB22HR` — letters, digits, optional trailing letters. */
export const LOGIN_SHAPE = /\b[A-Z]{2,6}\d{2,5}[A-Z]{0,3}\b/g;

/** Logins with no digits, which the shape cannot catch. */
export const LETTERS_ONLY_LOGINS = [
  "BILLY666",
  "BIGDAD",
  "ATEAM",
  "TDFIRE",
  "NICHOLAS",
  "UNITED",
] as const;

/** Distinct identifiers in `text`. Empty means the text carries none of either kind. */
export function suspiciousIdentifiers(text: string): string[] {
  const shaped = text.match(LOGIN_SHAPE) ?? [];
  const named = LETTERS_ONLY_LOGINS.filter((login) => text.includes(login));
  return [...new Set([...shaped, ...named])];
}
