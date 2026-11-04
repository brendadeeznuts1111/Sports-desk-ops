# DOD6 v5.4 binary spine — performance audit (2026-11-04)

Runtime: **Bun 1.4.4+38afee6c8** (macOS, 10 logical cores).

Workload: `createDod6V54LifetimeReader()` + `lookup()`/`lookupInto()` over
`data/sportsdesk_unified_baseline_v54.dodbin` (88,198,656 bytes, 14,534 rows).
Commands: `bun run scratch/bench_dod6.ts`, `scratch/bench_dod6_into.ts`,
`scratch/bench_dod6_lookup.ts`, `bun --cpu-prof --cpu-prof-md`, JSC option differentials, and
`bun:jsc.heapStats()` / `Bun.unsafe.mimallocDump()` heap deltas.

## Phase 0 — Schema (measured from the 2048-byte header and section table)

All fields little-endian. Header/section table read once; row fields random-single.
Terminal rendering of this table: `bun run scratch/dod6_schema_table.ts`
(`Bun.inspect.table(rows, ["field","offset","width","alignment",...])`).

| Field | Offset | Width | Align | Frequency | Pattern | Storage |
|---|---:|---:|---:|---|---|---|
| magic `0x444f4436` | 0 | 4 | 4 | once | scalar | `Uint32Array` word 0 |
| version 54 | 4 | 4 | 4 | once | scalar | `Uint32Array` word 1 |
| customerCount | 8 | 4 | 4 | once | scalar | word 2 |
| rowCapacity | 12 | 4 | 4 | once | scalar | word 3 |
| asOfEpochDays | 28 | 4 | 4 | once | scalar | word 7 |
| totalFileBytes | 32 | 4 | 4 | once | scalar | word 8 |
| sectionCount | 36 | 4 | 4 | once | scalar | word 9 |
| section table | 64 | 88×12 | 4 | once | sequential | 264 `Uint32Array` words |
| radixHeadRowCol | section 1 | 65,536×4 | 4 | 1–4/lookup | random single | `Int32Array` |
| loginKey64Col | section 2 | 14,534×8 | 8 | chain nodes | random single | two `Uint32Array` words (was `BigUint64Array`) |
| nextInRadixBucketCol | section 8 | 14,534×4 | 4 | chain nodes | random single | `Int32Array` |
| lifetimeNetProfitCents | section 6 | 14,534×8 | 8 | per hit | random single | two `Int32Array` words (was `BigInt64Array`) |
| roiBasisPoints | section 15 | 14,534×4 | 4 | per hit | random single | `Int32Array` |
| clvLegsCount | section 16 | 14,534×4 | 4 | per hit | random single | `Uint32Array` |
| avgClvLineHundredths | section 17 | 14,534×4 | 4 | per hit | random single | `Int32Array` |
| packedHandleCol | section 7 | 14,534×4 | 4 | per hit (identity) | random single | `Uint32Array` (row + generation/tier bits) |

**Layout violations flagged before measurement:** full-file read twice (meta + reader), each followed
by `ArrayBuffer.slice` (two copies); BigInt boxing in the key encoder and in `BigUint64Array`
comparisons; `toFixed` per hit; result-object allocation per hit; no per-element `DataView`; no
`boolean[]` / array-of-0/1 in this schema; no `[]`/`{}`/`push` in the aggregation loop except the
result object.

**Coverage proof (all 88 sections, not just the table excerpt):** every section offset is 64-byte
aligned; every section ends before the next; the residual gap is 0–58 bytes of 64-byte padding
(16 bytes between 8-byte columns, 40 between 4-byte columns, 52 between 16-bit columns). The two
regions that looked unaccounted in the earlier table are the omitted sections 3–5
(`packedHandle64Col`, `lifetimeStakedCents`, `settledStakedCents`) and 9–14 (bet counts), plus
that padding. `totalFileBytes = 88,198,656`; the last section ends at `88,198,598` with 58 bytes
of tail padding. Script: `scratch/dod6_section_validate.ts`; full table:
`scratch/dod6_schema_table.ts`.

## Phase 1 — Baseline on this machine

Before the working-tree optimization:

| Metric | Result |
|---|---:|
| reader creation | 47–112 ms (two 84 MB reads + two copies) |
| hit lookup | 312–417 ns/op |
| miss lookup | 598–626 ns/op |
| hot single-login lookup | 246–277 ns/op |
| JS heapUsed delta, 300k lookups | +89.5 KB |
| CPU profile | `slice` 28.9%, `readSync` 25.7%, key encoding ~14.4%, `asUintN` 5.0%, GC 3.9%, `toFixed` 2.1% |

**JIT tier:** confirmed by JSC compiler logging (`BUN_JSC_verboseCompilation=1`). `rowFor`,
`resolveRowIndex` and `writeRadixSlotsFromHashes` are compiled with **FTL** after Baseline/DFG
(`DFG(Plan) ... with FTL`). The loop is not interpreted. Cache counters are unavailable on this
host (no `perf`, no `valgrind`, no installed `xctrace`); every cache result below is an **8-way
LRU line model, not a hardware measurement**. Cliff boundaries are policy-sensitive; a random or
Belady policy would move them. Do not read the model as a measured delta.

## Phase 2 — Trace

- Creation dominated the profile: two `openSync`/`readSync` full reads and two `slice` copies,
  for 168 MB read and 168 MB copied before the first lookup.
- Lookup: `encodeCustomerPackedKey64` (BigInt base-40) ~14%, `asUintN` 5%, `toFixed` 2.1%,
  `rowToLookup` object allocation, and `loginBounds` called twice per lookup.
- Bytes touched per lookup: header/section table once; radix head (4 B), then per chain node
  8 B key + 4 B next pointer; on hit net (8 B), ROI (4 B), CLV legs (4 B), avg CLV (4 B).
- Views were owned (`byteOffset === 0`, full buffer) but section alignment was unasserted.
- GC was 3.9% of the profile; JS heapUsed delta 89.5 KB per 300k lookups.

## Phase 3 — Changes, constrained by the schema

| Change | Counter it should move | Measured |
|---|---|---|
| Header-only meta read (2048 B) instead of a full read | creation I/O and copy | removed one 84 MB read + copy |
| One owned full-file read, no `ArrayBuffer.slice` | creation copy | removed the second 84 MB copy |
| Pack key as `[lo, hi]` 32-bit words; compare the key column as two u32 words | BigInt/asUintN, chain compare | key encoder no longer uses BigInt for ≤12-char logins; BigInt/asUintN disappear from the lookup profile |
| Fused key+radix-slots encoder with caller-owned bounds/key/slot scratch | duplicate `loginBounds` passes and object | `loginBounds` no longer appears in the steady-state hot path |
| Read net column as two 32-bit words | BigInt boxing per hit | no `BigInt64Array` read on hit |
| `lookupInto(login, target)` | result-object allocation | 0 KB JS heapUsed delta; steady-state `objectCount` delta 0 |
| Integer tenths rounding with a residue-5 `toFixed` fallback | `toFixed` share | `toFixed` is 1.7% / residue-only, down from 10.2% in the lookup profile |
| Alignment/length/ownership assertions at mount | correctness, no runtime hot cost | misaligned/overrun fixtures throw |

**No stack-allocation claim.** `keyParts`, `slots` and `bounds` are fixed-capacity
`Uint32Array`/`Int32Array` scratch allocated once per reader; the file buffer is one owned
`ArrayBuffer`. No cache was added.

**Heap attribution (Bun 1.4.4+38afee6c8).** `bun:jsc.heapStats()` separates the JS heap
(`objectCount`, `heapSize`) from `extraMemorySize`. At open, `objectCount` rises by 397 and
`extraMemorySize` by **86,157 KiB** — the one 88,198,656-byte file `ArrayBuffer` (~84.1 MiB).
`Bun.unsafe.mimallocDump()` corroborates the native side: touched 3.3 → 91.4 MiB and committed
38.5 → 126.5 MiB after open. Over 500k `lookupInto` calls, JS `heapUsed` delta is 0 KB; the first
post-warmup phase adds 14 one-time JIT/code objects, and a second 500k phase has `objectCount`
delta **0**. A raw `heapStats()` snapshot allocates ~250–330 objects; each snapshot is taken,
dropped and GC'd before comparison (residual overhead ±1–11), otherwise the snapshot itself looks
like per-lookup allocation. The ~727 KiB figure is the cache-model hot set (head table plus
touched chain/field lines) inside that ArrayBuffer, not the size of the allocation or of
`extraMemorySize`.

**Runtime/transport notes (Bun 1.4.4+38afee6c8).**
- **AsyncLocalStorage:** N/A. No `AsyncLocalStorage`/`enterWith` in the reader or its ingestion
  path, so the 1.4.1 leakage fix does not change this reader; per-cron context is passed
  explicitly.
- **WebSocket binary ingestion:** N/A. The reader reads a file via
  `Bun.file().arrayBuffer()`; it does not consume `Bun.serve`/`server.upgrade` messages, so the
  1.4.1 `Uint8Array`→`ArrayBuffer` change cannot reinterpret `msg.buffer`.
- **mmap/truncation:** the owned-read path is kept, and open already asserts
  `fileSize === header.totalFileBytes` (word 8); a truncated spine returns `null`, and a file
  replaced between header validation and the full read throws, so it fails closed before any
  section mount. This is the open-time assertion for the mmap assumption, not just a comment.

**Rejected:** `Bun.mmap` would cut the remaining 19–28 ms one-time read, but the reader is
long-lived/per-cron and mmap has a documented truncation/segfault failure mode. This assumes the
spine is a static dataset or atomically replaced file that is never truncated in place; if a
deployment rewrites it in place, keep the owned-read path (and treat a mid-read swap as an
external failure). `Float16` is irrelevant (no float columns in the hot path). The reader has no
boolean collection, so the bitset item is N/A here; the schema's `highSeverityWatchBitset64Col`
is not used by this reader.

**Schema pinning:** the writer schema is vendored at `schema/dod6-v54.schema.json` and pinned by
SHA-256 (`DOD6_SCHEMA_SHA256`); constants in `lib/dod6_v54_schema.ts` are asserted against it.
The reader checks at open: magic, supported version (54), section count, and
`rowCapacity <= 32,767`. A writer-side version bump now fails closed instead of silently
reinterpreting the file.

### Radix-head cache question

The head table is 262,144 bytes (4,096 cache lines). This host: P-core L2 16 MiB
(`hw.perflevel0.l2cachesize=16,777,216`), E-core L2 4 MiB; L1d 128 KiB/64 KiB. The head table
**fits L2** and only exceeds L1.

Hardware cache counters are unavailable here (no `perf`, no `valgrind`, no installed
`xctrace`/Instruments). The access trace was replayed through an 8-way LRU line model over all
14,533 decodable base-40 logins (200k lookups):

| cache capacity | head miss share | misses/lookup |
|---:|---:|---:|
| 16 KiB | 65.8% | 5.83 |
| 64 KiB | 64.5% | 5.20 |
| 256 KiB | 56.0% | 2.75 |
| 512 KiB | 11.1% | 0.46 |
| 1 MiB | 36% (compulsory only) | 0.057 |
| 4 MiB | 36% (compulsory only) | 0.057 |

At the actual 4–16 MiB L2, after warm-up the head table is effectively resident; the remaining
misses are compulsory (4,096 head lines + chain + fields). This is a **portability-deferred**
result, not “no win”: the 256 KiB table exceeds L1d (128/64 KiB) but fits both L2 levels here.
Two-level head-table work becomes interesting **below 512 KiB on this model's LRU**; the
transition lies between 256 and 512 KiB and can shift by roughly 2× under a different replacement
policy (random/Belady). Treat it as a directional classifier, not a spec. Above that range, node
regrouping is the rounding error. Time attribution agrees: four precomputed
head reads are 12.4 ns, four row fields are 19.1 ns, full `lookupInto` median **60.8 ns** over
7 runs (59.9–63.1) on Bun 1.4.4+38afee6c8; 66–76 ns under concurrent load.

### packedHandleCol decision — writer traced and pinned

The writer/schema was found in the external turbo-cap checkout. It is now **vendored** at
`schema/dod6-v54.schema.json` with constants in `lib/dod6_v54_schema.ts`; the test suite asserts
the constants match the JSON. `handle32Layout` = row 15 bits, `spineGenerationMod4` 2 bits,
tier/vol/skill/behavior bits; `handle64Layout` = 20-bit row, 8-bit generation. The observed
`0x8000 | row` low bits match the schema exactly: patterned writer output, not uninitialized
memory.

The reader now checks at **open**: magic, supported version (54), section count, and
`rowCapacity <= 32,767`. **Row index `0x7fff` is reserved**: it is the row field of the all-ones
null handle (`0xFFFFFFFF`); the writer's `maxCustomerRows32 = 32,766` is the maximum valid
row *index*, so capacity is 32,767 rows (indices 0..32,766), not 32,766. It validates every
`(handle & 0x7fff) === row` **once at construction**, not per lookup. The 32-bit handle's 15 row
bits are checked; generation (`mod 4`), tier, vol, skill and behavior bits remain opaque. Wrap
period is 4 generations for handle32 and 256 for handle64; a stale handle is **missed when the
row has been recycled a multiple of 4** (handle64: a multiple of 256) times. A stale reference is
detectable only on the residues those widths distinguish. The 64-bit path follows the same
capacity convention: row index `0xFFFFF` is reserved (the all-ones 64-bit null handle), so its
maximum valid index is 1,048,574 and its capacity is 1,048,575. That path is not wired in this
reader.

Handle contract: `Dod6LookupHandle` is an explicit union —
`{ kind: "binary", handle: number }` or `{ kind: "row-index-fallback", rowIndex: number | null }`.
There is no runtime `null`; CSV/JSON sources carry the explicit fallback. `lookupInto` uses flat
`handleKind`/`handleValue` fields to stay allocation-free. **Hot-path rule: `lookup()`
allocates a result plus a handle union per call; never call it in a per-row loop — use
`lookupInto(login, target)` and reuse the target.** Handles are **opaque and not sortable**
(high tag/generation bits dominate numeric order); use `rowOfHandle(identity)` for row-major.

`packedHandle64Col` is not wired. If it is ever used, it must be mounted as
`Uint32Array[2]` two-lane, not `BigUint64Array`; otherwise the BigInt cost the reader removed
returns.

Validation timing: construction-only. Per-lookup validation cost ~6 ns and only checked 15 of 32
bits; it was removed. Current `lookupInto` is **60.8 ns median of 7 runs** (59.9–63.1) on Bun
1.4.4+38afee6c8, and 66–76 ns under concurrent load. No Bun upgrade is recorded between the
earlier 70–71 ns runs and this set; the spread is host load/frequency, not a version-caused
improvement. JS heapUsed delta is 0 KB.

### Two-lane confirmation

The reader's hot path uses `Uint32Array` key words (`loginKeyWords`) and `Int32Array` net words
(`netProfitWords`); it has no `DataView.getBigInt64`, `BigInt64Array` or `BigUint64Array`.
`tests/dod6_binary_spine.test.ts` asserts the source form, and independently compares the two-word
net value to `BigInt64Array` on real rows. Ordering is separately tested signed and unsigned
against a BigInt sort. `BUN_JSC_verboseCompilation=1` shows both comparators compiled with **FTL**
after Baseline/DFG, so the sort-order tests are not interpreter-resident.

## Phase 4 — Verification and after counters

After:

| Metric | After |
|---|---:|
| reader creation (warm) | 19–28 ms (first cold run ~63–76 ms) |
| `lookupInto` | 60.8 ns median of 7 runs (59.9–63.1) on Bun 1.4.4+38afee6c8; 66–76 under concurrent load |
| hit `lookup` | 94–156 ns/op (load-dependent; ~95–105 quiet) |
| miss lookup | 180–253 ns/op |
| hot single-login lookup | 56–65 ns/op quiet; up to ~100 under concurrent load |
| JS heapUsed delta, 500k `lookupInto` | 0 KB |
| steady-state `objectCount` delta, 500k | 0 |
| open `extraMemorySize` delta | +86,157 KiB (one 88,198,656-byte ArrayBuffer) |
| JIT differential | JIT-off 12–23× slower; DFG-off 4.5–8×; FTL-off ~1.1–1.8× |

- 371/371 sampled logins produce byte-identical `lookup()` results before/after.
- 41 tests pass (470,854 assertions across the DOD6, weight-tier and enrichment suites): 5,000
  random logins vs the frozen BigInt encoder, 2,000 pack→unpack halves, range-vs-wrapper
  equality, radix slots, header pack/unpack, vendored-schema equality, version/row-capacity
  rejection, truncated-body fail-closed, misaligned/overrun rejection, `lookup`/`lookupInto`
  agreement, decoded base-40 row round trips, the two-lane / packed-handle source contracts,
  `rowOfHandle`, and signed/unsigned sort-order equality against BigInt over MIN, MAX, −1, 0, 2³¹,
  2³² and 1,000 random 64-bit draws.
- Heap snapshot: 84.7 MB retained (the one file buffer), 8,306 JS objects; JS heapUsed delta
  0 KB over 500k calls, steady-state `objectCount` delta 0 after the 14 one-time JIT/code objects
  in the first post-warmup phase. The allocation itself is the one 88,198,656-byte `ArrayBuffer`
  reported in `extraMemorySize` (+86,157 KiB); the ~727 KiB cache-model hot set is the touched
  portion of that buffer, not a second allocation.
- Node/V8 key-encoder comparison (same pure function, `bun build --target=node`):
  Bun 36.8 vs 171.4 ns/op (4.7×); Node 53.0 vs 111.9 ns/op (2.1×). The 32-bit packing win is
  engine-independent; the file-read/mmap part is Bun-specific and was not changed.
- No cache was added or removed.

**Caveat:** the machine was under concurrent load during the after runs. The 7-run 60.8 ns
median (59.9–63.1) was taken at load average 5.3 on 10 logical cores; an earlier set at load
average ~8.8 (four Bun processes and a Python process at 50–70% CPU) produced 66–76 ns. The
recorded runtime for this set is Bun 1.4.4+38afee6c8; no Bun upgrade is recorded between sets,
so the spread is host load/frequency, not a version-caused improvement. The JIT ratios, CPU-time
key-variant benchmark (range 38–58 ns CPU vs wrapper 46–70 ns CPU), JS heapUsed delta, and
byte-identical output are the stable evidence.

**Open typecheck item:** `lib/bridge_and_channel_router.ts` (untracked) has 3 type errors (lines
71, 92, 689). The DOD6 source files and tests in this audit typecheck clean, but repo-wide
typecheck is not clean while that file is present. It is not part of this change and needs a
separate fix.
