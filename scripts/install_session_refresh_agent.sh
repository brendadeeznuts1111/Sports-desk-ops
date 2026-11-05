#!/usr/bin/env bash
# Install or remove the F402 session-refresh LaunchAgent.
#
# This script substitutes the three placeholders in
# `infra/launchd/com.bookdeskops.sportsdesk.session-refresh.plist` with the operator's real
# paths and loads the resulting plist into user launchd. It is the only sanctioned way to put
# the plist into `~/Library/LaunchAgents/`, because that directory lives outside the repo and
# the paths it contains are machine-specific.
#
# Usage:
#   scripts/install_session_refresh_agent.sh install     # copy + load
#   scripts/install_session_refresh_agent.sh uninstall   # unload + remove
#   scripts/install_session_refresh_agent.sh status      # show launchctl state
#
# No secret is ever read, written, or printed. The script only touches file paths and
# `launchctl load/unload/list`.

set -euo pipefail

LABEL="com.bookdeskops.sportsdesk.session-refresh"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
REPO_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_PLIST="${REPO_PATH}/infra/launchd/${LABEL}.plist"

usage() {
  cat >&2 <<'USAGE'
install_session_refresh_agent.sh install|uninstall|status

  install    Substitute __OPERATOR_HOME__ / __REPO_PATH__ / __BUN_BIN__ in the template,
             write the result to ~/Library/LaunchAgents/, then launchctl load it.
  uninstall  launchctl unload the agent and remove the installed plist.
  status     Print `launchctl list` state for the agent.
USAGE
}

resolve_bun_bin() {
  local bun_bin
  bun_bin="$(command -v bun || true)"
  if [[ -z "${bun_bin}" ]]; then
    echo "error: 'bun' not on PATH; install Bun 1.4.4+ before running install" >&2
    exit 1
  fi
  printf '%s' "${bun_bin}"
}

cmd_install() {
  if [[ ! -f "${TEMPLATE_PLIST}" ]]; then
    echo "error: template missing at ${TEMPLATE_PLIST}" >&2
    exit 1
  fi
  local bun_bin
  bun_bin="$(resolve_bun_bin)"
  mkdir -p "${HOME}/Library/LaunchAgents"
  # sed with a | delimiter so slashes in the paths do not need escaping.
  sed \
    -e "s|__OPERATOR_HOME__|${HOME}|g" \
    -e "s|__REPO_PATH__|${REPO_PATH}|g" \
    -e "s|__BUN_BIN__|${bun_bin}|g" \
    "${TEMPLATE_PLIST}" > "${TARGET_PLIST}"
  chmod 0600 "${TARGET_PLIST}"
  # Unload first so a re-install picks up a plist change without manual intervention.
  launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
  launchctl load -w "${TARGET_PLIST}"
  echo "installed: ${TARGET_PLIST}"
  echo "next: tail -f ${REPO_PATH}/scratch/f402-session-refresh.jsonl"
}

cmd_uninstall() {
  if [[ -f "${TARGET_PLIST}" ]]; then
    launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
    rm -f "${TARGET_PLIST}"
    echo "removed: ${TARGET_PLIST}"
  else
    echo "nothing to remove at ${TARGET_PLIST}"
  fi
}

cmd_status() {
  if launchctl list "${LABEL}" 2>/dev/null; then
    :
  else
    echo "not loaded"
  fi
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  *) usage; exit 2 ;;
esac
