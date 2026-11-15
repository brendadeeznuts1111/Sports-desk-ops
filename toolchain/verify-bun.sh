#!/bin/sh
# toolchain/verify-bun.sh — boot-time re-verification of the Bun runtime against
# toolchain/bun.pin.json. POSIX sh; needs sha256sum|shasum and jq|python3. It never runs
# the bun it is checking (a tampered binary could lie about its own version or path).
#
#   sh toolchain/verify-bun.sh                 # verify `command -v bun`
#   DX_BUN_BIN=/path/to/bun sh toolchain/verify-bun.sh
#   DX_BUN_PIN=/path/to/other.pin.json ...      # alternate pin (tests use a fake one)
#   --print-path                                # on success print the verified real binary path
#   --quiet                                     # no success line on stderr
#
# Exit: 0 match, 1 mismatch, 2 cannot resolve/hash/parse (fail closed).
set -eu

print_path=0 quiet=0
for a in "$@"; do
  case "$a" in
    --print-path) print_path=1 ;;
    --quiet) quiet=1 ;;
    *) echo "verify-bun: unknown argument: $a" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
pin=${DX_BUN_PIN:-$here/bun.pin.json}
[ -r "$pin" ] || { echo "verify-bun: pin not readable: $pin" >&2; exit 2; }

die() { echo "verify-bun: $*" >&2; exit 2; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "no sha256sum/shasum"; fi
}

# pin_get <jq-path-as-dotted-keys>  e.g. version | platforms.linux-x64.binarySha256
pin_get() {
  if command -v jq >/dev/null 2>&1; then
    jq -er --arg p "$1" 'getpath($p | split(".")) // empty' "$pin" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$pin" "$1" <<'PY' 2>/dev/null || true
import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    v=v.get(k) if isinstance(v,dict) else None
    if v is None: sys.exit(1)
print(v)
PY
  else die "need jq or python3 to read $pin"; fi
}

realpath_portable() {
  p=$1
  if command -v realpath >/dev/null 2>&1; then realpath "$p"; return; fi
  if readlink -f / >/dev/null 2>&1; then readlink -f "$p"; return; fi
  while [ -L "$p" ]; do
    d=$(cd -P "$(dirname "$p")" && pwd); p=$(readlink "$p")
    case $p in /*) ;; *) p="$d/$p" ;; esac
  done
  echo "$(cd -P "$(dirname "$p")" && pwd)/$(basename "$p")"
}

# 1. Resolve the binary.
bin=${DX_BUN_BIN:-}
if [ -z "$bin" ]; then
  bin=$(command -v bun 2>/dev/null || true)
  [ -n "$bin" ] || die "bun not on PATH"
fi
[ -e "$bin" ] || die "not found: $bin"
bin=$(realpath_portable "$bin")

# Package-manager shims (npm/pnpm `bun` packages install a #! script that execs bin/bun.exe).
# Only the exact pnpm/npm cmd-shim form is followed; anything else fails closed.
if [ "$(head -c 2 "$bin" 2>/dev/null)" = "#!" ]; then
  target=$(grep -o '"\$basedir/[^"]*bun\.exe"' "$bin" 2>/dev/null | head -n 1 | tr -d '"' || true)
  [ -n "$target" ] || die "$bin is a script, not a binary, and not a recognised npm/pnpm shim; set DX_BUN_BIN to the real binary"
  target=$(dirname "$bin")/${target#\$basedir/}
  [ -f "$target" ] || die "shim target missing: $target"
  bin=$(realpath_portable "$target")
fi

# 2. Platform key.
os=$(uname -s); arch=$(uname -m)
case "$os-$arch" in
  Linux-x86_64) keys="linux-x64 linux-x64-baseline" ;;
  Linux-aarch64|Linux-arm64) keys="linux-aarch64" ;;
  Darwin-arm64) keys="darwin-aarch64" ;;
  Darwin-x86_64) keys="darwin-x64" ;;
  *) die "no pin for platform $os-$arch" ;;
esac

version=$(pin_get version)
[ -n "$version" ] || die "pin has no version: $pin"
actual=$(sha256 "$bin")

for k in $keys; do
  want=$(pin_get "platforms.$k.binarySha256")
  [ -n "$want" ] || continue
  if [ "$actual" = "$want" ]; then
    [ "$quiet" = 1 ] || echo "verify-bun: OK bun $version ($k) sha256=$actual $bin" >&2
    [ "$print_path" = 1 ] && echo "$bin"
    exit 0
  fi
done

echo "verify-bun: MISMATCH bun at $bin sha256=$actual is not the pinned bun $version for $keys ($pin)" >&2
exit 1
