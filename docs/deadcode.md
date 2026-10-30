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

## Test-only modules: `npm run deadcode:prod`

`ignoreExportsUsedInFile` is on, and test files are entry points, so a module
used **only by its own tests** counts as used. That is how promptlab's
comparison API sat tested-but-unused, and how nine `src/` files with no
production caller survived until #366: `src/edits/{apply,parser,diffPreview}.ts`,
`src/completions/debounce.ts` and `src/sources/registry.ts`, each with a test.

`npm run deadcode:prod` closes that gap for whole files. It reads
`knip.production.jsonc`, where only `src/extension.ts` (the bundle's entry)
and `src/sdk/index.ts` are entry points, and reports any `src/` file nothing
reachable from them imports. Test support and the `src/` modules that only the
eval and SWE harnesses use are listed there by name. It runs in `npm run check`
and CI.

It checks files only. The same config without `--include files` also lists
exports used only by tests (67 on 2026-10-30); those are not triaged yet.

## Baseline: zero, enforced in CI

The 22 findings recorded on 2026-08-20 (plus one unused file) were triaged on
2026-10-17, and CI now runs `npm run deadcode` on every push and pull request,
so any finding is new.

- **Deleted, no caller anywhere:** `getDedupExemptToolNames` (a duplicate:
  each backend derives the dedup-exempt set inline from the same
  `nondeterministicOutput` flag), `raceAbort`, `getMcpServerInstance` (and the
  module variable only it read), `getAgentModDecorationManager`,
  `getShellSession` (the free function; `ToolRuntime.getShellSession` stays),
  `passCaretK`, `llmJudgedPrecision`, `allFixtureSymbols`, `ArenaMode`,
  `ArenaLane`, `ArenaTurn`, `FacetReviewableResult`.
- **Re-exports removed, originals kept:** five in `src/agent/retrieval/index.ts`
  (callers import from the defining modules), `runWithCap` from
  `loop/multiFileEdit.ts`, `NO_PLAN_SENTINEL` from `loop/dispatchToolUses.ts`.
- **knip's blind spots fixed:** `GitHubAction` was used only through inline
  `import('…').GitHubAction` types, which knip does not follow; it is now a
  normal type import. `src/test/integration/**/*.etest.ts` is an entry point
  (`.vscode-test.mjs` runs those files).
- **Kept on purpose**, tagged `@public` (knip honours it, re-exports included):
  `RECOMMENDED_LOCAL_MODEL`, and the `applyZenFilter` re-export from
  `retrieval/index.ts`, which `zenFilter.test.ts` pins as part of the barrel's
  API.

To keep something deliberately unused, tag it `/** @public */` with a reason;
anything else knip reports should be deleted.
