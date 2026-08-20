# promptlab — arm-vs-arm comparison with mechanical guards

A comparison harness that refuses to emit a number it cannot justify.

## Why it exists

On 2026-08-19 an evening of ablations produced nine separate process failures,
each of which corrupted a result before being noticed:

| failure                                | consequence                                           |
| -------------------------------------- | ----------------------------------------------------- |
| buffered stdout                        | 20 minutes blind; a working run killed on a bad guess |
| tool text changed between harnesses    | whole ladder invalid — baseline went 3/3 → 0/3        |
| levels inserted at index 0             | the gate ran L6 while labeled "L0"                    |
| case timeout truncated trials          | denominator silently 8 instead of 9                   |
| timeout `×` read as capability failure | claimed an arm failed that had passed 2/2             |
| unseeded temp 0.2 at n=3               | 1–2 trial differences read as signal, twice           |
| pre-commit hook ran vitest mid-eval    | contaminated a timing measurement                     |
| Python probe ≠ real loop               | three findings did not transfer                       |
| lid close                              | killed a run mid-sweep                                |

None was a reasoning error about SideCar. All were instrument errors. The
response is not "be more careful" — it is guards that fail loudly.

## The guards

1. **Manifest per run** — model, seed, temperature, num_ctx, cases, trials,
   timeout, the ablation axes, and **hashes of the actual system prompt and tool
   catalog bytes**. `assertComparable()` permits a difference only in the
   declared axis; a surface hash that moves for any other reason invalidates the
   comparison.
2. **Denominator assertion** — `outcomes.length === expectedTrials`, or the arm
   is INVALID. A short denominator is never silently scored.
3. **TIMEOUT is its own outcome** — never folded into FAIL. A timeout says the
   configuration is too slow, which is a result about the configuration.
4. **Fisher's exact on every comparison** — small-n binary outcomes are exactly
   where eyeballing misleads. Differences that cannot be distinguished from
   sampling print `INCONCLUSIVE`.
5. **`trialsNeeded()`** — size the sweep before running it instead of
   interpreting it hopefully afterwards.
6. **Seeding** — unseeded runs warn; unseeded _and_ non-zero temperature warns
   harder, because repeat runs of the same config will disagree (observed: the
   same arm scored 0/3 and 2/3 an hour apart).

## Usage

```
npm run promptlab -- [--case <id>] [--trials <n>] [--file <path>]
```

Reads the trajectory JSONL every eval run already writes, groups records into
arms **by what they ran** (system-prompt hash + tool-catalog hash + RAG on/off,
never a label someone typed), and reports each pair with Fisher's exact.

Real output from the two shapes this session produced:

```
# large-file-no-path
  10/10   sys:sysA tools:toolA rag:off
   4/10   sys:sysA tools:toolA rag:on
  ... 10/10 vs 4/10 — p=0.011 CONCLUSIVE

# large-file-already-correct
   2/3    sys:sysA tools:toolA rag:off
   0/3    sys:sysA tools:toolA rag:on
  ... 2/3 vs 0/3 — p=0.400 INCONCLUSIVE (within sampling noise)
  trials/arm needed to resolve 0.67 vs 0.00: 6
```

The second is the shape that was reported as a finding twice before being
retracted. An INCONCLUSIVE verdict is not a dead end — the trials-needed line
turns it into a sample-size decision.

## Status

`guards.ts`, `manifest.ts` and `compare.ts` are complete and tested. Records
written before surface recording existed are grouped as `unrecorded-surface`
and reported as unattributable rather than silently mixed into an arm.
