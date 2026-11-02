/**
 * WebView screenshot (Blob) → Bun.Image WebP — zero disk between capture and encode.
 */

import { ManagedWebView } from "../scripts/capture/webview.ts";
import { atomicWrite } from "./f402_agent_graph_artifacts.ts";
import { AGENT_GRAPH_READY_EVAL } from "./f402_agent_graph_capture_page.ts";

export interface AgentGraphWebpEncodeOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** 1–100 */
  readonly quality: number;
}

export interface CaptureAgentGraphWebpOptions {
  readonly captureUrl: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly backend?: "chrome" | "webkit";
  readonly webp: AgentGraphWebpEncodeOptions;
}

export async function webpBytesFromScreenshotBlob(
  pngBlob: Blob,
  webp: AgentGraphWebpEncodeOptions,
): Promise<Blob> {
  if (pngBlob.size === 0) throw new Error("screenshot blob is empty");
  return new Bun.Image(pngBlob)
    .resize(webp.maxWidth, webp.maxHeight, { fit: "inside" })
    .webp({ quality: webp.quality })
    .blob();
}

export async function captureAgentGraphWebp(
  options: CaptureAgentGraphWebpOptions,
): Promise<Blob> {
  const backend =
    options.backend ??
    (Bun.env.F402_GRAPH_WEBVIEW_BACKEND === "chrome" ? "chrome" : "webkit");

  await using view = ManagedWebView.launch({
    width: options.viewportWidth,
    height: options.viewportHeight,
    backend,
  });

  await view.navigate(options.captureUrl, { timeoutMs: 30_000 });
  await view.evaluate(AGENT_GRAPH_READY_EVAL);
  const pngBlob = await view.screenshotBlob({ format: "png" });
  return webpBytesFromScreenshotBlob(pngBlob, options.webp);
}

export async function writeAgentGraphWebp(
  outPath: string,
  options: CaptureAgentGraphWebpOptions,
): Promise<{ readonly bytes: number; readonly ms: number }> {
  const t0 = Bun.nanoseconds();
  const webpBlob = await captureAgentGraphWebp(options);
  const bytes = new Uint8Array(await webpBlob.arrayBuffer());
  await atomicWrite(outPath, bytes);
  const ms = (Bun.nanoseconds() - t0) / 1_000_000;
  return { bytes: bytes.byteLength, ms };
}
