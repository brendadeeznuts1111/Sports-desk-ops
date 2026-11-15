# Commit identity and the `.mailmap`

`dev@duoplus.com` was this machine's commit identity until 2026-11-15. The domain is **not controlled by this project**: RDAP shows it registered 2004-02-09 via Gabia, parked on `ns1/ns2.parkingcrew.net`, with a hard-fail SPF and no site. GitHub shows the historical commits as **unattributed** (`author_login: null`, unverified) while the address is public in `git log`.

## Forward identity

`~/.gitconfig` sets `Ash - BookDeskOps <342268653+bw496915-cmyk@users.noreply.github.com>` — the GitHub noreply address, which attributes commits to the account without exposing a mailbox. No repo-local override or `includeIf` covers this checkout.

That covers commits written **on this machine**. It does not cover commits GitHub writes for you.

## The web-merge channel (the one the gitconfig did not close)

Of the 196 commits carrying `bw496915@gmail.com` on 2026-11-15 (the count rises by one with every web merge until the account setting below is on), **195 were committed by `GitHub <noreply@github.com>`**: web squash merges. Those take the author from the account profile name plus the account's _visible_ email and ignore `~/.gitconfig` entirely. Exactly one gmail commit was local. So the gitconfig fix, on its own, never stopped this channel — it kept producing gmail-authored commits after the identity change, which is what `git log` shows on 2026-11-15.

The control is account-level, and it is a setting, not a rewrite:

**Settings → Emails → "Keep my email addresses private."**

With it on, web and squash-merge commits use the `…@users.noreply.github.com` address instead of the primary mailbox.

### Do not read the profile email as a proxy

`gh api user --jq .email` returns `null` on this account, which looks like privacy and is not. It only reports the _profile_ public-email dropdown, which does not govern commit authorship — all 195 gmail web commits were written while that field was `null`. The setting has its own state, exposed per address:

```bash
gh api user/emails --jq '.[] | select(.primary) | {email, visibility}'
# {"email":"bw496915@gmail.com","visibility":"public"}  <- leak is open
# visibility: private                                    <- setting is on
```

The authoritative check is the artifact, not the toggle: confirm the author of the next squash merge, or of any commit GitHub writes for you:

```bash
gh api 'repos/{owner}/{repo}/commits?per_page=1' --jq '.[0].commit | {author: .author.email, committer: .committer.email}'
# author must be *@users.noreply.github.com, not a personal mailbox
```

The primary address stays listed in `user/emails` either way; what changes is that GitHub stops publishing it in commits.

## History

`.mailmap` maps the old identity (and the account's earlier `bw496915@gmail.com` and older noreply forms) to the canonical one **for display only**. It changes no objects and no SHAs; `git log --use-mailmap` and GitHub's author display show the canonical identity.

## Why the rewrite stays deferred

A history rewrite (`git filter-repo --mailmap`) would replace the address inside every commit object, change every SHA, require a force-push, and make the one collaborator re-clone. It buys tidiness, not confidentiality: the address is already public in 196 of this public repo's 1,054 commit objects, and 843 more carry `dev@duoplus.com`, and a rewrite removes it from none of the copies anyone may already hold. The forward fix is the account setting above, which stops new exposure at the source.

**This is deferred, not abandoned. Reopen it when any one of these becomes true:**

1. **`duoplus.com` changes hands or stops being parked** — a registrant change, an MX record appearing, or SPF ceasing to hard-fail. Any of those means someone other than the people who wrote these commits can now receive mail at the address those commits are attributed to. That is the scenario a rewrite actually mitigates.
2. **The repo needs a history rewrite for another reason** — a leaked credential, an oversized blob, a license cleanup. Batch the mailmap rewrite into that operation; the force-push cost is paid once.
3. **A compliance or counterparty requirement names commit-metadata hygiene explicitly.**

Absent one of those, the decision stands. Note what is _not_ a trigger: a date. There is no scheduled revisit, because "deferred" plus a date is just a postponed rewrite; the three conditions above are the commitment.

## The address inside `.mailmap`

`.mailmap` is tracked, so the mapping places `bw496915@gmail.com` in current source rather than only in history. That is not new exposure — the address sits in the commit objects of roughly 200 commits anyone with the repo can read — and the mapping removes no copy of it. It is also not what the account setting does: turning the setting on does not retract anything already written, and leaving it off would have kept adding new copies.

Keeping the mapping is the better trade. It makes historical commits display as a single identity; deleting it would hide the alias from `git log` without deleting a single copy of the address.

### One mapping per address, and the last line wins

Before adding a line here: git keys the mapping on the **commit email** and applies the **last matching line**. So two lines that map `bw496915@gmail.com` to different names are not complementary — appending the second silently renames every commit carrying that address (198 of them), while placing it first makes it a no-op. Measured both ways: appending a `bw496915-cmyk` line after the canonical one changes `git shortlog` output to that name; putting it first changes nothing.

The 150 commits authored `Ash - BookDeskOps <bw496915@gmail.com>` and the 48 authored `bw496915-cmyk <bw496915@gmail.com>` **cannot be displayed with different names**, because the display name is not part of the key. The canonical line is a decision about all 198 at once. To change it, replace that line — never append a second one.
