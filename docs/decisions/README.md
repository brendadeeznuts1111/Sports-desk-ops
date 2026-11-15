# Decisions

One page per decision that is waiting on a person, not on code. Each states what is already true,
the constraint that makes it a choice, the options with their consequences, and acceptance criteria
that bind whichever option is taken.

The pattern exists because four of the six issues I opened this week turned out not to be the task
their title described — a "re-pin this asset" was a policy call, a "publish the report" was a
data-handling call, a "missing switch case" was a rule that no longer ran. Writing the decision down
turns a stalled issue into a page that can be answered in one sitting.

## Open

| decision | the question                                                                              | doc                                                |
| -------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| #242     | may the rankings artifact be published at all, and to whom?                               | [242-rankings-publish.md](242-rankings-publish.md) |
| #254     | what escaping semantics apply to the 12 `escapeHTML` sites that handle DOT/SVG?           | —                                                  |
| #240     | do watchlist/weblog pipelines carry customer identity, or stay login-level?               | —                                                  |
| #239     | DOD6 overlay keys by normalized customer id and collapses duplicates — which record wins? | —                                                  |
| #275     | should empty-wagers copy differ by provenance kind?                                       | —                                                  |
| #220     | which statistical/coverage evidence must a ranking claim carry before it is stated?       | —                                                  |

Only #242 has a document so far. The others are tracked in issues; each needs the same treatment
before it can be answered rather than re-litigated.

## Settled, for reference

- **#234** — summary-book population only. Implemented (#269); headline is 44.7× over 2,096 events.
- **#267** — tolerating vendor rotation on one allowlisted origin, never by re-pinning.
- **#222** — closed as obsolete: the lint rule behind it no longer runs.

## Rule that came out of #242

Quote a lift **with its population**. Both `53.7×` (all 70,869 graded rows) and `44.7×` (summary
book, 2,096 events) are correct numbers for different populations, so a bare figure is now
ambiguous wherever it appears. Nothing enforces this yet.

## Writing one

State the constraint before the options, because the constraint is what makes it a decision rather
than a preference. Give every option a consequence for what the artifact _claims_, not just what it
contains. Finish with acceptance criteria that apply regardless of which option is chosen — those are
usually the parts that turn out to matter.
