#!/bin/sh
# toolchain/fetch-and-verify-bun.sh — re-derive toolchain/bun.pin.json from raw release material.
#
# Downloads the pinned bun release asset + SHASUMS256.txt.asc from github.com/oven-sh/bun,
# verifies the OpenPGP clearsignature with the committed Oven release key, asserting the signer
# fingerprint from the pin (gpg --assert-signer), checks the zip against the signed checksum AND
# the pin, extracts it, and checks the binary sha256 against the pin. Never runs the binary
# unless --install is given and verification passed.
#
#   sh toolchain/fetch-and-verify-bun.sh [platform] [--install DIR] [--workdir DIR]
#   platform: linux-x64 (default on x86_64 Linux) | linux-x64-baseline | linux-aarch64 |
#             darwin-aarch64 | darwin-x64
# Needs: curl, gpg (>= 2.2.28 for --assert-signer), unzip, sha256sum|shasum, jq|python3.
# Exit 0 verified; 1 verification failure; 2 usage/tooling error.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
pin=${DX_BUN_PIN:-$here/bun.pin.json}
plat="" install="" work=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install=$2; shift 2 ;;
    --workdir) work=$2; shift 2 ;;
    -*) echo "usage: $0 [platform] [--install DIR] [--workdir DIR]" >&2; exit 2 ;;
    *) plat=$1; shift ;;
  esac
done
if [ -z "$plat" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) plat=linux-x64 ;; Linux-aarch64|Linux-arm64) plat=linux-aarch64 ;;
    Darwin-arm64) plat=darwin-aarch64 ;; Darwin-x86_64) plat=darwin-x64 ;;
    *) echo "fetch-and-verify-bun: unsupported platform" >&2; exit 2 ;;
  esac
fi
get() {
  if command -v jq >/dev/null 2>&1; then jq -er --arg p "$1" 'getpath($p|split("."))' "$pin"
  else python3 -c 'import json,sys;v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$pin" "$1"; fi
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fail() { echo "fetch-and-verify-bun: FAIL $*" >&2; exit 1; }

url=$(get "platforms.$plat.url"); asset=$(get "platforms.$plat.asset")
want_zip=$(get "platforms.$plat.zipSha256"); want_bin=$(get "platforms.$plat.binarySha256")
binpath=$(get "platforms.$plat.binaryPath"); fpr=$(get signer.fingerprint)
sums_url=$(get signedChecksums.url); want_sums=$(get signedChecksums.sha256)
key="$here/../$(get signer.keyFile)"

work=${work:-$(mktemp -d)}; mkdir -p "$work"; cd "$work"
gnupg=$(mktemp -d); chmod 700 "$gnupg"; trap 'rm -rf "$gnupg"' EXIT
echo "fetch: $url" >&2
curl -fsSL --retry 3 -o "$asset" "$url"
rm -rf sig && mkdir sig   # gpg treats a sibling SHASUMS256.txt as detached data; keep the .asc alone
curl -fsSL --retry 3 -o sig/SHASUMS256.txt.asc "$sums_url"

[ "$(sha256 sig/SHASUMS256.txt.asc)" = "$want_sums" ] || echo "fetch-and-verify-bun: note: SHASUMS256.txt.asc bytes differ from the pin (re-signed upstream?); signature decides" >&2
GNUPGHOME=$gnupg gpg --batch --quiet --import "$key" 2>/dev/null
GNUPGHOME=$gnupg gpg --batch --assert-signer "$fpr" --verify --output sig/SHASUMS256.verified.txt sig/SHASUMS256.txt.asc 2>sig/gpg.log \
  || { cat sig/gpg.log >&2; fail "OpenPGP signature on SHASUMS256.txt.asc (signer must be $fpr)"; }
echo "ok: SHASUMS256.txt.asc good signature, asserted signer $fpr" >&2

signed_zip=$(grep " $asset\$" sig/SHASUMS256.verified.txt | cut -d' ' -f1)
got_zip=$(sha256 "$asset")
[ "$got_zip" = "$signed_zip" ] || fail "$asset sha256 $got_zip != signed $signed_zip"
[ "$got_zip" = "$want_zip" ] || fail "$asset sha256 $got_zip != pin $want_zip"
echo "ok: $asset sha256 $got_zip (signed checksum == pin)" >&2

rm -rf extract && mkdir extract && unzip -q "$asset" -d extract
got_bin=$(sha256 "extract/$binpath")
[ "$got_bin" = "$want_bin" ] || fail "binary sha256 $got_bin != pin $want_bin"
echo "ok: $binpath sha256 $got_bin == pin" >&2

if [ -n "$install" ]; then
  mkdir -p "$install"; cp "extract/$binpath" "$install/bun"; chmod 755 "$install/bun"
  [ "$(sha256 "$install/bun")" = "$want_bin" ] || fail "installed copy hash changed"
  echo "installed: $install/bun" >&2
fi
echo "VERIFIED bun $(get version) $plat"
