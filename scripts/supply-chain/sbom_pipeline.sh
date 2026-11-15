#!/bin/sh
# SBOM pipeline (local demo): generate -> validate with two independent tools -> DEMO-sign
# offline -> verify with cosign and, separately, with openssl.
#
#   SC_DIR=/workspace/supply-chain sh scripts/supply-chain/sbom_pipeline.sh
#
# Generator:   scripts/supply-chain/sbom_from_bunlock.py (ours, deterministic)
# Validator 1: cyclonedx-cli (CycloneDX's own .NET tool)          $CYCLONEDX_CLI
# Validator 2: python-jsonschema against the official 1.6 schema   $SC_DIR/venv
# Signer:      cosign sign-blob with a LOCAL THROWAWAY key, a signing config that lists no
#              Fulcio/Rekor/TSA services, inside a network namespace with no network
#              (unshare -rn), so nothing can reach a public transparency log.
# Verifier 1:  cosign verify-blob (offline, --insecure-ignore-tlog: there is no tlog entry)
# Verifier 2:  openssl dgst -verify over the raw ECDSA signature from the bundle
#
# THE SIGNATURE IS A DEMO. It proves the plumbing, not provenance: the key is throwaway and
# known only to this box. Production keyless signing is described in docs/supply-chain.md.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
SC_DIR=${SC_DIR:-/workspace/supply-chain}
out=$SC_DIR/sbom; keys=$SC_DIR/demo-keys; mkdir -p "$out" "$keys"
COSIGN=${COSIGN:-$SC_DIR/tools/cosign-linux-amd64}
CYCLONEDX_CLI=${CYCLONEDX_CLI:-$SC_DIR/tools/cyclonedx-linux-x64}
TS=${SBOM_TIMESTAMP:-2026-11-15T00:00:00Z}
schema_base=https://raw.githubusercontent.com/CycloneDX/specification/1.6/schema
# sha256 of the official schema files as fetched 2026-11-15 (re-fetch must match)
schema_pins="bom-1.6.schema.json=3e92dddbc30cf7f6a02b80f0942b1a4cfd4fb1c26f1dfc4310afa9d613cafb93
spdx.schema.json=baa9d3bd1ed57b6751b0887edead6b5063ff53ff7429cf85d476c6c94af0166e
jsf-0.82.schema.json=8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae"

echo "== generate"
(cd "$repo" && python3 scripts/supply-chain/sbom_from_bunlock.py --timestamp "$TS") > "$out/sbom.cdx.json"
(cd "$repo" && python3 scripts/supply-chain/sbom_from_bunlock.py --timestamp "$TS") | cmp -s - "$out/sbom.cdx.json" && echo "deterministic: second generation byte-identical"
echo "sbom sha256 $(sha256sum "$out/sbom.cdx.json" | cut -d' ' -f1)"

echo "== validate 1: cyclonedx-cli"
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 "$CYCLONEDX_CLI" validate --input-file "$out/sbom.cdx.json" --input-format json --input-version v1_6 --fail-on-errors

echo "== validate 2: jsonschema (official CycloneDX 1.6 schema)"
mkdir -p "$out/schema"
echo "$schema_pins" | while IFS== read -r f want; do
  [ -f "$out/schema/$f" ] || curl -fsSL -o "$out/schema/$f" "$schema_base/$f"
  [ "$(sha256sum "$out/schema/$f" | cut -d' ' -f1)" = "$want" ] || { echo "schema $f hash drifted" >&2; exit 1; }
done
[ -x "$SC_DIR/venv/bin/python" ] || { python3 -m venv "$SC_DIR/venv" && "$SC_DIR/venv/bin/pip" -q install jsonschema==4.25.1; }
"$SC_DIR/venv/bin/python" - "$out/sbom.cdx.json" "$out/schema" <<'PY'
import json, sys
from jsonschema import Draft7Validator
from referencing import Registry, Resource
d = sys.argv[2]
names = ("bom-1.6.schema.json", "spdx.schema.json", "jsf-0.82.schema.json")
res = {n: Resource.from_contents(json.load(open(f"{d}/{n}"))) for n in names}
reg = Registry().with_resources(list(res.items()) + [(r.contents["$id"], r) for r in res.values() if "$id" in r.contents])
v = Draft7Validator(json.load(open(f"{d}/bom-1.6.schema.json")), registry=reg, format_checker=Draft7Validator.FORMAT_CHECKER)
errs = list(v.iter_errors(json.load(open(sys.argv[1]))))
for e in errs[:10]: print("ERROR", list(e.path), e.message[:200])
print("jsonschema:", "VALID" if not errs else f"INVALID ({len(errs)})"); sys.exit(1 if errs else 0)
PY

echo "== DEMO sign (throwaway key, no transparency log, no network)"
cat > "$keys/offline-signing-config.json" <<'JSON'
{"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json","caUrls":[],"oidcUrls":[],"rekorTlogUrls":[],"tsaUrls":[],"rekorTlogConfig":{"selector":"ANY"},"tsaConfig":{"selector":"ANY"}}
JSON
if [ ! -f "$keys/demo-throwaway.key" ]; then
  (umask 077; openssl rand -hex 16 > "$keys/demo-throwaway.password")
  (cd "$keys" && COSIGN_PASSWORD="$(cat demo-throwaway.password)" "$COSIGN" generate-key-pair --output-key-prefix demo-throwaway >/dev/null 2>&1)
fi
rm -f "$out/sbom.cdx.json.sigstore.json"
COSIGN_PASSWORD="$(cat "$keys/demo-throwaway.password")" unshare -rn "$COSIGN" sign-blob --key "$keys/demo-throwaway.key" \
  --signing-config "$keys/offline-signing-config.json" --yes --bundle "$out/sbom.cdx.json.sigstore.json" "$out/sbom.cdx.json" >/dev/null 2>&1
echo "bundle tlogEntries: $(jq '.verificationMaterial.tlogEntries // [] | length' "$out/sbom.cdx.json.sigstore.json")"

echo "== verify 1: cosign (offline)"
unshare -rn "$COSIGN" verify-blob --key "$keys/demo-throwaway.pub" --bundle "$out/sbom.cdx.json.sigstore.json" --insecure-ignore-tlog=true "$out/sbom.cdx.json" 2>&1 | grep -v '^WARNING: Skipping tlog'

echo "== verify 2: openssl (raw ECDSA-P256/SHA-256 signature from the bundle)"
jq -r .messageSignature.signature "$out/sbom.cdx.json.sigstore.json" | base64 -d > "$out/sbom.cdx.json.sig.der"
d=$(jq -r .messageSignature.messageDigest.digest "$out/sbom.cdx.json.sigstore.json" | base64 -d | od -An -tx1 | tr -d ' \n')
[ "$d" = "$(sha256sum "$out/sbom.cdx.json" | cut -d' ' -f1)" ] && echo "bundle messageDigest == sha256(sbom)"
openssl dgst -sha256 -verify "$keys/demo-throwaway.pub" -signature "$out/sbom.cdx.json.sig.der" "$out/sbom.cdx.json"

echo "== negative control: one byte changed must fail both verifiers"
sed 's/"version": 1,/"version": 2,/' "$out/sbom.cdx.json" > "$out/tampered.cdx.json"
if unshare -rn "$COSIGN" verify-blob --key "$keys/demo-throwaway.pub" --bundle "$out/sbom.cdx.json.sigstore.json" --insecure-ignore-tlog=true "$out/tampered.cdx.json" >/dev/null 2>&1; then echo "cosign ACCEPTED tampered SBOM" >&2; exit 1; else echo "cosign rejected tampered SBOM"; fi
if openssl dgst -sha256 -verify "$keys/demo-throwaway.pub" -signature "$out/sbom.cdx.json.sig.der" "$out/tampered.cdx.json" >/dev/null 2>&1; then echo "openssl ACCEPTED tampered SBOM" >&2; exit 1; else echo "openssl rejected tampered SBOM"; fi
echo "SBOM PIPELINE OK (signature is a DEMO)"
