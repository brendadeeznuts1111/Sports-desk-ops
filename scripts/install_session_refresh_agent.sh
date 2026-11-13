#!/usr/bin/env bash
# Install, remove, or inspect the SportsDesk LaunchAgents (`session-refresh` and/or `daemon`).
#
# Both plists use Option A (`op run --env-file=__REPO_PATH__/.env.op -- __BUN_BIN__ --no-env-file
# run ...`) with `OP_SERVICE_ACCOUNT_TOKEN` stored inside a `chmod 0600` LaunchAgent plist so
# unattended boots never block on the `.env` 1Password Desktop FIFO.
#
# Usage:
#   scripts/install_session_refresh_agent.sh install [--target session-refresh|daemon|both]
#   scripts/install_session_refresh_agent.sh uninstall [--target session-refresh|daemon|both]
#   scripts/install_session_refresh_agent.sh status [--target session-refresh|daemon|both]
#
# Defaults to `--target session-refresh` so existing runbooks continue to work unchanged.
# Requires `.env.op` in the repo root and `OP_SERVICE_ACCOUNT_TOKEN` exported in the calling
# interactive shell when running `install`. No secret is printed or passed via command-line argv.

set -euo pipefail

REPO_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_REFRESH_LABEL="com.bookdeskops.sportsdesk.session-refresh"
DAEMON_LABEL="com.bookdeskops.sportsdesk.daemon"

TARGET="session-refresh"
ACTION=""

usage() {
  cat >&2 <<'USAGE'
install_session_refresh_agent.sh install|uninstall|status [--target session-refresh|daemon|both]

  install    Substitute placeholders in the selected template(s), write chmod 0600 plist(s) to
             ~/Library/LaunchAgents/, run `plutil -lint`, and `launchctl bootstrap` them.
             Requires `${REPO_PATH}/.env.op` and `OP_SERVICE_ACCOUNT_TOKEN` in the environment.
  uninstall  `launchctl bootout` the selected agent(s) and remove the installed plist(s).
  status     Print `launchctl print` / `launchctl list` state for the selected agent(s).
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      install|uninstall|status)
        if [[ -n "${ACTION}" ]]; then
          echo "error: duplicate action '$1'" >&2
          usage
          exit 2
        fi
        ACTION="$1"
        shift
        ;;
      --target)
        if [[ $# -lt 2 ]]; then
          echo "error: --target requires a value (session-refresh|daemon|both)" >&2
          exit 2
        fi
        TARGET="$2"
        shift 2
        ;;
      --target=*)
        TARGET="${1#--target=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "error: unknown argument '$1'" >&2
        usage
        exit 2
        ;;
    esac
  done

  if [[ -z "${ACTION}" ]]; then
    usage
    exit 2
  fi

  case "${TARGET}" in
    session-refresh|daemon|both) ;;
    *)
      echo "error: invalid --target '${TARGET}' (expected session-refresh, daemon, or both)" >&2
      exit 2
      ;;
  esac
}

selected_labels() {
  case "${TARGET}" in
    session-refresh) printf '%s\n' "${SESSION_REFRESH_LABEL}" ;;
    daemon) printf '%s\n' "${DAEMON_LABEL}" ;;
    both) printf '%s\n%s\n' "${DAEMON_LABEL}" "${SESSION_REFRESH_LABEL}" ;;
  esac
}

resolve_bun_bin() {
  local bun_bin
  bun_bin="$(command -v bun || true)"
  if [[ -z "${bun_bin}" && -x "${HOME}/.bun/bin/bun" ]]; then
    bun_bin="${HOME}/.bun/bin/bun"
  fi
  if [[ -z "${bun_bin}" ]]; then
    echo "error: 'bun' not found; install Bun 1.4.4+ before running install" >&2
    exit 1
  fi
  printf '%s' "${bun_bin}"
}

resolve_op_bin() {
  local op_bin
  op_bin="$(command -v op || true)"
  if [[ -z "${op_bin}" && -x "/opt/homebrew/bin/op" ]]; then
    op_bin="/opt/homebrew/bin/op"
  fi
  if [[ -z "${op_bin}" && -x "/usr/local/bin/op" ]]; then
    op_bin="/usr/local/bin/op"
  fi
  if [[ -z "${op_bin}" ]]; then
    echo "error: 1Password CLI ('op') not found on PATH or /opt/homebrew/bin/op" >&2
    exit 1
  fi
  printf '%s' "${op_bin}"
}

render_plist_from_env() {
  local bun_bin="$1"
  local template_plist="$2"
  local target_plist="$3"

  # Pass token/paths via environment variables (never CLI args) and XML-escape replacements so
  # special characters (`&`, `<`, `>`) cannot produce invalid plist XML.
  RENDER_TEMPLATE="${template_plist}" \
  RENDER_TARGET="${target_plist}" \
    "${bun_bin}" --no-env-file -e '
      import { chmodSync, readFileSync, writeFileSync } from "node:fs";
      const escapeXml = (value) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const templatePath = process.env.RENDER_TEMPLATE ?? "";
      const targetPath = process.env.RENDER_TARGET ?? "";
      const replacements = new Map([
        ["__OPERATOR_HOME__", process.env.RENDER_HOME ?? ""],
        ["__REPO_PATH__", process.env.RENDER_REPO ?? ""],
        ["__OP_BIN__", process.env.RENDER_OP_BIN ?? ""],
        ["__BUN_BIN__", process.env.RENDER_BUN_BIN ?? ""],
        ["__BUN_BIN_DIR__", process.env.RENDER_BUN_BIN_DIR ?? ""],
        ["__OP_SERVICE_ACCOUNT_TOKEN__", process.env.OP_SERVICE_ACCOUNT_TOKEN ?? ""],
      ]);
      let xml = readFileSync(templatePath, "utf8");
      for (const [token, value] of replacements) {
        xml = xml.replaceAll(token, escapeXml(value));
      }
      writeFileSync(targetPath, xml, { encoding: "utf8", mode: 0o600 });
      chmodSync(targetPath, 0o600);
    '
}

cmd_install() {
  local env_op_file="${REPO_PATH}/.env.op"
  if [[ ! -f "${env_op_file}" ]]; then
    echo "error: ${env_op_file} is missing; copy .env.op.example to .env.op and fill op:// refs" >&2
    exit 1
  fi
  chmod 0600 "${env_op_file}"

  if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    echo "error: OP_SERVICE_ACCOUNT_TOKEN is unset; export your 1Password service-account token first" >&2
    exit 1
  fi

  local bun_bin op_bin bun_bin_dir uid
  bun_bin="$(resolve_bun_bin)"
  op_bin="$(resolve_op_bin)"
  bun_bin_dir="$(dirname "${bun_bin}")"
  uid="$(id -u)"

  mkdir -p "${HOME}/Library/LaunchAgents" "${REPO_PATH}/scratch"

  local label template_plist target_plist
  while IFS= read -r label; do
    template_plist="${REPO_PATH}/infra/launchd/${label}.plist"
    target_plist="${HOME}/Library/LaunchAgents/${label}.plist"
    if [[ ! -f "${template_plist}" ]]; then
      echo "error: template missing at ${template_plist}" >&2
      exit 1
    fi

    RENDER_HOME="${HOME}" \
    RENDER_REPO="${REPO_PATH}" \
    RENDER_OP_BIN="${op_bin}" \
    RENDER_BUN_BIN="${bun_bin}" \
    RENDER_BUN_BIN_DIR="${bun_bin_dir}" \
      render_plist_from_env "${bun_bin}" "${template_plist}" "${target_plist}"

    plutil -lint "${target_plist}" >/dev/null
    launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
    launchctl bootstrap "gui/${uid}" "${target_plist}"
    echo "installed: ${target_plist}"
  done < <(selected_labels)

  if [[ "${TARGET}" == "session-refresh" || "${TARGET}" == "both" ]]; then
    echo "next: tail -f ${REPO_PATH}/scratch/f402-session-refresh.jsonl"
  fi
  if [[ "${TARGET}" == "daemon" || "${TARGET}" == "both" ]]; then
    echo "next: curl -fsS http://127.0.0.1:4020/health"
  fi
}

cmd_uninstall() {
  local uid label target_plist
  uid="$(id -u)"
  while IFS= read -r label; do
    target_plist="${HOME}/Library/LaunchAgents/${label}.plist"
    launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
    if [[ -f "${target_plist}" ]]; then
      rm -f "${target_plist}"
      echo "removed: ${target_plist}"
    else
      echo "nothing to remove at ${target_plist}"
    fi
  done < <(selected_labels)
}

cmd_status() {
  local uid label
  uid="$(id -u)"
  while IFS= read -r label; do
    echo "=== ${label} ==="
    if launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
      launchctl print "gui/${uid}/${label}" | grep -E 'state =|pid =|last exit code =|path =' || true
    else
      echo "not loaded"
    fi
  done < <(selected_labels)
}

parse_args "$@"
case "${ACTION}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
esac
