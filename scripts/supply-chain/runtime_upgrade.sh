#!/bin/sh
# Staged Bun upgrade gate: pin N (toolchain/bun.pin.json) -> candidate N+1.
# See docs/runtime-upgrade.md. Read-only: it never edits the pin, .bun-version or CI.
#
#   sh scripts/supply-chain/runtime_upgrade.sh --candidate /path/to/bun [--accept ID]... [--out DIR] [--skip-install]
#
# Stage 1  pinned baseline: the current pin must verify (toolchain/verify-bun.sh) and every
#          envelope in toolchain/envelopes must replay byte-identically on it. If the baseline
#          is not green the gate stops: a red baseline cannot judge a candidate.
# Stage 2  candidate replay: the same envelopes on the candidate binary (cross-runtime replay).
# Stage 3  verdict: PROMOTE-ELIGIBLE only if every envelope matches, or differs only in
#          envelopes named with --accept (a human-reviewed, recorded behavior change).
#          Anything else: BLOCK, with the normalized diffs saved under --out.
# Promotion itself stays manual: candidate must be a signed release; re-derive the pin with
# toolchain/fetch-and-verify-bun.sh, bump .bun-version, re-capture envelopes, then re-run this.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
cand="" out="" accept="" skip_install=0
while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) cand=$2; shift 2 ;;
    --accept) accept="$accept $2"; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --skip-install) skip_install=1; shift ;;
    *) echo "usage: $0 --candidate BUN [--accept ID]... [--out DIR] [--skip-install]" >&2; exit 2 ;;
  esac
done
[ -n "$cand" ] && [ -x "$cand" ] || { echo "runtime_upgrade: --candidate must be an executable bun" >&2; exit 2; }
out=${out:-$(mktemp -d)}; mkdir -p "$out/pinned" "$out/candidate"
envs=$(ls "$repo"/toolchain/envelopes/*.envelope.json)
if [ "$skip_install" = 1 ]; then envs=$(echo "$envs" | grep -v '/install-repro\.envelope\.json$'); fi

echo "== stage 0: identify"
pinned=$(sh "$repo/toolchain/verify-bun.sh" --print-path) || { echo "BLOCK: the bun on PATH is not the pinned runtime; fix the baseline first" >&2; exit 1; }
csha=$(sha256sum "$cand" | cut -d' ' -f1)
echo "pinned:    $pinned"
echo "candidate: $cand sha256=$csha"
if DX_BUN_BIN=$cand sh "$repo/toolchain/verify-bun.sh" --quiet 2>/dev/null; then echo "note: candidate IS the pinned binary"; fi

echo "== stage 1: pinned baseline"
# shellcheck disable=SC2086
python3 "$repo/scripts/supply-chain/rerun.py" verify-all --bun "$pinned" --out-dir "$out/pinned" --json $envs > "$out/pinned.json" 2>"$out/pinned.err" || true
python3 - "$out/pinned.json" <<'PY' || { echo "BLOCK: baseline is not green on the pinned runtime" >&2; exit 1; }
import json,sys
r=json.load(open(sys.argv[1])); bad=[x["envelope"] for x in r if not x["verified"]]
for x in r: print(("PASS " if x["verified"] else "FAIL ")+x["envelope"], x["actual"]["summary"])
sys.exit(1 if bad else 0)
PY

echo "== stage 2: candidate replay"
# shellcheck disable=SC2086
python3 "$repo/scripts/supply-chain/rerun.py" verify-all --bun "$cand" --out-dir "$out/candidate" --json $envs > "$out/candidate.json" 2>"$out/candidate.err" || true

echo "== stage 3: verdict"
python3 - "$out/candidate.json" "$accept" "$out" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); accept=set(sys.argv[2].split()); out=sys.argv[3]
blocking, accepted = [], []
for x in r:
    eid = x["envelope"].replace(".envelope.json","")
    state = "MATCH" if x["verified"] else ("ACCEPTED-DIFF" if eid in accept else "DIFF")
    print(f"{state:13} {eid} exit={x['actual']['exit_code']} {x['actual']['summary']}")
    for w in x.get("warnings", []): print(f"              warn: {w}")
    if not x["verified"]:
        (accepted if eid in accept else blocking).append(eid)
        if x.get("diff"):
            open(f"{out}/{eid}.diff","w").write("\n".join(x["diff"])+"\n")
            for l in x["diff"][:25]: print("              " + l)
verdict = "BLOCK" if blocking else "PROMOTE-ELIGIBLE"
json.dump({"verdict": verdict, "blocking": blocking, "accepted": accepted}, open(f"{out}/verdict.json","w"), indent=2)
print(f"VERDICT: {verdict}" + (f" (blocking: {', '.join(blocking)})" if blocking else "") + (f" (accepted diffs: {', '.join(accepted)})" if accepted else ""))
print(f"report: {out}")
sys.exit(1 if blocking else 0)
PY
