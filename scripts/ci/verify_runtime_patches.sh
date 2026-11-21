#!/usr/bin/env bash
# Check the reviewed sources for the Bun revision reported by the platform runner.
set -euo pipefail
bun_revision=${1:?pass the full Bun.revision}
[[ $bun_revision =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid Bun revision" >&2; exit 1; }
bun_source="https://raw.githubusercontent.com/oven-sh/bun/$bun_revision"

read_source() {
  curl --fail --silent --show-error --location --retry 3 --max-time 30 "$1"
}

verify_blob() {
  local source_url=$1 expected_blob=$2 actual_blob
  actual_blob=$(read_source "$source_url" | git hash-object --stdin)
  if [[ $actual_blob != "$expected_blob" ]]; then
    echo "Review $source_url: expected $expected_blob, found $actual_blob" >&2
    return 1
  fi
  echo "$actual_blob  $source_url"
}

# 3044dc6834: both registration-error branches relinquish the new poll and
# close_without_closing_fd leaves the caller's descriptor open.
verify_blob "$bun_source/src/io/PipeWriter.rs" 4c9688d87a8bcdfa73ebf310deea416bb820ed1d
verify_blob "$bun_source/src/io/pipes.rs" 5cc50a9079e6fbf2f9c01ef090880c7c24b9dab8

# Follow the WebKit dependency actually declared by this Bun revision.
webkit_revision=$(read_source "$bun_source/scripts/build/deps/webkit.ts" |
  sed -nE 's/^export const WEBKIT_VERSION = "([0-9a-f]{40})";$/\1/p')
[[ $webkit_revision =~ ^[0-9a-f]{40}$ ]] || { echo "Missing or ambiguous WebKit pin" >&2; exit 1; }
jsc_source="https://raw.githubusercontent.com/oven-sh/WebKit/$webkit_revision/Source/JavaScriptCore/runtime"
# 2e2aa2290fac: GC-safe slot clearing and the publication fence in the shipped engine.
verify_blob "$jsc_source/JSArray.cpp" 48216c90180dd84380636959d5ed099a06dcc10b
verify_blob "$jsc_source/JSObject.cpp" 6f4a65c8fe4657a9a18ebc74c92a7fdfdb0809fa
