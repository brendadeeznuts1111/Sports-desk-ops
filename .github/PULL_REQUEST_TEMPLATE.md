## Summary

<!-- What changed and why (1–3 sentences). -->

## Test plan

- [ ] <!-- e.g. bun test path/to.test.ts -->

## Signal Honesty Checklist

- [ ] **No silent fallbacks:** If an env var or file is missing, does the error name the exact path/variable?
- [ ] **Cron / job safety:** If this adds or modifies a scheduled job, does it define `requiredEnv` (or an equivalent probe) and pass explicit CLI args?
- [ ] **Zero-data checks:** If this returns a list or count, does it distinguish empty success from failed fetch / missing input?
- [ ] **Provenance:** If this surfaces data to UI or API, does it expose where it came from (live vs capture vs fixture)?
- [ ] **Slice registry identity:** `SLICE_REGISTRY` remains the AoS source of truth. Any index map or bit-packed fast table is generated/derived, validated against the registry, and never used as the canonical join key in config, docs, tests, or telemetry.

See [docs/architecture/signal-honesty.md](../docs/architecture/signal-honesty.md).
