#!/usr/bin/env bash
# Answer "can this change affect executable code?" for jobs that are too heavy to run on prose.
#
# Why this exists: `ci.yml` no longer filters `pull_request` by path. Branch protection requires
# `market-index` and `verify-changed`, and a workflow that never triggers reports neither, so a
# `.mailmap`-only (or docs-only) PR sat at "Expected — waiting for status to be reported" and
# could not merge. Always triggering is the fix; this script keeps the cost of that honest by
# letting the one code-only job skip a prose-only PR instead of re-introducing a trigger filter.
#
# FAIL-OPEN BY CONSTRUCTION: anything not recognised as prose/metadata counts as code. A wrong
# "skip" would hide a real gate. A wrong "run" only costs runner minutes, so every unknown —
# an unrecognised extension, a diff error, a shallow base — resolves to run=true.
#
# Emits `run=true|false` to $GITHUB_OUTPUT when set (GitHub Actions step output); always prints
# the decision and the files that forced it, so a reviewer can check the call in the job log.
set -uo pipefail

ROOT=$(git -C "${BASH_SOURCE%/*}/../.." rev-parse --show-toplevel) || {
  echo "changed-code: not a git checkout; treating as code"
  exit 0
}
cd "$ROOT" || exit 0

emit() {
  local run="$1"
  echo "changed-code: run=$run range=${RANGE:-none}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "run=$run" >>"$GITHUB_OUTPUT"
  fi
}

# Same range resolution as scripts/ci/test-changed-plugins.sh: PR base ref, else the push's
# previous tip, else the parent commit for a local run.
if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  git fetch origin "$GITHUB_BASE_REF" --depth=1 2>/dev/null || true
  RANGE="origin/${GITHUB_BASE_REF}...HEAD"
elif [[ -n "${GITHUB_EVENT_BEFORE:-}" && ! "${GITHUB_EVENT_BEFORE}" =~ ^0+$ ]] \
  && git rev-parse --verify -q "${GITHUB_EVENT_BEFORE}^{commit}" >/dev/null; then
  RANGE="${GITHUB_EVENT_BEFORE}..HEAD"
elif git rev-parse --verify -q 'HEAD^' >/dev/null; then
  RANGE="HEAD^..HEAD"
else
  echo "changed-code: no base to diff against; treating as code"
  emit true
  exit 0
fi

if ! CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null); then
  echo "changed-code: git diff failed for $RANGE; treating as code"
  emit true
  exit 0
fi

if [[ -z "${CHANGED//[[:space:]]/}" ]]; then
  echo "changed-code: no files changed; nothing to run"
  emit false
  exit 0
fi

# Prose and metadata only. Deliberately NOT here: .gitattributes (line-ending and LFS semantics
# change what gets checked out), any *.sh/*.ts, and every config that tests read.
code=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    docs/* | *.md | .mailmap | .gitignore | LICENSE | LICENSE.*)
      ;;
    # `*.md` above already covers issue/PR template prose; this catches the .yml/.yaml forms.
    .github/ISSUE_TEMPLATE/* | .github/PULL_REQUEST_TEMPLATE*)
      ;;
    *)
      code+=("$f")
      ;;
  esac
done <<<"$CHANGED"

if [[ ${#code[@]} -eq 0 ]]; then
  echo "changed-code: every changed file is prose/metadata"
  emit false
else
  echo "changed-code: ${#code[@]} executable path(s) changed:"
  printf '  %s\n' "${code[@]}"
  emit true
fi
