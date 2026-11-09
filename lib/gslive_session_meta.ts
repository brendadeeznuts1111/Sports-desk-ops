/** Last successful GSLive credential sign-in identity (no secrets). */
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GsliveSessionMeta {
  readonly adminUserName?: string;
  readonly agentName?: string;
  readonly partner?: string | number;
  readonly tickerUrl?: string;
  readonly updatedAt?: string;
}

export function gsliveSessionMetaPath(): string {
  const fromEnv = (Bun.env.GSLIVE_SESSION_META_FILE ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return resolve(import.meta.dirname, "../scratch/gslive_session_meta.json");
}

export function readGsliveSessionMeta(): GsliveSessionMeta | null {
  const path = gsliveSessionMetaPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as GsliveSessionMeta;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeGsliveSessionMeta(meta: GsliveSessionMeta): Promise<void> {
  const path = gsliveSessionMetaPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* best effort */
  }
  await Bun.write(path, `${JSON.stringify(meta, null, 2)}\n`);
}
