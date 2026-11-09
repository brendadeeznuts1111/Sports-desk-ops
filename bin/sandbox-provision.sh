#!/usr/bin/env bash
# ==============================================================================
# bin/sandbox-provision.sh — Self-Contained Bun & Types Package Provisioner
#
# Installs or refreshes the pinned `bun` runtime (`@oven/bun-darwin-aarch64`) and
# `@types/bun` directly inside the sandbox `$HOME/.bun` via npm/package cache
# (avoiding cross-user Seatbelt symlink blocks on `/Users/nolarose/.bun`), wires
# dotfiles via `./bin/dx setup --replace`, and verifies `shell-health --strict`
# and `bun_verify`.
# ==============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_HOME="${HOME%%/.gemini/users/*}"
SANDBOX_HOME="${SANDBOX_HOME:-$HOST_HOME/.gemini/users/user1}"
DOTFILES_DIR="${DOTFILES_ROOT:-$HOST_HOME/dotfiles}"
PIN="$(tr -d '[:space:]' < "$DOTFILES_DIR/.bun-version" 2>/dev/null || echo "1.4.4")"

export PATH="$SANDBOX_HOME/.bun/bin:$SANDBOX_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "==> Provisioning self-contained Bun@$PIN + @types/bun@$PIN in $SANDBOX_HOME/.bun"
mkdir -p "$SANDBOX_HOME/.bun/bin" "$SANDBOX_HOME/.local/bin" "$SANDBOX_HOME/.config/git" "$SANDBOX_HOME/.config/gh"

if [[ ! -x "$SANDBOX_HOME/.bun/bin/bun" || "$("$SANDBOX_HOME/.bun/bin/bun" --version 2>/dev/null || true)" != "$PIN" ]]; then
  npm install --prefer-offline --prefix "$SANDBOX_HOME/.bun" --no-save "@oven/bun-darwin-aarch64@$PIN" "@types/bun@$PIN"
  if [[ -f "$SANDBOX_HOME/.bun/node_modules/@oven/bun-darwin-aarch64/bin/bun" ]]; then
    cp -fL "$SANDBOX_HOME/.bun/node_modules/@oven/bun-darwin-aarch64/bin/bun" "$SANDBOX_HOME/.bun/bin/bun"
    chmod 755 "$SANDBOX_HOME/.bun/bin/bun"
  fi
fi

ln -sf "$SANDBOX_HOME/.bun/bin/bun" "$SANDBOX_HOME/.bun/bin/bunx"
ln -sf "$SANDBOX_HOME/.bun/bin/bun" "$SANDBOX_HOME/.bun/bin/bun-latest"
ln -sf "$SANDBOX_HOME/.bun/bin/bun" "$SANDBOX_HOME/.local/bin/bun"
printf '%s\n' "$("$SANDBOX_HOME/.bun/bin/bun" --version)" > "$SANDBOX_HOME/.local/bin/.bun-provisioned-version"

HOME="$SANDBOX_HOME" "$REPO_ROOT/bin/dx" setup --replace
HOME="$SANDBOX_HOME" zsh -c 'source "$HOME/.zshenv"; source "$HOME/.config/shell/bun.sh"; shell-health --strict && bun_verify'
