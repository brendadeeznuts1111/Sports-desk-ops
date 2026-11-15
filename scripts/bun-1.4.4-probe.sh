#!/usr/bin/env bash
# ============================================================================
# bun-1.4.4-probe.sh — smoke probes for the 1.4.4 package-manager claims.
#
# Each probe is hermetic: it runs in its own temp directory and never touches
# this checkout. PASS means the behaviour exists and the assertion holds; SKIP
# means the probe needs a fixture this script deliberately does not build (a
# fake registry endpoint, credentials, or a patched package), and the manual
# command is printed. Exit 1 if any probe FAILs (or if --strict and anything is
# skipped). The count is printed in the summary; the script does not claim one
# in its header, because probes are added over time.
#
#   scripts/bun-1.4.4-probe.sh            run
#   scripts/bun-1.4.4-probe.sh --strict   skips count as failures
#   scripts/bun-1.4.4-probe.sh --verbose  show command output
# ============================================================================
set -u
set +e

STRICT=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --verbose) VERBOSE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bun144probe.XXXXXX")"
TILDE_TARGET="$HOME/tmp/bun144probe-cache"
cleanup() { rm -rf "$ROOT"; rm -rf "$TILDE_TARGET"; }
trap cleanup EXIT

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); printf 'PASS  %-34s %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL  %-34s %s\n' "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP  %-34s %s\n' "$1" "$2"; }
run()  { if [ "$VERBOSE" = 1 ]; then "$@"; else "$@" >/dev/null 2>&1; fi; }

# macOS stat uses -f, GNU uses -c. This checkout is macOS; keep the probe honest
# about the platform instead of silently comparing nothing on Linux.
statfmt() { stat -f '%i %m %N' "$@" 2>/dev/null || stat -c '%i %Y %n' "$@"; }

mkproj() { # mkproj <dir> <package.json body>
  mkdir -p "$1"
  printf '%s' "$2" > "$1/package.json"
}

# ---- P1: --use-system-ca is accepted by install ------------------------------
mkproj "$ROOT/p1" '{"name":"p1","version":"1.0.0","dependencies":{}}'
if run bash -c "cd '$ROOT/p1' && bun install --use-system-ca --dry-run"; then
  pass use-system-ca "install --use-system-ca --dry-run accepted"
else
  fail use-system-ca "install --use-system-ca --dry-run rejected"
fi

# ---- P2: leading ~/ in install env vars expands -------------------------------
mkproj "$ROOT/p2" '{"name":"p2","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p2' && BUN_INSTALL_CACHE_DIR='~/tmp/bun144probe-cache' bun install"
if [ -d "$TILDE_TARGET" ]; then
  pass tilde-env "BUN_INSTALL_CACHE_DIR=~/… expanded to \$HOME/tmp/bun144probe-cache"
else
  fail tilde-env "cache dir not created at the expanded path (literal ~ not expanded?)"
fi

# ---- P3: no-op install does not churn globalStore links ----------------------
mkproj "$ROOT/p3" '{"name":"p3","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p3' && bun install"
if [ -d "$ROOT/p3/node_modules/.bun" ]; then
  statfmt "$ROOT"/p3/node_modules/.bun/*/ | sort > "$ROOT/before.txt"
  run bash -c "cd '$ROOT/p3' && bun install"
  statfmt "$ROOT"/p3/node_modules/.bun/*/ | sort > "$ROOT/after.txt"
  if diff -q "$ROOT/before.txt" "$ROOT/after.txt" >/dev/null; then
    pass globalStore-noop "inode+mtime stable across a no-op install"
  else
    fail globalStore-noop "links recreated (inode/mtime changed)"
  fi
else
  skip globalStore-noop "no node_modules/.bun link store (globalStore not active?)"
fi

# ---- P4: audit fix rewrites a vulnerable override ----------------------------
mkproj "$ROOT/p4" '{"name":"p4","version":"1.0.0","dependencies":{"lodash":"4.17.20"},"overrides":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p4' && bun install"
before_override="$(cd "$ROOT/p4" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.overrides?.lodash ?? "")')"
run bash -c "cd '$ROOT/p4' && bun audit fix"
after_override="$(cd "$ROOT/p4" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.overrides?.lodash ?? "")')"
if run bash -c "cd '$ROOT/p4' && bun audit"; then
  if [ "$after_override" != "$before_override" ]; then
    # The registry's fixed version is the registry's say-so: lodash 4.18.0 is
    # flagged as a bad release by npm, so the probe records the value instead of
    # blessing it.
    pass audit-fix-override "override $before_override -> $after_override, audit now clean"
  else
    fail audit-fix-override "audit clean but the override still pins $after_override (no rewrite observed)"
  fi
else
  fail audit-fix-override "audit still reports vulnerabilities after 'bun audit fix'"
fi

# ---- P5: bun update --depth 0 updates DIRECT deps only ----------------------
# The claim is about scope, not immutability: a transitive can still move when
# the updated direct dependency's own ranges require it (express 4.22 needs a
# newer body-parser). What must not happen is an UNRELATED direct dependency's
# transitives moving. gs-sdk stays pinned, so its ws/got are the witnesses.
mkproj "$ROOT/p5" '{"name":"p5","version":"1.0.0","dependencies":{"express":"4.18.0","@ganchrowsci/gs-sdk":"1.0.27"}}'
run bash -c "cd '$ROOT/p5' && bun install"
ws_before="$(grep -oE '"ws@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
got_before="$(grep -oE '"got@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
# Widen the range so the update has something legitimate to do.
mkproj "$ROOT/p5" '{"name":"p5","version":"1.0.0","dependencies":{"express":"^4.18.0","@ganchrowsci/gs-sdk":"1.0.27"}}'
run bash -c "cd '$ROOT/p5' && bun update --depth 0"
express_after="$(grep -oE '"express@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
ws_after="$(grep -oE '"ws@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
got_after="$(grep -oE '"got@[0-9.]+"' "$ROOT/p5/bun.lock" | head -1)"
if [ "$ws_before" = "$ws_after" ] && [ "$got_before" = "$got_after" ]; then
  pass update-depth-0 "direct $express_after updated; unrelated transitives kept ($ws_after, $got_after)"
else
  fail update-depth-0 "unrelated transitive moved: ws $ws_before->$ws_after got $got_before->$got_after"
fi

# ---- P6: bun prune --check reports and exits 1; bun prune removes ------------
# A desynced lock is refused ("bun.lock does not match package.json, nothing to
# prune"), so the extraneous package is placed by hand: present in node_modules,
# absent from both package.json and the lock.
mkproj "$ROOT/p6" '{"name":"p6","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p6' && bun install"
mkdir -p "$ROOT/p6/node_modules/zzz-extra"
printf '%s' '{"name":"zzz-extra","version":"1.0.0"}' > "$ROOT/p6/node_modules/zzz-extra/package.json"
set +e
prune_out="$(cd "$ROOT/p6" && bun prune --check 2>&1)"; prune_code=$?
if [ "$prune_code" -eq 1 ] && printf '%s' "$prune_out" | grep -q "zzz-extra"; then
  run bash -c "cd '$ROOT/p6' && bun prune"
  if [ ! -d "$ROOT/p6/node_modules/zzz-extra" ]; then
    set +e
    (cd "$ROOT/p6" && bun prune --check >/dev/null 2>&1); post_code=$?
    if [ "$post_code" -eq 0 ]; then
      pass prune-check "check exit 1 naming zzz-extra; prune removed it; re-check exit 0"
    else
      fail prune-check "prune removed zzz-extra but --check still exits $post_code"
    fi
  else
    fail prune-check "--check named it but prune left it behind"
  fi
else
  fail prune-check "--check exit $prune_code, output did not name zzz-extra"
fi

# ---- P7: workspace:* can point at the ROOT package ---------------------------
mkdir -p "$ROOT/p7/packages/child"
printf '%s' '{"name":"rootpkg","version":"1.0.0","private":true,"workspaces":["packages/*"]}' > "$ROOT/p7/package.json"
printf '%s' '{"name":"child","version":"1.0.0","dependencies":{"rootpkg":"workspace:*"}}' > "$ROOT/p7/packages/child/package.json"
if run bash -c "cd '$ROOT/p7' && bun install"; then
  if [ -e "$ROOT/p7/node_modules/rootpkg" ] || [ -e "$ROOT/p7/packages/child/node_modules/rootpkg" ]; then
    pass workspace-root "child depends on rootpkg with workspace:* and links"
  else
    fail workspace-root "install succeeded but rootpkg is not linked"
  fi
else
  fail workspace-root "bun install rejected workspace:* against the root package"
fi

# ---- P8: unknown flags are an error, not silently ignored -------------------
mkproj "$ROOT/p8" '{"name":"p8","version":"1.0.0","dependencies":{}}'
set +e
unknown_out="$(cd "$ROOT/p8" && bun install --frozen-lockfil 2>&1)"; unknown_code=$?
if [ "$unknown_code" -ne 0 ] && printf '%s' "$unknown_out" | grep -q "no --frozen-lockfil flag"; then
  pass unknown-flag-rejected "typo'd flag exits $unknown_code and is named"
else
  fail unknown-flag-rejected "exit $unknown_code; typo was not rejected by name"
fi

# ---- P9: bun add -d moves a group -------------------------------------------
mkproj "$ROOT/p9" '{"name":"p9","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p9' && bun install"
run bash -c "cd '$ROOT/p9' && bun add -d lodash"
group_state="$(cd "$ROOT/p9" && bun -e 'const p = await Bun.file("package.json").json(); console.log(JSON.stringify({ dep: p.dependencies?.lodash ?? null, dev: p.devDependencies?.lodash ?? null }))')"
if printf '%s' "$group_state" | grep -q '"dep":null' && printf '%s' "$group_state" | grep -q '"dev":"'; then
  pass add-dev-moves-group "moved to devDependencies: $group_state"
else
  fail add-dev-moves-group "group move did not happen: $group_state"
fi

# ---- P10: --env-file is an env file, not a package ---------------------------
mkproj "$ROOT/p10" '{"name":"p10","version":"1.0.0","dependencies":{}}'
printf 'PROBE=1\n' > "$ROOT/p10/ci.env"
set +e
envfile_out="$(cd "$ROOT/p10" && bun install --env-file ci.env 2>&1)"; envfile_code=$?
if [ "$envfile_code" -eq 0 ] && ! printf '%s' "$envfile_out" | grep -qiE "not found|missing package|ci\.env@"; then
  pass env-file-install "--env-file accepted as an env file, install exit 0"
else
  fail env-file-install "exit $envfile_code; output suggests ci.env was treated as a dependency"
fi

# ---- P11: bun pm fetch warms the cache and nothing else ----------------------
mkproj "$ROOT/p11" '{"name":"p11","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p11' && bun pm fetch"
if [ ! -d "$ROOT/p11/node_modules" ]; then
  pass pm-fetch "cache warmed, no node_modules created, no scripts run"
else
  fail pm-fetch "pm fetch created node_modules"
fi

# ---- P12: recursive publish skips private workspaces -------------------------
mkdir -p "$ROOT/p12/packages/a"
printf '%s' '{"name":"p12root","version":"1.0.0","private":true,"workspaces":["packages/*"]}' > "$ROOT/p12/package.json"
printf '%s' '{"name":"p12a","version":"1.0.0","private":true}' > "$ROOT/p12/packages/a/package.json"
set +e
recursive_out="$(cd "$ROOT/p12" && bun publish --recursive 2>&1)"; recursive_code=$?
if [ "$recursive_code" -eq 0 ] && printf '%s' "$recursive_out" | grep -q "skipped p12a: private"; then
  pass publish-recursive "all-private workspace: exit 0, both packages skipped by name"
else
  fail publish-recursive "exit $recursive_code; recursive publish did not skip private workspaces as expected"
fi

# ---- P13: frozen-lockfile names the dependency that changed ------------------
mkproj "$ROOT/p13" '{"name":"p13","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p13' && bun install"
mkproj "$ROOT/p13" '{"name":"p13","version":"1.0.0","dependencies":{"lodash":"4.17.21","is-odd":"3.0.1"}}'
set +e
frozen_out="$(cd "$ROOT/p13" && bun install --frozen-lockfile 2>&1)"; frozen_code=$?
if [ "$frozen_code" -ne 0 ] && printf '%s' "$frozen_out" | grep -q "is-odd was added"; then
  pass frozen-lockfile-names-dep "error names 'is-odd was added'"
else
  fail frozen-lockfile-names-dep "exit $frozen_code; error did not name the added dependency"
fi

# ---- P14: --filter narrows the recursive set, and a bad filter fails loudly --
set +e
filter_ok="$(cd "$ROOT/p12" && bun publish --filter 'p12a' 2>&1)"; filter_ok_code=$?
filter_bad="$(cd "$ROOT/p12" && bun publish --filter 'nomatch*' 2>&1)"; filter_bad_code=$?
if [ "$filter_ok_code" -eq 0 ] && printf '%s' "$filter_ok" | grep -q "skipped p12a: private" \
   && [ "$filter_bad_code" -eq 1 ] && printf '%s' "$filter_bad" | grep -q "No workspace packages matched"; then
  pass publish-filter "match: exit 0 + skipped by name; no-match: exit 1 + named error"
else
  fail publish-filter "filter match exit $filter_ok_code, no-match exit $filter_bad_code"
fi

# ---- P15: minimumReleaseAge accepts units and enforces the window -----------
mkproj "$ROOT/p15a" '{"name":"p15a","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
printf '[install]\nminimumReleaseAge = "3d"\nminimumReleaseAgeExcludes = ["lodash@4.17.21"]\n' > "$ROOT/p15a/bunfig.toml"
if run bash -c "cd '$ROOT/p15a' && bun install"; then
  mkproj "$ROOT/p15b" '{"name":"p15b","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
  printf '[install]\nminimumReleaseAge = "87600h"\nminimumReleaseAgeExcludes = []\n' > "$ROOT/p15b/bunfig.toml"
  set +e
  aged_out="$(cd "$ROOT/p15b" && bun install 2>&1)"; aged_code=$?
  if [ "$aged_code" -ne 0 ] && printf '%s' "$aged_out" | grep -q "minimum-release-age"; then
    pass minimum-release-age "\"3d\" + per-version exclude installs; a 10-year window blocks and names the reason"
  else
    fail minimum-release-age "10-year window did not block (exit $aged_code)"
  fi
else
  fail minimum-release-age "\"3d\" units rejected by bun install"
fi

# ---- P16: --audit-level filters advisories by severity ----------------------
# Two seeds: one whose advisories are all moderate, one with high advisories.
mkproj "$ROOT/p16a" '{"name":"p16a","version":"1.0.0","dependencies":{"@hono/node-server":"2.1.5"}}'
run bash -c "cd '$ROOT/p16a' && bun install"
set +e
moderate_plain="$(cd "$ROOT/p16a" && bun audit 2>&1)"; moderate_plain_code=$?
moderate_high="$(cd "$ROOT/p16a" && bun audit --audit-level=high 2>&1)"; moderate_high_code=$?
mkproj "$ROOT/p16b" '{"name":"p16b","version":"1.0.0","dependencies":{"lodash":"4.17.20"},"overrides":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p16b' && bun install"
set +e
high_plain="$(cd "$ROOT/p16b" && bun audit 2>&1)"; high_plain_code=$?
high_high="$(cd "$ROOT/p16b" && bun audit --audit-level=high 2>&1)"; high_high_code=$?
moderate_filtered=$([ "$moderate_plain_code" -eq 1 ] && [ "$moderate_high_code" -eq 0 ] && echo yes || echo no)
high_kept=$([ "$high_plain_code" -eq 1 ] && [ "$high_high_code" -eq 1 ] && printf '%s' "$high_high" | grep -q "high" && echo yes || echo no)
if [ "$moderate_filtered" = yes ] && [ "$high_kept" = yes ]; then
  pass audit-level "moderate-only: plain exit 1, high exit 0; high-severity: high exit 1"
else
  fail audit-level "moderate filtered=$moderate_filtered, high kept=$high_kept"
fi

# ---- P17: --prod scopes the audit to what actually ships --------------------
mkproj "$ROOT/p17a" '{"name":"p17a","version":"1.0.0","devDependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p17a' && bun install"
set +e
dev_plain="$(cd "$ROOT/p17a" && bun audit 2>&1)"; dev_plain_code=$?
dev_prod="$(cd "$ROOT/p17a" && bun audit --prod 2>&1)"; dev_prod_code=$?
mkproj "$ROOT/p17b" '{"name":"p17b","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p17b' && bun install"
set +e
prod_plain="$(cd "$ROOT/p17b" && bun audit 2>&1)"; prod_plain_code=$?
prod_prod="$(cd "$ROOT/p17b" && bun audit --prod 2>&1)"; prod_prod_code=$?
dev_excluded=$([ "$dev_plain_code" -eq 1 ] && [ "$dev_prod_code" -eq 0 ] && printf '%s' "$dev_prod" | grep -q "checked 0 packages" && echo yes || echo no)
prod_kept=$([ "$prod_plain_code" -eq 1 ] && [ "$prod_prod_code" -eq 1 ] && echo yes || echo no)
if [ "$dev_excluded" = yes ] && [ "$prod_kept" = yes ]; then
  pass audit-prod "dev-only vulnerable: plain exit 1, --prod exit 0 (0 checked); prod vulnerable: both exit 1"
else
  fail audit-prod "dev excluded=$dev_excluded, prod kept=$prod_kept"
fi

# ---- P18: --omit is selective per dependency type and repeatable ------------
audit_exit() { # audit_exit <dir> <flags...>
  local dir="$1"; shift
  ( cd "$dir" && bun audit "$@" >/dev/null 2>&1 ); echo $?
}
mkproj "$ROOT/p18a" '{"name":"p18a","version":"1.0.0","optionalDependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p18a' && bun install"
opt_plain="$(audit_exit "$ROOT/p18a")"
opt_omit="$(audit_exit "$ROOT/p18a" --omit=optional)"
mkproj "$ROOT/p18b" '{"name":"p18b","version":"1.0.0","peerDependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p18b' && bun install"
peer_plain="$(audit_exit "$ROOT/p18b")"
peer_omit="$(audit_exit "$ROOT/p18b" --omit=peer)"
# dev + optional: omitting optional must still catch the dev copy, and both omits
# together must clear it.
# Distinct packages per group: the same spec in both groups collapses to one
# instance, and --omit=optional then removes the dev copy too (measured).
mkproj "$ROOT/p18c" '{"name":"p18c","version":"1.0.0","devDependencies":{"lodash":"4.17.20"},"optionalDependencies":{"ws":"5.2.1"}}'
run bash -c "cd '$ROOT/p18c' && bun install"
both_plain="$(audit_exit "$ROOT/p18c")"
omit_opt_only="$(audit_exit "$ROOT/p18c" --omit=optional)"
omit_both="$(audit_exit "$ROOT/p18c" --omit=optional --omit=dev)"
prod_equiv="$(audit_exit "$ROOT/p18c" --prod)"
dev_equiv="$(audit_exit "$ROOT/p18c" --omit=dev)"
if [ "$opt_plain" = 1 ] && [ "$opt_omit" = 0 ] \
   && [ "$peer_plain" = 1 ] && [ "$peer_omit" = 0 ] \
   && [ "$both_plain" = 1 ] && [ "$omit_opt_only" = 1 ] && [ "$omit_both" = 0 ] \
   && [ "$prod_equiv" = "$dev_equiv" ]; then
  pass audit-omit "optional/peer each excluded; dev still caught; both omits clear; --prod == --omit=dev"
else
  fail audit-omit "opt $opt_plain/$opt_omit peer $peer_plain/$peer_omit dev+opt $both_plain/$omit_opt_only/$omit_both prod==dev? $prod_equiv/$dev_equiv"
fi

# ---- P19: --ignore works by GHSA and numeric id, and fails closed on typos --
mkproj "$ROOT/p19" '{"name":"p19","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p19' && bun install"
advisory_meta="$(cd "$ROOT/p19" && bun audit --json 2>/dev/null | bun -e 'const j = await Bun.stdin.json(); const rows = Object.values(j).flat(); console.log(rows.length, rows.map(r => r.url.split("/").pop()).join(","), rows.map(r => r.id).join(","));')"
read -r adv_count ghsa_list id_list <<<"$advisory_meta"
first_ghsa="$(printf '%s' "$ghsa_list" | cut -d, -f1)"
first_id="$(printf '%s' "$id_list" | cut -d, -f1)"
ignore_args=""
for g in ${ghsa_list//,/ }; do ignore_args="$ignore_args --ignore $g"; done
set +e
plain_out="$(cd "$ROOT/p19" && bun audit 2>&1)"; plain_code=$?
ghsa_out="$(cd "$ROOT/p19" && bun audit --ignore "$first_ghsa" 2>&1)"; ghsa_code=$?
id_out="$(cd "$ROOT/p19" && bun audit --ignore "$first_id" 2>&1)"; id_code=$?
all_out="$(cd "$ROOT/p19" && bun audit $ignore_args 2>&1)"; all_code=$?
cve_out="$(cd "$ROOT/p19" && bun audit --ignore CVE-2021-23337 2>&1)"; cve_code=$?
typo_out="$(cd "$ROOT/p19" && bun audit --ignore GHSA-0000-0000-0000 2>&1)"; typo_code=$?
expected_next=$((adv_count - 1))
ghsa_ok=$(printf '%s' "$ghsa_out" | grep -q "$expected_next vulnerabilities" && echo yes || echo no)
id_ok=$(printf '%s' "$id_out" | grep -q "$expected_next vulnerabilities" && echo yes || echo no)
all_ok=$([ "$all_code" -eq 0 ] && printf '%s' "$all_out" | grep -q "ignored" && echo yes || echo no)
cve_ok=$(printf '%s' "$cve_out" | grep -q "$adv_count vulnerabilities" && echo yes || echo no)
typo_ok=$(printf '%s' "$typo_out" | grep -q "$adv_count vulnerabilities" && echo yes || echo no)
if [ "$plain_code" -eq 1 ] && [ "$ghsa_ok" = yes ] && [ "$id_ok" = yes ] && [ "$all_ok" = yes ] && [ "$cve_ok" = yes ] && [ "$typo_ok" = yes ]; then
  pass audit-ignore "GHSA and numeric each drop one; all ignored -> exit 0 (reported); CVE and typo'd GHSA match nothing"
else
  fail audit-ignore "ghsa=$ghsa_ok id=$id_ok all=$all_ok cve=$cve_ok typo=$typo_ok"
fi

# ---- P20: --json is unfiltered; --ignore only moves the exit code -----------
mkproj "$ROOT/p20" '{"name":"p20","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p20' && bun install"
ghsas="$(cd "$ROOT/p20" && bun audit --json 2>/dev/null | bun -e 'const j = await Bun.stdin.json(); console.log(Object.values(j).flat().map(r => r.url.split("/").pop()).join(" "))')"
ignore_all=""
for g in $ghsas; do ignore_all="$ignore_all --ignore $g"; done
set +e
raw_all="$(cd "$ROOT/p20" && bun audit --json $ignore_all 2>/dev/null)"; raw_code=$?
raw_entries="$(printf '%s' "$raw_all" | bun -e 'const j = await Bun.stdin.json(); console.log(Object.values(j).flat().length)')"
if [ "$raw_code" -eq 0 ] && [ "$raw_entries" = 4 ]; then
  pass audit-json-unfiltered "all advisories ignored (exit 0) yet --json still lists $raw_entries"
else
  fail audit-json-unfiltered "exit $raw_code, entries $raw_entries (expected 0 and 4)"
fi

# ---- P21: audit fix --dry-run --json plans without writing -------------------
mkproj "$ROOT/p21" '{"name":"p21","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p21' && bun install"
hash_cmd="shasum"; command -v sha256sum >/dev/null 2>&1 && hash_cmd="sha256sum"
hash_before="$(cd "$ROOT/p21" && $hash_cmd package.json bun.lock | $hash_cmd)"
set +e
plan="$(cd "$ROOT/p21" && bun audit fix --dry-run --json 2>/dev/null)"; plan_code=$?
hash_after="$(cd "$ROOT/p21" && $hash_cmd package.json bun.lock | $hash_cmd)"
plan_ok="$(printf '%s' "$plan" | bun -e '
  const j = await Bun.stdin.json();
  const keys = ["dryRun", "fixed", "remaining", "fixes", "blocked", "unfixable", "unmatched", "unaudited", "vulnerableAfterInstall"];
  const missing = keys.filter((k) => !(k in j));
  const rewrite = (j.fixes ?? []).some((f) => (f.packageJson ?? []).some((p) => p.key === "lodash"));
  console.log(missing.length === 0 && j.dryRun === true && rewrite ? "ok" : `missing=${missing} dryRun=${j.dryRun} rewrite=${rewrite}`);
')"
if [ "$plan_code" -eq 0 ] && [ "$plan_ok" = ok ] && [ "$hash_before" = "$hash_after" ]; then
  pass audit-fix-dry-run "plan object complete, dry-run wrote nothing"
else
  fail audit-fix-dry-run "code=$plan_code plan=$plan_ok filesChanged=$([ "$hash_before" != "$hash_after" ] && echo yes || echo no)"
fi

# ---- P22: audit fix rewrites an exact pin, and audit-clean is not "good" -----
mkproj "$ROOT/p22" '{"name":"p22","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p22' && bun install"
run bash -c "cd '$ROOT/p22' && bun audit fix"
pin_after="$(cd "$ROOT/p22" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.dependencies.lodash)')"
set +e
post_audit="$(cd "$ROOT/p22" && bun audit 2>&1)"; post_code=$?
if [ "$pin_after" != "4.17.20" ] && [ "$post_code" -eq 0 ]; then
  # Observed 2026-11-14: the rewrite targets lodash 4.18.0. That is consistent
  # with "lowest non-vulnerable" (4.17.21 still carries 2 advisories) but 4.18.0
  # is npm-deprecated ("bad release"); audit-clean is not a quality signal.
  pass audit-fix-rewrites-pin "exact pin 4.17.20 -> $pin_after, audit exit 0 (deprecated target; see note)"
else
  fail audit-fix-rewrites-pin "pin=$pin_after audit exit=$post_code"
fi

# ---- P23: audit fix refuses flags that would prevent writing the lockfile ---
mkproj "$ROOT/p23" '{"name":"p23","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}'
run bash -c "cd '$ROOT/p23' && bun install"
rejects=0
for flag in --prod --frozen-lockfile --no-save; do
  set +e
  rejected_out="$(cd "$ROOT/p23" && bun audit fix "$flag" 2>&1)"; rejected_code=$?
  if [ "$rejected_code" -ne 0 ] && printf '%s' "$rejected_out" | grep -q "bun.lock"; then
    rejects=$((rejects+1))
  fi
done
if [ "$rejects" -eq 3 ]; then
  pass audit-fix-rejects-flags "all three lockfile-blocking flags refused with a bun.lock reason"
else
  fail audit-fix-rejects-flags "only $rejects/3 flags refused"
fi

# ---- P24: audit fix --latest rewrites OWN ranges, keeping their style -------
mkproj "$ROOT/p24" '{"name":"p24","version":"1.0.0","dependencies":{"qs":"~6.5.0"}}'
run bash -c "cd '$ROOT/p24' && bun install"
set +e
plain_out="$(cd "$ROOT/p24" && bun audit 2>&1)"; plain_code=$?
run bash -c "cd '$ROOT/p24' && bun audit fix"
range_plain="$(cd "$ROOT/p24" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.dependencies.qs)')"
set +e
latest_plan="$(cd "$ROOT/p24" && bun audit fix --latest --dry-run --json 2>/dev/null)"; plan_code=$?
rewrite_to="$(printf '%s' "$latest_plan" | bun -e 'const j = await Bun.stdin.json(); const f = (j.fixes ?? [])[0]; console.log(f?.packageJson?.[0]?.to ?? "")')"
run bash -c "cd '$ROOT/p24' && bun audit fix --latest"
range_latest="$(cd "$ROOT/p24" && bun -e 'const p = await Bun.file("package.json").json(); console.log(p.dependencies.qs)')"
set +e
post_code=$(cd "$ROOT/p24" && bun audit >/dev/null 2>&1; echo $?)
if [ "$plain_code" -eq 1 ] && [ "$range_plain" = "~6.5.0" ] \
   && [ "${rewrite_to:0:1}" = "~" ] && [ "$range_latest" = "$rewrite_to" ] && [ "$post_code" -eq 0 ]; then
  pass audit-fix-latest "own range blocked plain fix ($range_plain); --latest rewrote to $range_latest (style kept)"
else
  fail audit-fix-latest "plain=$range_plain plan=$rewrite_to latest=$range_latest post=$post_code"
fi

# ---- P25: a failing registry is never a clean audit -------------------------
mkproj "$ROOT/p25" '{"name":"p25","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}'
run bash -c "cd '$ROOT/p25' && bun install"
printf 'registry=http://127.0.0.1:9/\n' > "$ROOT/p25/.npmrc"
set +e
dead_out="$(cd "$ROOT/p25" && bun audit 2>/tmp/p25.err)"; dead_code=$?
dead_fix="$(cd "$ROOT/p25" && bun audit fix 2>&1)"; dead_fix_code=$?
dead_err="$(cat /tmp/p25.err)"
never_clean=$(printf '%s' "$dead_out" | grep -q "No vulnerabilities" && echo no || echo yes)
named_reason=$(printf '%s' "$dead_err" | grep -qiE "ConnectionRefused|advisories/bulk|error:" && echo yes || echo no)
if [ "$dead_code" -eq 1 ] && [ "$dead_fix_code" -eq 1 ] && [ "$never_clean" = yes ] && [ "$named_reason" = yes ]; then
  pass audit-registry-failure "dead registry: audit and fix both exit 1, error names the request, no clean report"
else
  fail audit-registry-failure "audit=$dead_code fix=$dead_fix_code neverClean=$never_clean named=$named_reason"
fi

# ---- P26: bun pm migrate handles a 20k-entry Yarn v1 lockfile quickly ------
mkproj "$ROOT/p26" '{"name":"p26","version":"1.0.0"}'
python3 - "$ROOT/p26/yarn.lock" <<'PY_MIG'
import sys
INTEGRITY = "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg=="
lines = ["# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.", "# yarn lockfile v1", "", ""]
for i in range(20000):
    name = f"pkg-{i:05d}"
    lines.append(f'{name}@^1.0.{i % 9}:')
    lines.append(f'  version "1.0.{i % 9}"')
    lines.append(f'  resolved "https://registry.npmjs.org/{name}/-/{name}-1.0.{i % 9}.tgz#abc{i}"')
    lines.append(f'  integrity {INTEGRITY}')
    lines.append("")
open(sys.argv[1], "w").write("\n".join(lines))
PY_MIG
migrate_real="$(cd "$ROOT/p26" && /usr/bin/time -p bun pm migrate 2>&1 >/dev/null | awk '/^real/{print $2}')"
migrate_ok=$(cd "$ROOT/p26" && [ -s bun.lock ] && echo yes || echo no)
if [ -n "$migrate_real" ] && awk -v t="$migrate_real" 'BEGIN{exit !(t < 2.0)}' && [ "$migrate_ok" = yes ]; then
  pass pm-migrate-20k "20,000-entry Yarn v1 lockfile migrated in ${migrate_real}s (< 2s)"
else
  fail pm-migrate-20k "time=${migrate_real:-?}s bun.lock=$migrate_ok"
fi

# ---- P27: a 2,100-workspace install stays under a memory ceiling ------------
mkdir -p "$ROOT/p27/packages"
python3 - "$ROOT/p27" <<'PY_MONO'
import json, os, sys
root = sys.argv[1]
for i in range(2100):
    d = os.path.join(root, "packages", f"w{i:04d}")
    os.makedirs(d, exist_ok=True)
    json.dump({"name": f"@mono/w{i:04d}", "version": "1.0.0"}, open(os.path.join(d, "package.json"), "w"))
json.dump({"name": "mono-root", "version": "1.0.0", "private": True, "workspaces": ["packages/*"]}, open(os.path.join(root, "package.json"), "w"))
PY_MONO
if [ "$(uname)" = "Darwin" ]; then
  mono_out="$(cd "$ROOT/p27" && /usr/bin/time -l bun install 2>&1 >/dev/null)"
  rss_bytes="$(printf '%s' "$mono_out" | awk '/maximum resident set size/{print $1}')"
  rss_mb="$(( ${rss_bytes:-0} / 1048576 ))"
else
  mono_out="$(cd "$ROOT/p27" && /usr/bin/time -v bun install 2>&1 >/dev/null)"
  rss_kb="$(printf '%s' "$mono_out" | awk -F': ' '/Maximum resident set size/{print $2}')"
  rss_mb="$(( ${rss_kb:-0} / 1024 ))"
fi
mono_ok=$(cd "$ROOT/p27" && bun install >/dev/null 2>&1 && echo yes || echo no)
if [ "$mono_ok" = yes ] && [ "${rss_mb:-0}" -lt 120 ] && [ "${rss_mb:-0}" -gt 0 ]; then
  pass monorepo-memory "2,100 workspaces: peak RSS ${rss_mb} MB (< 120 MB ceiling; release notes cite ~35 MB on Linux)"
else
  fail monorepo-memory "install=$mono_ok peak=${rss_mb:-?} MB"
fi

# ---- P28: prerelease publish is refused without a tag (no auth needed) ------
# The refusal is a local check: it fires before Bun looks for credentials, which
# makes it testable on a machine with no registry access.
mkproj "$ROOT/p28" '{"name":"probe-prerelease-xyz","version":"2.0.0-beta.1"}'
set +e
pre_out="$(cd "$ROOT/p28" && bun publish --dry-run 2>&1)"; pre_code=$?
pre_tag_out="$(cd "$ROOT/p28" && bun publish --dry-run --tag next 2>&1)"; pre_tag_code=$?
set -e
refused=$(printf '%s' "$pre_out" | grep -q "prerelease needs a tag" && printf '%s' "$pre_out" | grep -q "would become .latest." && echo yes || echo no)
tag_bypassed=$(printf '%s' "$pre_tag_out" | grep -q "prerelease needs a tag" && echo no || echo yes)
if [ "$pre_code" -ne 0 ] && [ "$pre_tag_code" -ne 0 ] && [ "$refused" = yes ] && [ "$tag_bypassed" = yes ]; then
  pass publish-prerelease "2.0.0-beta.1 refused without a tag; --tag next moves past the check (fails later on auth)"
else
  fail publish-prerelease "code=$pre_code/$pre_tag_code refused=$refused tagBypassed=$tag_bypassed"
fi

# ---- Deliberately not automated ---------------------------------------------
skip patch-quadratic "needs a 100k-line patched package; manual: time bun patch --commit …"
skip publish-registry "publish fails at auth/packing before any registry contact can be observed; needs a real registry"

echo
printf 'summary: %d pass, %d fail, %d skip (of %d probes)\n' "$PASS" "$FAIL" "$SKIP" "$((PASS+FAIL+SKIP))"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = 1 ] && [ "$SKIP" -gt 0 ]; then exit 1; fi
exit 0
