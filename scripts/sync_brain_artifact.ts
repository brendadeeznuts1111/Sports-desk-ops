import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const appDataDir = Bun.env.ANTIGRAVITY_APP_DATA_DIR;
const convId = Bun.env.ANTIGRAVITY_CONVERSATION_ID;

if (appDataDir && convId) {
  const artifactDir = join(appDataDir, "brain", convId);
  const artifactPath = join(artifactDir, "dashboard.html");
  const sourcePath = join(
    dirname(import.meta.dir),
    "examples/feature_flags/dashboard.html",
  );

  if (existsSync(sourcePath) && existsSync(artifactDir)) {
    copyFileSync(sourcePath, artifactPath);
  }
}
