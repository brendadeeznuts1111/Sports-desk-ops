# Fraud-core fixtures

Fixture intent, so a future test author does not "fix" the wrong one:

| File                                   | Intent                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `betreport-small.json`                 | **Deliberately integrity-invalid.** Six of its nine bet groups contain more than one `userID`. It exists to prove the bet-group integrity validator fails loudly (`BET_GROUP_MULTIPLE_PLAYERS`); do not regenerate it into a clean corpus or change its groups to single users. |
| `groups-valid-corpus.json`             | Clean success-path corpus: one user per bet group, consistent ticket-level fields, with allowed lifecycle observations (mixed leg states, a push leg inside a winning ticket, a rejected supplemental confirmation).                                                            |
| `syntheticBetReport()` in `support.ts` | Large deterministic corpus for model-fit tests; groups two rows per account and is not an integrity fixture.                                                                                                                                                                    |

The two corpus fixtures are otherwise interchangeable for discovery, hashing and CLI plumbing.
