# Fantasy402 1.0.288 asset review

**Decision, 2026-11-19 Central:** retain the trusted 1.0.287 pins. The live version bump and
changed bytes are verified; vendor approval of the behavioral change is not. No pin update or
`--force` was run. Structured observations are in
[`verification/vendor-releases/fantasy402-1.0.288.json`](../../verification/vendor-releases/fantasy402-1.0.288.json).

## Measured changes

The [vendor version module](https://www.fantasy402.com/app/setting/version.js) returns 1.0.288.
The CDN audit reports three changed assets and no additional drift in its output:

| Asset                         | Trusted size | Observed size | Evidence                                                              |
| ----------------------------- | -----------: | ------------: | --------------------------------------------------------------------- |
| Fantasy402 version module     |         44 B |          44 B | 1.0.287 → 1.0.288                                                     |
| Fantasy402 player-info module |    141,693 B |     141,696 B | Extended-props permission-field substitution plus identifier renaming |
| Google Maps bootstrap         |    331,754 B |     332,403 B | Live payload identifies Maps 3.67.1d                                  |

A retained local player-info copy matches the trusted SHA-256 exactly. It was compared with
fresh bytes from the [vendor asset](https://www.fantasy402.com/app/manager/module/player-info.js).
The extended-props menu now consults `d.authorizations.AllowAdjExtProps` where the earlier
module consulted `d.authorizations.AllowQuickSGP`. A mechanical text transformation consisting
of that single property substitution and the identifier swaps `A` ↔ `R` and `Aa` ↔ `Ra`
outside quoted strings reproduces the new module text exactly. This establishes the byte delta;
it is not a semantic equivalence proof or vendor confirmation that the new permission is intended.
The other three occurrences of `AllowQuickSGP` remain unchanged.

Old and new hashes, byte counts, and the comparison result are recorded in the structured report.
Vendor JavaScript and private account messages are not copied into this evidence document.

## Release evidence found and missing

Google's [3.67.1d release notes](https://developers.google.com/maps/documentation/javascript/releases#3.67.1d)
are dated November 19, 2026 and describe a beta-channel analytics event addition. The fetched Maps
bootstrap identifies that version. Google's [version policy](https://developers.google.com/maps/documentation/javascript/versions)
also documents moving release channels and fallback behavior for invalid version selectors. This
is evidence of a Google release, not evidence approving the Fantasy402 permission change. Maps
payload hashes can also vary between requests; equal-size rotation tolerance does not cover the
observed size increase from the trusted pin.

No Fantasy402 1.0.288 release notes were found in public searches, the portal document's help
references, or the connected mail release search. An authenticated read of the portal's existing
`getMessage` operation returned HTTP 200 with no messages. This is a bounded search result, not
proof that the vendor has no release notes elsewhere. No message was sent or marked read.

The [CDN pin update procedure](../runbooks/cdn-pin-update.md) requires vendor release evidence:
“If the vendor cannot name the change, stop.” A new version string and a small, intelligible diff
alone do not satisfy that requirement. Obtain vendor release notes or confirmation covering the
extended-props authorization change before running `pin:cdn:update --vendor-version 1.0.288`.
Review the Maps change separately against its own release evidence and inspect every generated
manifest delta before committing it. Keep the same-version guard and integrity checks intact.

## Recheck

```sh
bun run pin:cdn
```

The expected result while these pins remain trusted is `CDN_ASSET_DRIFT`, exit 1. The full hosted
manual audit stops at this live-asset gate; later steps are not proven by that run. The ordinary
`dev` push checks remain a separate result and do not run this scheduled/manual-only vendor gate.
