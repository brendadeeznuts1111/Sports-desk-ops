#!/usr/bin/env bash
# Deterministically bootstrap pinned NSH v0.4.0 (commit e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3)
# into .agents/tools/nsh, verifying SHA-256 archive integrity and exact binary revision.
set -euo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/../.." rev-parse --show-toplevel)
INSTALL_DIR="${NSH_INSTALL_DIR:-$ROOT/.agents/tools/nsh}"

PINNED_TAG="v0.4.0"
PINNED_VERSION="0.4.0"
PINNED_SHORT_SHA="e626a8d"
LINUX_X86_64_SHA256="8806121aebf40bb51f8fb6aa703722fbb01253f9a435759c18d53beece1ec976"
MACOS_ARM64_SHA256="f63c3d57c31b28c9b34227aac81f099d1e0e61f1db552a6ec5127d114eaf59cb"

fail() {
  echo "[install-nsh] error: $*" >&2
  exit 1
}

verify_binary() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  local out
  out="$("$bin" -V 2>&1 || true)"
  [[ "$out" == *"nsh ${PINNED_VERSION} (${PINNED_SHORT_SHA})"* ]]
}

if verify_binary "$INSTALL_DIR/bin/nsh"; then
  echo "[install-nsh] verified cached nsh ${PINNED_VERSION} (${PINNED_SHORT_SHA}) at $INSTALL_DIR/bin/nsh"
  exit 0
fi

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64)
    ASSET="nsh-linux-x86_64.tar.gz"
    EXPECTED_SHA256="$LINUX_X86_64_SHA256"
    ;;
  Darwin/arm64)
    ASSET="nsh-macos-arm64.tar.gz"
    EXPECTED_SHA256="$MACOS_ARM64_SHA256"
    ;;
  *)
    fail "unsupported platform $(uname -s)/$(uname -m) for prebuilt NSH ${PINNED_TAG}"
    ;;
esac

URL="https://github.com/longbridge/nsh/releases/download/${PINNED_TAG}/${ASSET}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "[install-nsh] downloading ${URL}..."
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$WORK/$ASSET"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
else
  fail "neither sha256sum nor shasum found on PATH"
fi

if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  fail "SHA-256 mismatch for $ASSET: expected $EXPECTED_SHA256, got $ACTUAL_SHA256"
fi

tar -xzf "$WORK/$ASSET" -C "$WORK"
[[ -x "$WORK/nsh/bin/nsh" ]] || fail "$ASSET did not extract nsh/bin/nsh"

mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "${INSTALL_DIR}.old"
[[ ! -e "$INSTALL_DIR" ]] || mv "$INSTALL_DIR" "${INSTALL_DIR}.old"
mv "$WORK/nsh" "$INSTALL_DIR"
rm -rf "${INSTALL_DIR}.old"

if ! verify_binary "$INSTALL_DIR/bin/nsh"; then
  fail "installed binary failed pin check (expected 'nsh ${PINNED_VERSION} (${PINNED_SHORT_SHA})', got '$("$INSTALL_DIR/bin/nsh" -V 2>&1 || true)')"
fi

echo "[install-nsh] installed and verified $("$INSTALL_DIR/bin/nsh" -V) at $INSTALL_DIR"
