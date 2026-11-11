#!/usr/bin/env bash
# ==============================================================================
# SportsDesk & Fantasy402 Automated API Documentation Deployment Script
# Usage: ./deploy_docs.sh [--test-only] [--dry-run] [--project <name>]
# ==============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PROJECT_NAME="fantasy402-docs"
DRY_RUN=false
TEST_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-d)
      DRY_RUN=true
      shift
      ;;
    --test-only|-t)
      TEST_ONLY=true
      shift
      ;;
    --project|-p)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --help|-h)
      echo "SportsDesk API Docs Automated Deployment Tool"
      echo "Usage: ./deploy_docs.sh [options]"
      echo ""
      echo "Options:"
      echo "  -t, --test-only        Run test suite only without deploying"
      echo "  -d, --dry-run          Run tests and stage dist/ without publishing"
      echo "  -p, --project <name>   Target Cloudflare Pages project (default: fantasy402-docs; portal domain fantasy402-docs-4ay.pages.dev)"
      echo "  -h, --help             Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

echo "================================================================================"
echo "SPORTSDESK & FANTASY402 API DOCUMENTATION PIPELINE"
echo "================================================================================"

# Step 1: Run automated verification tests
echo "[1/3] Running API documentation and OpenAPI 3.1 verification tests..."
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun not found in PATH (this repo runs on Bun 1.4.4; Node is not supported)" >&2
  exit 1
fi
bun test tests/api_reference.test.ts
echo "✓ All schema and documentation assertions passed cleanly."

# Step 1b: Provenance / freshness / portal gates
bun run scripts/verify_docs.ts
echo "✓ Evidence, freshness and portal gates passed."

# Step 1c: Release registry — refuse to deploy while a superseded tag is current
bun run audit:release
echo "✓ Release registry is current."

if [[ "${TEST_ONLY}" == true ]]; then
  echo ""
  echo "Test-only mode enabled. Exiting cleanly without deployment."
  exit 0
fi

# Step 2: Stage distribution files
echo ""
echo "[2/3] Staging distribution bundle into dist/..."
bun run docs:stage
echo "✓ Staged dist/index.html ($(wc -c < dist/index.html | tr -d ' ') bytes)"
test -f dist/graph.html && echo "✓ Staged dist/graph.html ($(wc -c < dist/graph.html | tr -d ' ') bytes)"
test -f dist/graph.js && echo "✓ Staged dist/graph.js ($(wc -c < dist/graph.js | tr -d ' ') bytes)"
echo "✓ Staged dist/openapi.json ($(wc -c < dist/openapi.json | tr -d ' ') bytes)"
test -f dist/_headers && echo "✓ Staged dist/_headers ($(wc -c < dist/_headers | tr -d ' ') bytes)"

if [[ "${DRY_RUN}" == true ]]; then
  echo ""
  echo "Dry-run mode enabled. Staging complete; skipped Cloudflare upload."
  exit 0
fi

# Step 3: Deploy via keyless Wrangler (`bun x wrangler` / `bin/wrangler`)
echo ""
echo "[3/3] Publishing to Cloudflare Pages (project: ${PROJECT_NAME})..."
if [[ -x "${REPO_ROOT}/bin/wrangler" ]]; then
  "${REPO_ROOT}/bin/wrangler" pages deploy dist --project-name="${PROJECT_NAME}" --branch=main
elif command -v bun >/dev/null 2>&1; then
  bun x --bun wrangler pages deploy dist --project-name="${PROJECT_NAME}" --branch=main
else
  echo "Error: wrangler not found. Ensure bin/wrangler exists or run with Bun installed." >&2
  exit 1
fi

echo ""
echo "================================================================================"
echo "✨ Deployment successful!"
echo "Verify the live artifact before announcing it:"
echo "  bun run scripts/verify_docs.ts --live https://fantasy402-docs-4ay.pages.dev"
echo "  (the live openapi.json sha256 must equal: $(sha256sum dist/openapi.json | awk '{print $1}'))"
echo "Production URL : https://fantasy402-docs-4ay.pages.dev"
echo "OpenAPI Spec   : https://fantasy402-docs-4ay.pages.dev/openapi.json"
echo "Custom Domain  : https://docs.bookdeskops.com (once CNAME bound in Cloudflare)"
echo "================================================================================"
