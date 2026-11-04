# CDN pin update SOP

When to run `pin:cdn:update`, who reviews it, and what the commit must record. The gate alerts; this
procedure is what turns an alert into a decision. A hash is not evidence that the new bytes are the
vendor's bytes — the version in the commit message is the human assertion that they are.

## When an update is allowed

1. **A vendor version bump you can name.** The portal bundle version is `app/setting/version.js`
   (currently `1.0.280`); record the new one and the release notes URL in the commit.
2. **A vendor security fix**, with the advisory or release note as evidence.
3. **A removal or 404 the vendor confirms** (a dependency retired, an asset moved).
4. **A confirmed same-version incident** — only with `--force`, an incident reference in the commit,
   and a reviewer who has compared the changed bytes against the vendor's changelog. The same-version
   guard exists because a silent swap and a release are indistinguishable from a hash alone.

Not allowed: updating because the drift cron fired, copying assets out of a browser cache, editing
hashes by hand, or running the update inside CI.

## Procedure

```bash
bun run pin:cdn                 # 1. see what drifted: unpinned/removed/byte/sri/css-reference
```

2. Get the vendor's version and release notes. If the vendor cannot name the change, stop: treat it
   as an incident (below), not an update.
3. Review the printed diff. It lists `+ added`, `- removed`, `~ changed` (sha256 delta and bytes) and
   `~ … stylesheet url()/@import references moved`. For each entry:
   - added asset → is it a new dependency the release notes mention? If a new `<script>` appeared,
     the attack surface changed and the release notes must say why.
   - removed asset → expected retirement, or a 404 masking an outage?
   - byte change → matches the release notes' version, not just "something happened".
   - stylesheet reference change → a font/background/image host moved; confirm the new host.

4. Apply with the version you just verified:

   ```bash
   bun run pin:cdn:update --vendor-version <vendor-version>          # normal
   bun run pin:cdn:update --vendor-version <same> --force           # confirmed incident only
   ```

   The command refuses a byte change without a version bump, and refuses to run without
   `--vendor-version`. It does not fetch or trust the release notes; that is the reviewer's job.

5. Review the manifest diff before committing. Expected: `vendorVersion` moved, `pinnedAt` updated,
   and only the assets the release justifies changed. Anything else is a reason to stop.

6. Re-run `bun run pin:cdn` — it must print `ok`.

7. Commit. Suggested message:

   ```
   pin(cdn): <old-version> -> <new-version>

   Vendor: <release notes URL>
   Changed: <n>  Added: <n>  Removed: <n>
   Assets: <comma-separated or "see diff">
   Reviewed-by: <name>
   # only for a same-version incident:
   Forced: <incident ref> — <why the bytes are legitimate>
   ```

## Review

- The manifest change is a security change, not a dependency chore. Treat it like a wire-contract
  change: one reviewer who reads the diff against the release notes, plus the operator who ran it.
- On a single-maintainer desk, the operator performs the diff review and records the evidence
  (release URL, counts, asset list) in the commit; the commit is the audit trail.
- Prefer a PR for manifest changes so the diff is reviewable and the same-version guard's `--force`
  gets a second pair of eyes.

## If the guard fires (same version, changed bytes)

Assume compromise until disproved. Do not run `--force` to make the gate green. Check the vendor's
release notes and advisory feed, compare the changed asset against a second source (a vendor-provided
copy, the vendor's own changelog hash), and involve the vendor. If it is confirmed legitimate, run
with `--force` and put the incident reference and the second source in the commit. If it is not,
the alert is the finding: rotate the affected sessions (the JWT and plaintext password are in
`sessionStorage`) and follow the vendor security path.

## Rollback

Pins are data. `git revert <commit>` restores the previous manifest; then `bun run pin:cdn` verifies
against the live origin. A revert does not un-serve a bad asset — it restores the alert.

## What this procedure does not cover

- Stylesheet-internal `url()`/`@import` targets are recorded and compared, but not fetched or hashed
  as separate assets; a new font/image host is visible in the diff, not pinned byte-for-byte.
- `rel="stylesheet/less"` files cannot carry SRI; pin coverage is their only control until the vendor
  precompiles to `.css`.
- `maps.googleapis.com` sends no `Access-Control-Allow-Origin`, so it can be pinned for drift but not
  SRI'd.
