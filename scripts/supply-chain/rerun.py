#!/usr/bin/env python3
"""Portable tool-step envelopes: capture a real step, re-verify it anywhere (Bun-free).

  python3 scripts/supply-chain/rerun.py capture toolchain/steps/X.step.json [--bun PATH] [--sign-key ed25519.pem]
  python3 scripts/supply-chain/rerun.py verify  toolchain/envelopes/X.envelope.json [--bun PATH]
          [--pubkey ed25519.pub.pem] [--out-dir DIR] [--allow-input-drift]
  python3 scripts/supply-chain/rerun.py verify-all [--bun PATH] [--out-dir DIR] [--json]

An envelope (schema/tool-step-envelope.schema.json) pins: the repo state (commit + digest of
every tracked file), named input files and node_modules trees by content hash, the exact argv
with an explicit env (nothing inherited unless allowlisted), the network policy, the runtime
pin, and the expected exit code + SHA-256 of the *normalized* output. The normalized text is
committed beside it (X.expected.txt) so a mismatch is a readable diff, not just two hashes.

Shape follows agent-rerun v0.1 (github.com/p-vbordei/agent-rerun) where it applies:
canonical JSON (sorted keys, no whitespace; RFC 8785-equivalent here because envelopes hold
no floats) -> SHA-256 -> optional Ed25519 signature over the envelope without "signature".
agent-rerun targets LLM steps (model/sampling/messages); these are tool-execution steps, so
the fields differ and this is NOT an agent-rerun bundle.

argv/env templates: {bun} {bun_dir} {repo} {tmp_home}. network: "none" (new netns, no lo),
"loopback" (new netns, lo up: local Bun.serve fixtures work, nothing leaves the box), "host".
The re-verifier never trusts the runtime under test to report on itself.
"""
import base64, datetime, difflib, hashlib, json, os, platform, re, shutil, subprocess, sys, tempfile, time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VERSION = "sportsdesk.tool-step/0.1"
WORKTREE_EXCLUDES = ("toolchain/envelopes/",)
DEFAULT_BUN = None

def canon(v): return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def sha256b(b): return hashlib.sha256(b).hexdigest()
def sha256f(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def resolve_bun(explicit):
    """Resolve to the real binary via verify-bun.sh's resolver (follows npm/pnpm shims)."""
    cand = explicit or shutil.which("bun")
    if not cand: sys.exit("rerun: no bun found; pass --bun")
    env = dict(os.environ, DX_BUN_BIN=cand)
    r = subprocess.run(["sh", os.path.join(REPO, "toolchain/verify-bun.sh"), "--print-path", "--quiet"], env=env, capture_output=True, text=True)
    if r.returncode == 0: return r.stdout.strip(), True
    m = re.search(r"bun at (\S+) sha256", r.stderr)
    if r.returncode == 1 and m: return m.group(1), False
    sys.exit(f"rerun: cannot resolve bun: {r.stderr.strip()}")

def worktree_digest():
    files = subprocess.run(["git", "-C", REPO, "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\0")
    lines = []
    for f in sorted(x.decode() for x in files if x):
        if f.startswith(WORKTREE_EXCLUDES): continue
        p = os.path.join(REPO, f)
        if os.path.islink(p): lines.append(f"l {os.readlink(p)} {f}")
        elif os.path.isfile(p): lines.append(f"f {sha256f(p)} {f}")
        else: lines.append(f"- missing {f}")
    return sha256b(("\n".join(lines) + "\n").encode()), len(lines)

def tree_digest(rel):
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts/supply-chain/tree_manifest.py"), "--digest", os.path.join(REPO, rel)], capture_output=True, text=True, check=True)
    return r.stdout.strip()

def collect_inputs(spec):
    inp = spec.get("inputs", {}); out = {}
    if inp.get("worktree", True):
        d, n = worktree_digest(); out["worktree"] = {"sha256": d, "files": n, "excludes": list(WORKTREE_EXCLUDES)}
    out["files"] = [{"path": f, "sha256": sha256f(os.path.join(REPO, f))} for f in inp.get("files", [])]
    out["trees"] = [{"path": t, "manifest_sha256": tree_digest(t)} for t in inp.get("trees", [])]
    out["digest"] = sha256b(canon({k: v for k, v in out.items() if k != "digest"}))
    return out

# ---- normalizers: strip what legitimately varies run-to-run, keep everything that is behavior
def norm_bun_test(text):
    keep = []
    for line in text.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).rstrip()
        if re.match(r"^\((pass|fail|skip|todo)\) ", line):
            keep.append(re.sub(r" \[[0-9.]+(ms|s)\]$", "", line))
        elif re.match(r"^\s*\d+ (pass|fail|skip|todo|snapshots?.*)$", line) or re.match(r"^\s*\d+ expect\(\) calls$", line):
            keep.append(line.strip())
        elif m := re.match(r"^Ran (\d+) tests? across (\d+) files?\.", line):
            keep.append(f"Ran {m.group(1)} tests across {m.group(2)} files.")
    body, summary = [l for l in keep if l.startswith("(")], [l for l in keep if not l.startswith("(")]
    return "\n".join(sorted(body) + summary) + "\n"

def norm_oxlint(text):
    out = []
    for line in text.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).rstrip()
        if m := re.match(r"^Finished in [0-9.]+m?s on (\d+) files? (?:with|using) (\d+) rules", line):
            line = f"Finished on {m.group(1)} files with {m.group(2)} rules"
        elif re.match(r"^Finished in ", line): line = re.sub(r"in [0-9.]+m?s ", "", re.sub(r" using \d+ threads\.?", "", line))
        if line.startswith("$ "): continue  # `bun run` echoes the script line; content is in the worktree digest
        out.append(line)
    return "\n".join(out).strip() + "\n"

def norm_verify_bun(text, ctx):
    # mask the binary path and its hash: the verdict (OK/MISMATCH + exit code) is the behavior
    t = text.replace(ctx["bun"], "<BUN>").replace(REPO, "<REPO>")
    t = re.sub(r"sha256=[0-9a-f]{64}", "sha256=<SHA>", t)
    return re.sub(r"/tmp/[^ )]+", "<TMP>", t)

def norm_raw(text): return text

def normalize(kind, text, ctx):
    return {"bun-test": norm_bun_test, "oxlint": norm_oxlint, "raw": norm_raw}.get(kind, None)(text) if kind != "verify-bun" else norm_verify_bun(text, ctx)

def summarize(kind, norm):
    if kind == "bun-test":
        s = {}
        for k in ("pass", "fail", "skip", "todo"):
            m = re.search(rf"^(\d+) {k}$", norm, re.M); s[k] = int(m.group(1)) if m else 0
        m = re.search(r"^(\d+) expect\(\) calls$", norm, re.M); s["expect_calls"] = int(m.group(1)) if m else None
        return s
    if kind == "oxlint":
        return {"found": [l for l in norm.splitlines() if l.startswith("Found ")]}
    return {"lines": norm.count("\n")}

def run_step(spec, bun):
    tmp_home = tempfile.mkdtemp(prefix="rerun-home-")
    # {bun_dir} is a private dir holding only a `bun` symlink to the exact binary under test, so
    # PATH lookups of `bun` (package scripts, bin/dx) hit it even when the real file is named
    # bun.exe (npm/pnpm installs) and nothing else from the binary's directory leaks in.
    bun_dir = tempfile.mkdtemp(prefix="rerun-bin-")
    os.symlink(bun, os.path.join(bun_dir, "bun"))
    ctx = {"bun": bun, "bun_dir": bun_dir, "repo": REPO, "tmp_home": tmp_home}
    sub = lambda s: re.sub(r"\{(bun|bun_dir|repo|tmp_home)\}", lambda m: ctx[m.group(1)], s)
    argv = [sub(a) for a in spec["argv"]]
    env = {k: sub(v) for k, v in spec.get("env", {}).items()}
    for k in spec.get("env_passthrough", []):
        if k in os.environ: env[k] = os.environ[k]
    net = spec.get("network", "none")
    if net in ("none", "loopback"):
        inner = ("ip link set lo up 2>/dev/null; " if net == "loopback" else "") + 'exec "$@"'
        argv = ["unshare", "-rn", "sh", "-c", inner, "sh"] + argv
    t0 = time.time()
    r = subprocess.run(argv, cwd=os.path.join(REPO, spec.get("cwd", ".")), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=spec.get("timeout_s", 900))
    dt = int((time.time() - t0) * 1000)
    shutil.rmtree(tmp_home, ignore_errors=True); shutil.rmtree(bun_dir, ignore_errors=True)
    text = r.stdout.decode("utf-8", "replace")
    norm = normalize(spec.get("normalizer", "raw"), text, ctx)
    return r.returncode, norm, dt, text

def openssl_sign(key, data):
    with tempfile.NamedTemporaryFile() as f:
        f.write(data); f.flush()
        return base64.b64encode(subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", f.name], capture_output=True, check=True).stdout).decode()

def openssl_verify(pub, data, sig_b64):
    with tempfile.NamedTemporaryFile() as f, tempfile.NamedTemporaryFile() as s:
        f.write(data); f.flush(); s.write(base64.b64decode(sig_b64)); s.flush()
        return subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", pub, "-rawin", "-in", f.name, "-sigfile", s.name], capture_output=True).returncode == 0

def pin():
    return json.load(open(os.path.join(REPO, "toolchain/bun.pin.json")))

def capture(spec_path, bun_arg, sign_key):
    spec = json.load(open(spec_path)); bun, pinned = resolve_bun(bun_arg)
    if spec.get("runtime", "pinned") == "pinned" and not pinned:
        sys.exit(f"rerun: capture for a pinned step needs the pinned bun; {bun} does not match toolchain/bun.pin.json")
    inputs = collect_inputs(spec)
    code, norm, dt, _ = run_step(spec, bun)
    p = pin()
    env_ = {
        "envelope_version": VERSION,
        "step": {k: spec[k] for k in ("id", "description") if k in spec},
        "command": {k: spec[k] for k in ("argv", "cwd", "env", "env_passthrough", "network", "timeout_s") if k in spec},
        "repo": {"commit": subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()},
        "inputs": inputs,
        "runtime": {"policy": spec.get("runtime", "pinned"), "pin": {"version": p["version"], "revision": p["revision"], "binary_sha256": {k: v["binarySha256"] for k, v in p["platforms"].items()}},
                    "captured_with_sha256": sha256f(bun)},
        "expected": {"exit_code": code, "normalizer": spec.get("normalizer", "raw"), "normalized_sha256": sha256b(norm.encode()),
                     "normalized_file": os.path.basename(spec_path).replace(".step.json", ".expected.txt"), "summary": summarize(spec.get("normalizer", "raw"), norm)},
        "tolerance": {"level": "byte-normalized"},
        "recorded": {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "duration_ms": dt, "platform": f"{platform.system()}-{platform.machine()}", "note": "informational; not verified"},
    }
    if sign_key: env_["signature"] = {"alg": "ed25519", "sig": openssl_sign(sign_key, canon(env_)), "note": "demo key"}
    outdir = os.path.join(REPO, "toolchain/envelopes"); os.makedirs(outdir, exist_ok=True)
    base = os.path.basename(spec_path).replace(".step.json", "")
    open(os.path.join(outdir, base + ".envelope.json"), "w").write(json.dumps(env_, indent=2) + "\n")
    open(os.path.join(outdir, base + ".expected.txt"), "w").write(norm)
    print(json.dumps({"captured": base, "exit_code": code, "normalized_sha256": env_["expected"]["normalized_sha256"], "summary": env_["expected"]["summary"], "duration_ms": dt}))

def verify(env_path, bun_arg, pubkey=None, out_dir=None, allow_drift=False):
    e = json.load(open(env_path)); res = {"envelope": os.path.basename(env_path), "checks": {}, "warnings": []}
    ok = True
    if e.get("envelope_version") != VERSION: res["checks"]["schema"] = f"unknown version {e.get('envelope_version')}"; ok = False
    else: res["checks"]["schema"] = "ok"
    if "signature" in e:
        if pubkey:
            body = canon({k: v for k, v in e.items() if k != "signature"})
            good = openssl_verify(pubkey, body, e["signature"]["sig"]); res["checks"]["signature"] = "ok" if good else "INVALID"; ok &= good
        else: res["warnings"].append("signature present but no --pubkey given; not checked")
    spec = dict(e["command"]); spec.update({"inputs": {"worktree": "worktree" in e["inputs"], "files": [f["path"] for f in e["inputs"]["files"]], "trees": [t["path"] for t in e["inputs"]["trees"]]}, "normalizer": e["expected"]["normalizer"]})
    now = collect_inputs(spec)
    if now["digest"] == e["inputs"]["digest"]: res["checks"]["inputs"] = "ok"
    else:
        drift = [k for k in ("worktree", "files", "trees") if now.get(k) != e["inputs"].get(k)]
        res["checks"]["inputs"] = f"DRIFT in {drift}"; ok &= allow_drift
    bun, pinned = resolve_bun(bun_arg); bsha = sha256f(bun)
    res["runtime"] = {"bun": bun, "sha256": bsha, "matches_pin": pinned}
    if e["runtime"]["policy"] == "pinned" and not pinned:
        res["warnings"].append(f"RuntimeDrift: replaying a pinned-runtime envelope on bun sha256={bsha[:12]} (pin {e['runtime']['pin']['version']}); this is a cross-runtime replay")
    code, norm, dt, raw = run_step(spec, bun)
    got = sha256b(norm.encode()); exp = e["expected"]
    res["actual"] = {"exit_code": code, "normalized_sha256": got, "summary": summarize(exp["normalizer"], norm), "duration_ms": dt}
    same = got == exp["normalized_sha256"] and code == exp["exit_code"]
    res["checks"]["output"] = "ok" if same else "MISMATCH"; ok &= same
    if out_dir:
        os.makedirs(out_dir, exist_ok=True); base = os.path.basename(env_path).replace(".envelope.json", "")
        open(os.path.join(out_dir, base + ".actual.txt"), "w").write(norm)
        open(os.path.join(out_dir, base + ".raw.log"), "w").write(raw)
    if not same:
        ep = os.path.join(os.path.dirname(env_path), exp["normalized_file"])
        if os.path.exists(ep):
            res["diff"] = list(difflib.unified_diff(open(ep).read().splitlines(), norm.splitlines(), "expected", "actual", lineterm="", n=1))[:80]
    res["verified"] = bool(ok)
    return res

def main(argv):
    if not argv: print(__doc__); return 2
    cmd, rest = argv[0], argv[1:]
    opts = {"--bun": None, "--sign-key": None, "--pubkey": None, "--out-dir": None}
    flags = set(); pos = []
    it = iter(rest)
    for a in it:
        if a in opts: opts[a] = next(it)
        elif a in ("--allow-input-drift", "--json"): flags.add(a)
        else: pos.append(a)
    if cmd == "capture":
        for p in pos: capture(p, opts["--bun"], opts["--sign-key"])
        return 0
    if cmd in ("verify", "verify-all"):
        paths = pos if cmd == "verify" else sorted(os.path.join(REPO, "toolchain/envelopes", f) for f in os.listdir(os.path.join(REPO, "toolchain/envelopes")) if f.endswith(".envelope.json"))
        results = [verify(p, opts["--bun"], opts["--pubkey"], opts["--out-dir"], "--allow-input-drift" in flags) for p in paths]
        if "--json" in flags or cmd == "verify": print(json.dumps(results if cmd == "verify-all" else results[0], indent=2))
        else:
            for r in results:
                print(f"{'PASS' if r['verified'] else 'FAIL'} {r['envelope']} inputs={r['checks']['inputs']} output={r['checks']['output']} exit={r['actual']['exit_code']} {r['actual']['summary']}" + "".join(f"\n  warn: {w}" for w in r["warnings"]))
        return 0 if all(r["verified"] for r in results) else 1
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
