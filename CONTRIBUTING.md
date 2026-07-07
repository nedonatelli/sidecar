# Contributing to SideCar

## Development setup

```bash
git clone https://github.com/nedonatelli/sidecar.git
cd sidecar
npm install
npm run compile   # TypeScript compilation
npm run test      # Run all tests
```

## The coding loop

1. **Branch off `main`.** Never commit directly to `main`. Commit meaning comes from the
   conventional-commit prefix, not the branch name.
2. **Complete implementations only.** No stubs, `TODO`, or placeholder code. Don't add error
   handling / fallbacks / validation for scenarios that can't happen.
3. **Match the surrounding code** — comment density, naming, idiom. Comment only when the
   _why_ is non-obvious; never narrate _what_ the code does.
4. **Co-locate tests** (`foo.ts` → `foo.test.ts`). New files should hit ≥80% coverage, and no
   change may drop a CI coverage metric below the floor (**70 / 63 / 67 / 71** —
   stmts / branches / funcs / lines, enforced in `vitest.config.ts`).
5. **Run `npm run check` before every commit** (see [Verification](#verification--the-test-pyramid)).
   Pre-commit hooks run a narrower subset automatically — don't rely on them alone.
6. **Conventional commits** (`fix(agent): …`, `refactor(config): …`, `test(eval): …`) with a
   `Co-Authored-By` footer on AI-assisted commits.
7. **Never push or tag without an explicit request.** Committing when asked is fine; pushing
   and tagging are outward-facing and need a specific go-ahead.

**Refactors preserve the public surface.** When decomposing a large file, keep every caller
working by re-exporting from the original module (barrel pattern: `export * from './foo/x.js'`
or re-exported types). A green **full** suite after the split is the proof that "no behavior
change" holds.

## Project structure

```
src/
  agent/          # Agent loop, tool executor, sub-agents, memory, skills
  config/         # Settings, workspace index, constants, trust, reachability
  ollama/         # LLM backends (Ollama, Anthropic, OpenAI, Kickstand)
  webview/        # Chat UI handlers, state management, webview HTML
  terminal/       # Shell session management
  github/         # GitHub API and auth
  edits/          # Diff preview, inline edit providers
media/
  chat.js         # Webview frontend (vanilla JS)
  chat.css        # Webview styles
  mermaid.min.js  # Mermaid diagram renderer
skills/           # Built-in skill definitions (markdown)
docs/             # Documentation site (GitHub Pages)
scripts/          # Automation scripts
```

## Key internal modules

| Module                           | Purpose                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/constants.ts`            | Centralized magic numbers (token estimation, context budgets, limits)                                                                                                                                                             |
| `config/workspaceTrust.ts`       | Per-session trust decisions for workspace-level configs                                                                                                                                                                           |
| `config/providerReachability.ts` | Health check for all LLM provider types                                                                                                                                                                                           |
| `agent/tools/`                   | Tool registry, definitions, and executors — `tools.ts` is a thin composer over per-subsystem files (`fs`, `search`, `shell`, `git`, `diagnostics`, `knowledge`, `settings`)                                                       |
| `agent/executor.ts`              | Tool approval flow, permission checks, special tool routing                                                                                                                                                                       |
| `agent/loop.ts` + `agent/loop/`  | Main agent iteration loop. `loop.ts` is a thin 255-line orchestrator; every responsibility (state, compression, streaming, cycle detection, tool execution, policies, finalization) lives in a focused helper under `agent/loop/` |

## Verification — the test pyramid

SideCar _is_ an agent loop wired to fragile model runtimes, so "it compiles and unit tests
pass" is necessary but not sufficient. Match the tier to the risk of the change; run all
tiers before a release.

| Tier  | When                              | What                                                                                                                   | Gate                                   |
| ----- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **0** | every commit                      | `npm run check`                                                                                                        | all green                              |
| **1** | pre-release · no model            | `npm run build` · `npm run package` · `npm run verify:package` · `npm run test:coverage` · Stryker (`npx stryker run`) | `.vsix` verifies; mutation score holds |
| **2** | pre-release · needs a local model | `eval:smoke` on `qwen2.5-coder:7b` + a differential 2nd model                                                          | **zero infra errors**                  |
| **3** | periodic campaign                 | `bench:bfcl`, `bench:swe:predict`                                                                                      | tracked over time                      |

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage (must stay above the CI floor 70/63/67/71)
npm run check         # Tier 0 gate: compile + compile:bench + lint + format + test
```

### Tier 1 — mutation testing ("verify-the-verifier")

Stryker (`stryker.conf.json`) mutates the moat-critical modules — the completion gate and its
`completionGate/` submodules, `keepBestRatchet`, `analyticBounds`, `injectionGuard`,
`jsonRepair` — to prove their tests _catch faults_, not just pass. It's on-demand (too slow
for CI): `npx stryker run`. If you change one of these modules, re-run it and don't let the
score regress. **If you move moat code** (e.g. a decomposition), add the new file paths to the
`mutate` list — otherwise the hardening silently stops covering it.

### Tier 2 — "zero infra errors" is the real gate

A model scoring 4/9 on evals is fine; a model _crashing the agent loop_ is a release blocker.
When running evals, distinguish model misses (acceptable) from infrastructure failures
(blocking):

- HTTP 500s / malformed-output crashes
- `Unknown tool` (tool-call parsing or dispatch bug)
- an empty final answer (the answer was trapped in the thinking channel)
- thrash to `maxIterations` with no progress

Run on **at least two models** — a differential is how you tell a SideCar bug (fails on every
model) from a model quirk (fails on one). Targeting:

```bash
SIDECAR_EVAL_BACKEND=ollama SIDECAR_EVAL_MODEL=qwen2.5-coder:7b npm run eval:smoke
SIDECAR_EVAL_CASE=<case-id> ...   # run a single case fast
```

## Version bumping

Use the automated bump script to update the version across all files:

```bash
npm run bump 0.40.0 "brief summary of what changed"
```

This script:

1. Runs the test suite and captures pass counts
2. Counts tools and skills from source code
3. Updates `package.json`, `CHANGELOG.md`, `ROADMAP.md`, `README.md`
4. Updates `docs/index.html` (landing page stats), `docs/agent-mode.md`, `docs/troubleshooting.md`
5. Prints a summary for review before committing

After running the script, review the CHANGELOG entry and expand it with proper sections (Added, Fixed, etc.) before committing.

## Release checklist

A release has two halves: **verification** (does it work?) and **content sync** (do the docs
reflect it?). Do the verification first — run [the test pyramid](#verification--the-test-pyramid)
Tiers 0–2 (all green, zero infra errors) and Tier 1 packaging (`.vsix` builds and
`verify:package` passes). Only then do the doc sync below.

Every version bump is a content change, not just a number change. The bump script handles the mechanical updates (version strings, stat counts, landing-page stats); feature-level documentation sync is manual and must be done **before** tagging. Run through this list in order:

### Content sync (manual — required)

For every feature, config key, command, slash command, or user-visible behavior change shipped in the release, verify each doc is accurate. If the release added a feature to a subsystem the doc covers, update the doc:

| Surface                        | When to update                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md` "Features" section | Any user-visible capability added or meaningfully changed. Add a dated `*(new in vX.Y)*` bullet rather than silently editing an existing one.                                                                                                                                                                                                                       |
| `docs/overview.md`             | Any headline feature. The overview is the first thing a new user reads — headline features missing from it are invisible.                                                                                                                                                                                                                                           |
| `docs/index.html` (landing)    | Stats (test/tool counts) and the hero version string are bumped mechanically by the script. **Manually** review the hero copy and the **capability comparison table** on any headline feature or competitive-positioning change — the script does not touch prose or the table.                                                                                     |
| `docs/slash-commands.md`       | Any new `/command` or `SideCar: <Command>` palette entry.                                                                                                                                                                                                                                                                                                           |
| `docs/agent-mode.md`           | Any new agent mode, approval tier, dispatch mechanism, or tool surface.                                                                                                                                                                                                                                                                                             |
| `docs/configuration.md`        | Any new `sidecar.*` setting. New config keys without a docs entry are unsupported; list them with defaults, clamp ranges, and a one-line description of what they control.                                                                                                                                                                                          |
| `docs/extending-sidecar.md`    | Any new extension surface (a new way for third parties to add skills, facets, tools, MCP servers, hooks, or SDK contributions).                                                                                                                                                                                                                                     |
| `docs/hooks-and-tasks.md`      | Any change to `sidecar.hooks`, `sidecar.eventHooks`, or `sidecar.scheduledTasks` semantics.                                                                                                                                                                                                                                                                         |
| `docs/rag-and-memory.md`       | Any retrieval, memory, or context-injection change.                                                                                                                                                                                                                                                                                                                 |
| `docs/security-scanning.md`    | Any secrets-pattern catalog update, new vulnerability detector, or trust-model change.                                                                                                                                                                                                                                                                              |
| `SECURITY.md`                  | Supported-version table is bumped mechanically by the script. **Manually** verify: the `SECRET_PATTERNS_VERSION` "unchanged through vX.Y.Z" line (advance the version only if the catalog truly didn't change; bump the number + add a change-history row if it did), the threat-model sections (any new tool / shell / MCP / write surface), and dependency names. |
| `docs/mcp-servers.md`          | Any change to MCP transport handling, lifecycle, or tool surface.                                                                                                                                                                                                                                                                                                   |
| `CLAUDE.md`                    | Any architectural change: new subsystem under `src/`, new major integration point, new config-layer concern. Future AI collaborators read CLAUDE.md before they read any other doc.                                                                                                                                                                                 |
| `ROADMAP.md`                   | Flip the shipping release entry to `✅ *shipped YYYY-MM-DD*` format with Features shipped / Refactor beat shipped / Coverage ratchet / Tag lines; list deferrals folded into a new `vX.Y deferrals folded into vX.Z+` block.                                                                                                                                        |

### Sanity check (quick)

Before tagging, run:

```bash
grep -l "vX.Y\|<headline feature name>" docs/ README.md CLAUDE.md ROADMAP.md
```

If the headline feature of the release doesn't appear in at least `docs/overview.md`, `README.md`, and the feature's subsystem doc, the release isn't ready to tag.

### Automated checks (CI)

- `npm run check` (compile + lint + test) must pass on main before the release commit.
- The publish workflow (`.github/workflows/publish.yml`) runs on tag push. Don't push the tag until `npm run check` is green locally.
- A format drift in a new test file or doc will cause CI's format-check job to fail even if Publish succeeds — run `npx prettier --check 'src/**/*.ts'` locally before committing.

### Why this matters

In v0.66 the Typed Sub-Agent Facets feature shipped without appearing in `docs/overview.md`, `docs/slash-commands.md`, `docs/agent-mode.md`, or `docs/configuration.md` — a user who only reads the docs would have no idea the feature existed. The docs-sync step is the difference between "we shipped" and "users can find it."

## Building and packaging

```bash
npm run build     # Compile TypeScript + bundle + copy grammars
npm run package   # Build + create .vsix package for distribution
```

## Adding a new tool

1. Define the tool schema in `src/agent/tools.ts` (follow existing patterns)
2. Implement the executor function
3. Add to `TOOL_REGISTRY` array
4. If the tool needs approval, set `requiresApproval: true`
5. If the tool needs special handling (like `ask_user`), add a case in `executor.ts`
6. Add tests in the appropriate `.test.ts` file
7. Update `docs/agent-mode.md` tool table and `README.md` tool registry
8. Run `npm run bump` to update tool counts everywhere

## Debugging methodology

Most of SideCar's subtle failures live in the interaction between the agent loop and a
specific model runtime, where a unit test can't see them. This is how they get found:

- **Reproduce at the lowest layer first.** Before blaming SideCar, hit the raw API
  (`curl` / a small script against Ollama's `/api/chat`). If it fails there, it isn't our code.
- **Bisect one variable at a time** — tool count, angle-brackets in schemas, streaming vs.
  not, `think` on/off, minimal vs. full system prompt. One change per run.
- **Differential across models** — the single most useful move. Run the same failing case on a
  second model: fails on both → SideCar; fails on one → that model/runtime.
- **Read trajectories, not pass/fail.** The failure _reason_ and the event sequence (which
  tools were called, was the answer in `thinking`, did it thrash) is where the bug is.
  Pass/fail alone repeatedly mischaracterizes the cause.
- **Instrument when the minimal repro won't trigger.** Add temporary `console.error` DIAG logs
  at the exact yield/dispatch point, run the real case, read the numbers, then **revert the
  instrumentation** (`git checkout <file>`). Never ship DIAG.
- **Log full stdout/stderr to files** and read the whole thing — don't `grep` diagnostics away
  before you've seen them.
- **Correct the record when a hypothesis is disproven.** State it plainly and narrow the
  search. A wrong-but-explicit hypothesis is progress; a vague one isn't.
- **A bug found via eval is a real product bug.** Fix it in the product _and_ add a fast unit
  test that pins the fix — the parser/dispatch/loop logic is unit-testable even when the live
  condition is rare and stochastic.

## Eval-harness principles

The eval harness (`tests/llm-eval/`) measures whether a model can _address the task_, played
by a cooperative user. Keep it that way:

- **Assertions tolerate paraphrase.** `finalTextContains` accepts any-of synonym groups
  (`[['greet','hello','welcome']]`), not brittle literals. Keep specific-value and identifier
  checks strict; loosen only paraphrasable concepts.
- **The harness answers `ask_user`.** A clarifying question is legitimate agent behavior —
  better than guessing wrong or thrashing — so the harness plays a helpful user via `clarifyFn`
  and lets the model continue. Cases can supply a specific `clarifyResponse`.
- **Thinking is disabled for eval speed** (`SIDECAR_DISABLE_THINKING=true`, set by the
  `eval:*` scripts) — measured to give no agentic-accuracy gain at ~4× the latency for the
  local reasoning models we test.
- **Baselines.** `qwen2.5-coder:7b` is the reliable local agent baseline (confirm a change is
  safe against it); `qwen3.5:latest` is a good stress model (it exercises the fragile
  Ollama-runtime paths). Model-specific findings live in the eval notes / project memory.

## Code style

- TypeScript strict mode
- No unnecessary abstractions — three similar lines > premature helper
- Use `constants.ts` for magic numbers, not inline values
- Validate at system boundaries (user input, LLM output), trust internal code
- Security: always sanitize paths, never auto-approve tools without UI
