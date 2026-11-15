# Commit identity and the `.mailmap`

`dev@duoplus.com` was this machine's commit identity until 2026-11-15. The domain is **not controlled by this project**: RDAP shows it registered 2004-02-09 via Gabia, parked on `ns1/ns2.parkingcrew.net`, with a hard-fail SPF and no site. GitHub shows the historical commits as **unattributed** (`author_login: null`, unverified) while the address is public in `git log`.

## Forward identity

`~/.gitconfig` now sets `Ash - BookDeskOps <342268653+bw496915-cmyk@users.noreply.github.com>` — the GitHub noreply address, which attributes commits to the account without exposing a mailbox. No repo-local override or `includeIf` covers this checkout.

## History

`.mailmap` maps the old identity (and the account's earlier `bw496915@gmail.com` and older noreply forms) to the canonical one **for display only**. It changes no objects and no SHAs; `git log --use-mailmap` and GitHub's author display show the canonical identity.

A history rewrite (`git filter-repo --mailmap`) would replace the address inside the commit objects, but it changes every SHA, requires a force-push, and makes the one collaborator re-clone. That is deliberately a separate, scheduled decision — not part of the display fix.
