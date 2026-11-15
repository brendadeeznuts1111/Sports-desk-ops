#!/usr/bin/env python3
"""Resolved bun.lock graph report + optional registry integrity spot-check (Bun-free).

  python3 scripts/supply-chain/lock_graph.py [bun.lock]                 # JSON report
  python3 scripts/supply-chain/lock_graph.py bun.lock --spot-check 8    # + download & hash 8 tarballs

bun.lock (lockfileVersion 1/2) is JSONC with trailing commas. packages entries:
  npm:        [ "name@ver", "<registry or ''>", {meta}, "sha512-..." ]
  workspace:  [ "name@workspace:path" ]
  git/github: [ "name@git+url#sha" | "name@github:o/r#sha", {meta}, "<sha>" ]
  tarball/file/link: [ "name@https://..." | "name@file:..." | "name@link:...", {meta}? ]
Unknown shapes are counted under "unknown" rather than guessed.
"""
import base64, hashlib, json, re, sys, urllib.request

def load(path):
    text = open(path, encoding="utf-8").read()
    # strip trailing commas before } or ] (bun.lock never has them inside strings)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))

def classify(ident):
    spec = ident[ident.index("@", 1) + 1:] if "@" in ident[1:] else ""
    if spec.startswith("workspace:"): return "workspace"
    if spec.startswith(("git+", "github:", "git:")): return "git"
    if spec.startswith(("http://", "https://")): return "tarball"
    if spec.startswith(("file:", "link:")): return "local"
    if spec and re.match(r"^[0-9]", spec): return "npm"
    return "unknown"

def tarball_url(name, version, registry):
    base = (registry or "https://registry.npmjs.org/").rstrip("/")
    return f"{base}/{name}/-/{name.split('/')[-1]}-{version}.tgz"

def main(argv):
    path = "bun.lock"; spot = 0
    it = iter(argv)
    for a in it:
        if a == "--spot-check": spot = int(next(it))
        else: path = a
    lock = load(path)
    pkgs = lock["packages"]
    direct = set()
    for ws in lock["workspaces"].values():
        for k in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            direct.update((ws.get(k) or {}).keys())
    kinds, integ_algo, missing, nonregistry, platform_specific = {}, {}, [], [], []
    npm_entries = []
    for key, v in pkgs.items():
        ident = v[0]; kind = classify(ident); kinds[kind] = kinds.get(kind, 0) + 1
        if kind == "npm":
            reg = v[1] if len(v) > 1 else ""
            meta = v[2] if len(v) > 2 and isinstance(v[2], dict) else {}
            integ = v[3] if len(v) > 3 else ""
            if reg: nonregistry.append({"key": key, "registry": reg})
            if integ:
                algo = integ.split("-", 1)[0]; integ_algo[algo] = integ_algo.get(algo, 0) + 1
            else: missing.append(key)
            if meta.get("os") or meta.get("cpu"): platform_specific.append(key)
            name, ver = ident.rsplit("@", 1)
            npm_entries.append((key, name, ver, reg, integ))
        elif kind in ("git", "tarball", "local", "unknown"):
            nonregistry.append({"key": key, "ident": ident, "kind": kind})
    non_ws = [k for k, v in pkgs.items() if classify(v[0]) != "workspace"]
    # a lock key may be nested ("parent/child") when versions conflict; direct = top-level key named directly
    direct_present = sorted(k for k in non_ws if k in direct)
    report = {
        "lockfile": path, "lockfileVersion": lock.get("lockfileVersion"),
        "workspaces": len(lock["workspaces"]),
        "packagesTotal": len(pkgs), "byKind": kinds,
        "nonWorkspacePackages": len(non_ws),
        "direct": len(direct_present), "transitive": len(non_ws) - len(direct_present),
        "nestedKeys": sorted(k for k in pkgs if k.count("/") > (1 if k.startswith("@") else 0)),
        "integrity": {"present": sum(integ_algo.values()), "missing": len(missing), "algorithms": integ_algo, "missingKeys": missing},
        "nonRegistrySources": nonregistry,
        "platformSpecific": len(platform_specific),
        "overrides": lock.get("overrides", {}),
    }
    if spot:
        # deterministic sample: every k-th npm entry by key order
        npm_entries.sort(key=lambda e: e[0]); step = max(1, len(npm_entries) // spot)
        sample = npm_entries[::step][:spot]; results = []
        for key, name, ver, reg, integ in sample:
            url = tarball_url(name, ver, reg)
            data = urllib.request.urlopen(url, timeout=60).read()
            algo, want = integ.split("-", 1)
            got = base64.b64encode(hashlib.new(algo, data).digest()).decode()
            results.append({"key": key, "url": url, "bytes": len(data), "match": got == want, "integrity": integ[:24] + "..."})
        report["spotCheck"] = {"sampled": len(results), "matched": sum(r["match"] for r in results), "results": results}
    json.dump(report, sys.stdout, indent=2); print()
    return 0 if not report.get("spotCheck") or report["spotCheck"]["matched"] == report["spotCheck"]["sampled"] else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
