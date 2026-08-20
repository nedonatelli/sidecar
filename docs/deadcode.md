# Dead-code detection

`npm run deadcode` runs [knip](https://knip.dev) over `src/`, `tests/` and
`bench/`, reporting unused files, exports, types and dependencies.

## Why it exists

The 2026-08-20 harness refactor left four dead imports behind. `eslint`'s
`no-unused-vars` caught those because they were _imports_ — but a dead **export**
is invisible to it, and the same refactor left `bench/promptlab`'s entire
comparison API (`compareArms`, `assertComparable`, `trialsNeeded`,
`fisherExactP`) with no caller at all. That was found by hand-auditing, which
does not scale and does not run in CI.

## Reading the output

Not every finding is dead. Two categories are deliberately configured out
because they are false positives here:

- **`src/agent/tools/**corpus**/**`** — byte-level fixtures (BOM, CRLF, NBSP,
trailing whitespace) that are read as *content*, never imported. They are
listed in `src/config/indexExcludes.ts` for the same reason.
- **`tests/llm-eval/fixtures/**`** — historical snapshots kept for reference,
e.g. `completionGate.pre-polyglot.test.ts`, which has deliberately stale
  imports and is not run.

`src/sdk/index.ts` is an entry point, not dead code: it is the public
`@sidecar/sdk` surface and has no internal caller by design.

## A limitation worth knowing

`ignoreExportsUsedInFile` is on, and test files are entry points — so an export
used **only by its own tests** counts as used. That is usually right, but it
means knip will NOT tell you "this module has no production consumer". Finding
that still requires asking the question directly; it is how promptlab's
comparison API sat tested-but-unused.

## Current baseline

22 findings (14 unused exports, 8 unused exported types) as of 2026-08-20. They
have not been triaged — several look like public API kept deliberately
(`getShellSession`, `RECOMMENDED_LOCAL_MODEL`) and several look genuinely dead
(`src/agent/retrieval/index.ts` re-exports, `src/arena/types.ts`). Triage them
before treating the count as a ratchet.
