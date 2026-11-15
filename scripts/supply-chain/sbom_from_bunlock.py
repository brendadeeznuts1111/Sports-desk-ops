#!/usr/bin/env python3
"""CycloneDX 1.6 SBOM from bun.lock + toolchain/bun.pin.json (Bun-free, deterministic).

  python3 scripts/supply-chain/sbom_from_bunlock.py > sbom.cdx.json
  options: --lock bun.lock --pin toolchain/bun.pin.json --package package.json
           --timestamp 2026-11-15T00:00:00Z   (default: SOURCE_DATE_EPOCH, else 1970-01-01)

Same inputs -> byte-identical output: serialNumber is a UUIDv5 of the input hashes and the
timestamp is pinned, so the SBOM itself is a reproducible artifact.

Components: every non-workspace bun.lock entry (purl pkg:npm, SHA-512 from its integrity),
each workspace, and the Bun runtime (pkg:github/oven-sh/bun) with the pinned binary SHA-256.
scope: "required" if reachable from any workspace's dependencies/optional/peer graph,
"optional" if reachable only through devDependencies. Edges resolve like Bun's lockfile
lookup: "<parent>/<dep>" first, then parent prefixes, then the root key.
"""
import base64, datetime, hashlib, json, os, re, sys, urllib.parse, uuid

def jsonc(path):
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", open(path, encoding="utf-8").read()))

def sha256f(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

def purl_npm(name, version):
    if name.startswith("@"):
        scope, n = name[1:].split("/", 1)
        return f"pkg:npm/%40{urllib.parse.quote(scope)}/{urllib.parse.quote(n)}@{urllib.parse.quote(version)}"
    return f"pkg:npm/{urllib.parse.quote(name)}@{urllib.parse.quote(version)}"

def main(argv):
    args = {"--lock": "bun.lock", "--pin": "toolchain/bun.pin.json", "--package": "package.json", "--timestamp": None}
    it = iter(argv)
    for a in it:
        if a in args: args[a] = next(it)
        else: print(__doc__, file=sys.stderr); return 2
    ts = args["--timestamp"]
    if not ts:
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
        ts = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lock, pin, pkgjson = jsonc(args["--lock"]), json.load(open(args["--pin"])), json.load(open(args["--package"]))
    pkgs = lock["packages"]

    def resolve(parent_key, dep):
        parts = parent_key.split("/") if parent_key else []
        # scoped segments: rebuild key prefixes on key boundaries Bun uses ("a/b", "@s/a/b")
        prefixes, cur = [], []
        i = 0
        while i < len(parts):
            seg = parts[i]
            if seg.startswith("@") and i + 1 < len(parts):
                seg = seg + "/" + parts[i + 1]; i += 1
            cur.append(seg); prefixes.append("/".join(cur)); i += 1
        for pre in reversed(prefixes):
            if f"{pre}/{dep}" in pkgs: return f"{pre}/{dep}"
        return dep if dep in pkgs else None

    ref_of_key, components, by_ref = {}, [], {}
    ws_by_name = {}
    for path, ws in lock["workspaces"].items():
        name = ws.get("name") or pkgjson.get("name")
        ws_by_name[name] = path
    for key, v in sorted(pkgs.items()):
        ident = v[0]; name, spec = ident.rsplit("@", 1) if not ident.startswith("@") or ident.count("@") > 1 else (ident, "")
        if spec.startswith("workspace:"):
            ref_of_key[key] = f"workspace:{spec[len('workspace:'):]}"
            continue
        ref = purl_npm(name, spec); ref_of_key[key] = ref
        if ref in by_ref:
            by_ref[ref]["_keys"].append(key); continue
        meta = v[2] if len(v) > 2 and isinstance(v[2], dict) else {}
        integ = v[3] if len(v) > 3 else ""
        c = {"type": "library", "bom-ref": ref, "name": name, "version": spec, "purl": ref, "_keys": [key], "_meta": meta}
        if integ:
            algo, b64 = integ.split("-", 1)
            c["hashes"] = [{"alg": {"sha512": "SHA-512", "sha384": "SHA-384", "sha256": "SHA-256", "sha1": "SHA-1"}[algo], "content": base64.b64decode(b64).hex()}]
        reg = (v[1] if len(v) > 1 else "") or "https://registry.npmjs.org/"
        c["externalReferences"] = [{"type": "distribution", "url": f"{reg.rstrip('/')}/{name}/-/{name.split('/')[-1]}-{spec}.tgz"}]
        components.append(c); by_ref[ref] = c

    # dependency edges per lock key
    edges = {}
    for key, v in pkgs.items():
        meta = v[2] if len(v) > 2 and isinstance(v[2], dict) else (v[1] if len(v) > 1 and isinstance(v[1], dict) else {})
        deps = set()
        for k in ("dependencies", "optionalDependencies", "peerDependencies"):
            for d in (meta.get(k) or {}):
                r = resolve(key, d)
                if r: deps.add(ref_of_key[r])
        edges.setdefault(ref_of_key[key], set()).update(deps)

    # workspaces
    ws_components, prod_roots, dev_roots, prod_ws_edges = [], set(), set(), {}
    for path, ws in sorted(lock["workspaces"].items()):
        ref = "workspace:" + (path or ".")
        name = ws.get("name"); deps, devs = set(), set()
        for k in ("dependencies", "optionalDependencies", "peerDependencies", "devDependencies"):
            for d in (ws.get(k) or {}):
                if d in ws_by_name and (ws.get(k)[d].startswith("workspace:")):
                    r = "workspace:" + (ws_by_name[d] or ".")
                else:
                    rk = resolve("", d); r = ref_of_key.get(rk) if rk else None
                if not r: continue
                (devs if k == "devDependencies" else deps).add(r)
        edges.setdefault(ref, set()).update(deps | devs)
        prod_ws_edges[ref] = deps
        if path: ws_components.append({"type": "library", "bom-ref": ref, "name": name, "version": ws.get("version", "0.0.0")})
        prod_roots |= deps; dev_roots |= devs

    def reach(roots):
        seen, stack = set(), list(roots)
        while stack:
            r = stack.pop()
            if r in seen: continue
            # a workspace's devDependencies are not shipped by whoever depends on it
            seen.add(r); stack.extend(prod_ws_edges[r] if r in prod_ws_edges else edges.get(r, ()))
        return seen
    prod = reach(prod_roots)

    out_components = []
    plat = pin["platforms"]
    bun_ref = f"pkg:github/oven-sh/bun@{pin['tag']}"
    out_components.append({
        "type": "application", "bom-ref": bun_ref, "name": "bun", "version": pin["version"], "purl": bun_ref,
        "description": "JavaScript runtime (pinned toolchain); hash is the linux-x64 release binary",
        "hashes": [{"alg": "SHA-256", "content": plat["linux-x64"]["binarySha256"]}],
        "externalReferences": [{"type": "distribution", "url": plat["linux-x64"]["url"]},
                               {"type": "other", "url": pin["signedChecksums"]["url"], "comment": "OpenPGP clearsigned SHASUMS256 (signer " + pin["signer"]["fingerprint"] + ")"}],
        "properties": [{"name": "sportsdesk:bun:revision", "value": pin["revision"]},
                       {"name": "sportsdesk:bun:signer-fingerprint", "value": pin["signer"]["fingerprint"]}]
                      + [{"name": f"sportsdesk:bun:{k}:zip-sha256", "value": p["zipSha256"]} for k, p in sorted(plat.items())]
                      + [{"name": f"sportsdesk:bun:{k}:binary-sha256", "value": p["binarySha256"]} for k, p in sorted(plat.items())],
    })
    for c in components:
        meta = c.pop("_meta"); keys = c.pop("_keys")
        c["scope"] = "required" if c["bom-ref"] in prod else "optional"
        props = [{"name": "sportsdesk:bunlock:key", "value": k} for k in keys]
        if c["scope"] == "optional": props.append({"name": "cdx:npm:package:development", "value": "true"})
        if meta.get("os"): props.append({"name": "sportsdesk:npm:os", "value": json.dumps(meta["os"])})
        if meta.get("cpu"): props.append({"name": "sportsdesk:npm:cpu", "value": json.dumps(meta["cpu"])})
        c["properties"] = props
        out_components.append(c)
    out_components += ws_components

    root_ref = "workspace:."
    dependencies = [{"ref": root_ref, "dependsOn": sorted(edges.get(root_ref, set()) | {bun_ref})}, {"ref": bun_ref, "dependsOn": []}]
    known = {c["bom-ref"] for c in out_components}
    for ref in sorted(known - {bun_ref}):
        dependencies.append({"ref": ref, "dependsOn": sorted(r for r in edges.get(ref, ()) if r in known)})

    seed = sha256f(args["--lock"]) + sha256f(args["--pin"]) + ts
    bom = {
        "bomFormat": "CycloneDX", "specVersion": "1.6",
        "serialNumber": "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, "sportsdesk-sbom:" + seed)),
        "version": 1,
        "metadata": {
            "timestamp": ts,
            "tools": {"components": [{"type": "application", "name": "sbom_from_bunlock.py", "version": "1",
                                       "hashes": [{"alg": "SHA-256", "content": sha256f(__file__)}]}]},
            "component": {"type": "application", "bom-ref": root_ref, "name": pkgjson.get("name"), "version": pkgjson.get("version", "0.0.0")},
            "properties": [{"name": "sportsdesk:input:bun.lock:sha256", "value": sha256f(args["--lock"])},
                           {"name": "sportsdesk:input:bun.pin.json:sha256", "value": sha256f(args["--pin"])}],
        },
        "components": out_components,
        "dependencies": dependencies,
    }
    sys.stdout.write(json.dumps(bom, indent=2, sort_keys=False) + "\n")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
