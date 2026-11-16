#!/usr/bin/env bash
# Bring up the dashboard preview (and the fixture API it proxies when needed).
#
#   bun run desk:preview:up                 # http://127.0.0.1:4176
#   PORT=4174 bun run desk:preview:up       # any port
#
# The sandbox can SIGTERM long-lived children, so the preview runs under a small supervisor and
# restarts itself; Ctrl-C exits the loop. dev:api is started only when nothing is listening on the
# feeds port, and it reads captures from SPORTSDESK_DATA_DIR (default: this checkout's root).
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
DATA_DIR=${SPORTSDESK_DATA_DIR:-$REPO_ROOT}
FEEDS=${DASH_API_FEEDS:-http://127.0.0.1:4021}
FEEDS_PORT=${FEEDS##*:}
PORT=${PORT:-4176}

if ! lsof -nP -iTCP:"$FEEDS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting dev:api on :$FEEDS_PORT (data dir: $DATA_DIR)" >&2
  (
    cd "$REPO_ROOT"
    SPORTSDESK_DATA_DIR="$DATA_DIR" PORT="$FEEDS_PORT" \
      bun run scripts/dev_dashboard.ts --api-only >/tmp/sportsdesk-dev-api.log 2>&1 &
  )
  sleep 1
fi

trap 'echo "stopping preview" >&2; exit 0' INT TERM
while true; do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT is already in use; refusing to restart (stop the other process or pick PORT=…)" >&2
    exit 1
  fi
  status=0
  DASH_API_FEEDS="$FEEDS" PORT="$PORT" \
    bun run "$REPO_ROOT/scripts/dashboard_preview.ts" || status=$?
  # A killed child can leave the listener briefly; do not spin on EADDRINUSE.
  sleep 2
  echo "preview exited (status $status); restarting in 2s" >&2
done
