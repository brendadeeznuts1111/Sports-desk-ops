#!/usr/bin/env bash
# Run the existing offline catalog check once, with process-scoped CPU samples.
set -euo pipefail
trace_dir=${RUNNER_TEMP:?}/catalog-trace
symbol_dir=${RUNNER_TEMP}/catalog-symbols
mkdir -p "$trace_dir" "$symbol_dir"
docker build --build-arg "BASE_IMAGE=${IMAGE:?}" -t sportsdesk-catalog-trace - <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apk add --no-cache git perf binutils
DOCKERFILE
docker run --rm -v "$PWD:/desk" -w /desk --entrypoint bun sportsdesk-catalog-trace ci --no-env-file
archive="$symbol_dir/profile.zip"
curl -fsSL --retry 3 -o "$archive" https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-linux-x64-musl-baseline-profile.zip
echo "312f29a5b7a5da87346ad07967aacfb0a7068debbab6d7241a0c770883906054  $archive" | sha256sum -c -
unzip -jp "$archive" bun-linux-x64-musl-baseline-profile/bun-profile > "$symbol_dir/bun-profile"
chmod 755 "$symbol_dir/bun-profile"
mounts=(--rm --network none -v "$PWD:/desk:ro" -w /desk -v "$trace_dir:/trace" --entrypoint sh)
# This release is ET_EXEC. Its matching symbol file supplies the linked virtual
# addresses for three per-task x86 execution counters. No host probe registry.
docker run --rm --entrypoint cat sportsdesk-catalog-trace /usr/local/bin/bun > "$symbol_dir/bun"
build_id() { readelf -n "$1" | awk '/Build ID:/ {print $3}'; }
runtime_id=$(build_id "$symbol_dir/bun")
test -n "$runtime_id"
test "$runtime_id" = "$(build_id "$symbol_dir/bun-profile")"
readelf -h "$symbol_dir/bun" | grep -Eq 'Type: +EXEC '
nm --defined-only "$symbol_dir/bun-profile" > "$symbol_dir/symbols"
entry_address() {
  local address
  address=$(awk -v s="$1" '$3 == s {print $1}' "$symbol_dir/symbols")
  [[ $address =~ ^[[:xdigit:]]+$ ]] || return 1
  printf '0x%x' "$((16#$address))"
}
concurrent=$(entry_address _ZN3JSC9Collector18runConcurrentPhaseENS_11GCConductorE)
transition=$(entry_address _ZN3JSC9Collector19finishChangingPhaseENS_11GCConductorE)
visit=$(entry_address _ZN3JSC9CodeBlock13visitChildrenEPNS_6JSCellERNS_11SlotVisitorE)
printf 'concurrent %s\ntransition %s\nvisit %s\n' "$concurrent" "$transition" "$visit" > "$trace_dir/events.txt"
docker run "${mounts[@]}" --cap-add PERFMON -e "BUILD_ID=$runtime_id" \
  -e "CONCURRENT=$concurrent" -e "TRANSITION=$transition" -e "VISIT=$visit" sportsdesk-catalog-trace -ec '
  test -e /lib/ld-musl-x86_64.so.1
  test "$(bun --revision)" = 1.4.5+a7733435c
  echo "Build ID: $BUILD_ID"
  cat /etc/alpine-release
  git config --global --add safe.directory /desk
  export SPORTSDESK_TRACE_CATALOG=1 BUN_JSC_logGC=1 NO_COLOR=1
  exec perf record --clockid mono -c 1 -e cpu-clock/freq=499/u \
    -e "mem:$CONCURRENT:x" -e "mem:$TRANSITION:x" -e "mem:$VISIT:x" \
    -o /trace/catalog.perf.data -- bun scripts/bun_shape_contracts.ts --check
' > "$trace_dir/catalog.log" 2>&1 || { tail -30 "$trace_dir/catalog.log"; exit 1; }
# Resolve addresses with the matching release symbols only after the measured process exits.
docker run "${mounts[@]}" -v "$symbol_dir/bun-profile:/usr/local/bin/bun:ro" sportsdesk-catalog-trace -ec '
  chmod a+r /trace/catalog.perf.data
  perf script -i /trace/catalog.perf.data --ns --show-lost-events -F pid,tid,time,event,ip,sym,dso > /trace/samples.txt
  chmod a+r /trace/samples.txt
'
