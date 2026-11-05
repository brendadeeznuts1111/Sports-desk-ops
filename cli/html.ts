/**
 * CLI-facing HTML capture helpers. The parser and loader live in `lib/bet_ticker_html.ts`;
 * this module keeps the CLI import path stable.
 */
export {
  htmlHeaderMap,
  loadCapture,
  parseBetTickerHtml,
} from "../lib/bet_ticker_html.ts";
export type {
  HtmlBetTicket,
  HtmlHeader,
  LoadCaptureOptions,
  LoadedCapture,
} from "../lib/bet_ticker_html.ts";
