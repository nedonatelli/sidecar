# SideCar — Workstreams (operational tracker)

_The living status board. The three strategy docs are the stable reference —
`sidecar-architecture-and-strategy.md` (why/what), `sidecar-small-model-scaffolding-roadmap.md`
(phases), `sidecar-literature-foundations.md` (grounding). **This** doc is the only
one that churns: it tracks what's built, what's in flight, what's next, what's
parked, and what each claim is measured by. When in doubt about "where are we,"
look here._

**Discipline (from strategy §6): stop widening.** Only items in _Active_ get
built. Everything else is Shipped (done) or Deferred (parked with a reason). A
new idea goes to Deferred with its measuring stick — it does not become Active
until something in Active ships.

---

## Status map

Legend: ✅ shipped · 🔵 in flight · 🟡 partial · ⬜ not started · ⏸ deferred · ❗ needed now

| Workstream                                      | Layer            | Status                                                                                | Measuring stick           |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| Failure taxonomy + diagnostic metrics (F1/F2)   | Measurement      | ✅                                                                                    | `metrics.jsonl`           |
| BFCL failure taxonomy (selection vs args)       | Measurement      | ✅ **`failureClassifier.ts` — ground-truthed axis split; in BFCL report**             | selection/argument share  |
| Per-turn tool subsetting                        | Context economy  | ⏸ **deferred with evidence — measured 0% wrong-function-selection** (see Results log) | selection-error rate      |
| BFCL — model-level tool-use                     | Measurement      | ✅ ran (local models 83–86%)                                                          | BFCL AST subset           |
| SWE-bench ablation harness — system-level       | Measurement      | ✅ built + first no-Docker verdict                                                    | resolve@k                 |
| pass@k / variance discipline                    | Measurement      | ✅ first result (see Results log)                                                     | resolve@k spread          |
| **Pareto-safe scaffolding (keep-best ratchet)** | **Verification** | ✅ **core + loop wiring shipped (opt-in `scaffolding.keepBest`); 36 tests**           | **over-engineering rate** |
| **Fix under-powered measurement instrument**    | **Measurement**  | 🟡 **stats layer shipped (Wilson CI + McNemar exact); seed/temp + n next**            | n≥20–30/arm, IID          |
| Run provenance (seed / temp / model+quant)      | Measurement      | ✅ seed pin (`agentSeed`/env) + `run.manifest.json` in the SWE driver                 | —                         |
| Constrained-decoding _repair_                   | Reliability      | ✅                                                                                    | schema-validity           |
| Schema-constrained tool calls (Phase 1)         | Reliability      | ✅ **resolved: repair-only + per-tool schema; tier-1 strengthened**                   | BFCL on/off               |
| Tier-aware verification (D2/C4/E2)              | Verification     | ✅                                                                                    | —                         |
| Mutation testing (verify-the-verifier)          | Verification     | ✅ **core + `mutation_test` tool (opt-in); 31 tests; tool count 83→84**               | mutation score            |
| Numerical contract _checking_                   | The vertical     | ✅ (v0.115)                                                                           | contract coverage         |
| Analytic-bound gate (§5 pillar 2)               | The vertical     | ✅ **`analyticBounds.ts` + gate (opt-in); 26 tests** — the MOAT                       | catches unenforced bound  |
| Property-based tests (§5 pillar 3)              | The vertical     | ✅ **`propertyTests.ts` + `synthesize_property_test` tool; 18 tests**                 | catches seeded bug        |
| Shape/dtype/unit constrained _decoding_         | The vertical     | ⬜ frontier                                                                           | —                         |
| On-demand capability DB (§2.2–2.5)              | Architecture     | ⏸                                                                                     | recall@k, q               |
| Prompt-transform hook (§2.6)                    | Architecture     | ⏸                                                                                     | CPS delta                 |
| Code graph — query interface / expansion        | Cross-cutting    | ✅ **`query_code_graph` tool — callers/callees/refs/type-users/neighborhood**         | SWE-bench delta           |
| Injection hardening                             | Cross-cutting    | ✅ **`injectionGuard.ts` — detect+fence at tool-result boundary; 15 tests**           | AgentDojo                 |
| Orchestrator-strength routing                   | Cross-cutting    | ⏸                                                                                     | —                         |
| Gate → trajectory flywheel (LoRA, Ph 6)         | Model adapt      | ⏸                                                                                     | —                         |
| Literature-doc citation verification            | Docs             | ❗ open                                                                               | IDs resolve on arXiv      |

---

## Active (near-term sequence)

Mirrors strategy §6, with **do-no-harm promoted to the front** (a harmful scaffold undermines the
thesis more than a missing lever does). Each produces a citable number.

0. **Pareto-safe scaffolding (keep-best ratchet)** — the completion gate demonstrably **over-engineers**
   (gate-only reliably emits ~32KB test-churn patches where bare stays ~450b; stable behavioral signal).
   Whether that lowers resolve is unprovable at current n (see Results — resolve is noise-dominated), so the
   fix is justified by mechanism + behavior, not a resolve delta. Fix: gate every scaffold-driven change on
   **non-regression** — snapshot → apply → re-verify → keep only if the signal is ≥ before, else revert
   (keep-best moves into the harness, per §2.1); makes over-engineering _safe_. **Signal to optimize: patch
   minimality / over-engineering rate** (measurable at small n), not resolve harm rate (isn't).
   - **DONE:** pure decision core + snapshot/restore primitive — `src/agent/loop/keepBestRatchet.ts`
     (`decideRatchet` → keep / revert-regression / revert-overengineering; reads the gate's existing
     `projectTestsPassed`/`passingTestFiles` signals so it runs NO tests of its own; injected snapshot IO so
     it's fs/shadow/audit-agnostic). 19 unit tests, incl. the 32KB test-churn case. eslint+tsc clean.
   - **DONE (loop wiring):** `keepBestRatchetWiring.ts` + 3 touch points in `loop.ts` — (1) baseline each
     write target's pre-edit content before dispatch, (2) arm at the first completion-gate reprompt that fires
     with edits present, (3) at natural termination evaluate against the gate signal and revert regressed /
     over-engineered scaffold-tail changes via a `cwdOverride`-aware workspace.fs writer (deletes files created
     in the tail, restores pre-existing ones, keeps good pre-scaffold work), surfacing the revert to the user.
     Opt-in `sidecar.scaffolding.keepBest` (+`keepBestOverEngineerBytes`, default 4KB); auto-off in audit mode
     (in-memory buffer). Skips on user-abort. 36 unit tests, 490 loop tests green, eslint+tsc clean.
   - **NEXT (measure it):** run the SWE ablation with keepBest on/off as a third arm to quantify the
     over-engineering-rate drop (mean scaffold-added patch bytes with no pass-signal gain → ~0) and confirm
     no resolve regression. Rides on the campaign now unblocked on the Vast box.
1. **Fix the measurement instrument FIRST (it's under-powered).** One task × pass@5 can't detect a real
   effect — a single arm swings 20↔80% between runs. Need: n≥20–30 per arm across several tasks, IID checks
   (back-to-back runs may share GPU/session state), run provenance (seed/temp). Until the instrument is
   trustworthy, **no resolve-level lift/harm claim is defensible** — lean on behavioral signals meanwhile.
   - **DONE (statistical rigor):** `bench/swe/stats.ts` — Wilson score intervals per arm + **McNemar's exact
     paired test** on the discordant pairs (rescued vs regressed; the only pairs carrying effect info) + a
     paired-difference CI on the lift. `computeAblation` now fills a `significance` block; `report.ts` leads
     with `lift = ±X% (95% CI […]), McNemar p=…, significant/NOT`, and prints a hard **honesty gate** — when
     p≥0.05 it refuses to claim a resolve lift, names the discordant count, and points to the behavioral
     signals instead. 14 stats tests vs known values (5/0→p=0.0625, 8/2→0.109, Wilson 5/10→[.237,.763]).
     This is what makes the campaign output defensible the moment it lands.
   - **DONE (provenance/reproducibility):** pinnable generation seed — `sidecar.agentSeed` (+ `SIDECAR_AGENT_SEED`
     env for headless) threaded into the Ollama backend's request options; the SWE driver writes a
     `run.manifest.json` (model, seed, temperature, dataset, N, arms, maxIters, retrievalTopK, node, timestamp)
     so every resolve/lift number is reproducible + attributable. Backend seed test added (30 green).
   - **NEXT:** scale tasks toward a powered discordant count (the campaign does this); add an IID/order-effect
     check (run 1 resolved more than 2–5 last time — back-to-back runs may share GPU/session state).
2. **Phase 1 — schema-constrained tool calls** — core built for BFCL; run BFCL on/off
   (schema-validity → ~100%, accuracy up-or-flat, watch the alignment tax), then port to
   the agent loop if the delta justifies it.
   - **RESOLVED (Open Question answered):** the BFCL latency tax came from the union `oneOf` grammar over ALL
     functions — a benchmark artifact. The agent-loop repair path (`toolCallRepair.ts`) already constrains
     with the **single tool's schema** (tiny grammar) and only on an already-malformed call, so it has no such
     tax. Verdict: **do NOT port full-constrained decoding**; keep repair-only + per-tool schema. Constrain at
     the action boundary only, and only when latency is affordable — both already true.
   - **DONE (make repair cheaper still):** strengthened tier-1 heuristic repair (`jsonRepair.ts`, zero-LLM) so
     the tier-2 LLM regen rarely fires — added **raw-control-char escaping inside string values** (literal
     newlines in multi-line `write_file`/`edit_file` content — the #1 coding-tool malformation, previously
     unrecovered) + NaN/Infinity→null. 5 new tests (16 total). Every call tier-1 now recovers is a call that
     costs no latency, which is the whole point of the "repair-only" verdict.
3. **Verify-the-verifier** — mutation testing on the completion gate. Cheapest credibility.
   - **DONE (core):** `src/agent/mutation/` — `mutationOperators.ts` (single-point mutants: relational /
     arithmetic / logical / boolean, with string+comment MASKING so we never mutate inside a literal;
     triple-quote aware; conservative on `=>`/`++`/`*args`), `mutationScore.ts` (killed/survived/no-coverage/
     error → score = killed/viable, surfaces survivors as the credibility gaps), `mutationRunner.ts`
     (baseline-green gate → write mutant → run test → classify → always-restore, injected IO). 24 tests incl.
     a strong-suite-kills-all vs weak-suite-survives-all pair. eslint+tsc clean.
   - **DONE (tool wiring):** `mutation_test` agent tool (`src/agent/tools/mutationTest.ts`) — real fs
     (`workspace.fs`, `cwdOverride`-aware) + `runVerificationCommand`, bounded by a mutant cap + per-test
     timeout, always-restore. Opt-in `sidecar.mutation.{enabled,maxMutants,testTimeoutMs}`; registered + gated;
     tool count 83→84 (pinned test + docs swept). 7 tool tests (baseline-fail / strong-kills-all /
     weak-survives-all / cap). Reports mutation score + surviving mutants as the actionable coverage gaps.
   - **NEXT (optional):** behavioral-gate escalation — when the gate can't tell a test is hollow, mutation-test
     the edited file; a surviving mutant proves the test is inadequate. Deferred until demand.
4. **Numerical vertical hardening** — Hypothesis property-based tests + analytic-bound gate,
   riding on Phase 1. The moat.
   - **DONE (analytic-bound gate — §5 pillar 2, the strategy's designated "single move"):**
     `src/agent/analyticBounds.ts` — parses declared value bounds (`# bounds: 0 <= result <= 1`,
     `# invariant: sum(result) == 1`, `@bounds("result >= 0")`, docstring `Bounds:`), classifies
     (range/lower/upper/sign/conservation), detects whether the code ENFORCES them (assert/clip/raise), and
     emits the exact array-safe assertion to close a gap (`assert np.all(result >= 0) and np.all(result <= 1)`).
     Wired into the completion gate (`gate.ts`) as an advisory-always + opt-in hard block
     (`sidecar.analyticBounds.gate`), riding alongside the numerical-contract gate. 26 tests; 518 loop-area
     tests green; tsc+eslint clean. This is "prove the physics is right, not just that tests pass" as a gate —
     the most defensible item in the program (strategy §5/§6).
   - **DONE (§5 pillar 3 — property-based test synthesis, COMPLETES the vertical):** `src/agent/propertyTests.ts` - `synthesize_property_test` tool. Declaration-driven (`# property: symmetric|idempotent|monotonic|
non-negative`, plus reuse of `# bounds:`/`# invariant:` from pillar 2 — a bound IS a property). Emits a
     COMPLETE, runnable Hypothesis test: numpy-array `@given` strategies (one per param, parsed from the def
     signature), the declared assertions (symmetry calls swapped args, idempotence checks f(f(x))==f(x),
     bounds use the pillar-2 assertion), dotted module import. 18 tests; tool count 84→85. **All three §5
     pillars now shipped** — shape/dtype/unit contracts (v0.115) + analytic-bound gate + property tests. This
     is the strategy's "single move" (§6) delivered end-to-end: prove the physics, prove the math.

---

## Decision log

- **Default model = `gemma4:e4b`** (most-dogfooded; BFCL-competitive; ministral-3 is the lighter alt).
- **Benchmarking = BFCL (model-level) + SWE-bench ablation (system-level).** Scoring delegated to
  the official `swebench` Docker harness; host-local venv scoring works for light pure-Python tasks.
- **Point estimates lie.** Every resolve-level claim needs pass@k + provenance (see Results log —
  flask flipped run-to-run; scaffolding was net-negative on an easy task).
- **Scaffolding value is task-difficulty-dependent** — rescues hard tasks, can over-engineer easy ones.
  A headline lift number requires a difficulty-spanning task set, not one task.
- **Scaffolding must be Pareto-safe (do no harm).** It may never turn a passing run into a failing one.
  Enforced by keep-best/non-regression gating on every intervention + a harm-rate metric that gates
  shipping. A scaffold that relies on the _model_ to execute extra work well is unsafe by design; the
  keep-best judgment belongs in the _harness_.
- **Constrain at the action boundary only** (A2) — grammar the tool call, never the reasoning.
- **Scaffold is versioned (`SCAFFOLD_VERSION`, semver).** A benchmark number is only comparable across runs
  with a matching scaffold version AND active-mechanism snapshot. Bump MAJOR on mechanism add/remove or changed
  verification semantics, MINOR on new-flag/arm-composition change, PATCH on within-mechanism tuning. Stamped
  into every `run.manifest.json` (per-arm `describeScaffold`) + the ablation report. Registry:
  `docs/scaffold-versions.md`; code: `src/agent/scaffoldVersion.ts`. Current = **2.0.0** (verification-vertical
  - do-no-harm). Bumping it + updating the registry is part of the release checklist when the scaffold changes.

---

## Deferred (parked, with reason)

- **On-demand capability DB (§2.2–2.5)** — biggest speculative build; §6 sequences it last. Build once
  measurement proves it helps (recall@k, q).
- **Per-turn tool subsetting (§2.2/B1) — deferred WITH evidence, not just unmeasured.** BFCL failure-taxonomy
  instrumentation (see Results log) found 0% wrong-function-selection errors in a real 100-case run — the
  failure mode subsetting fixes doesn't show up. Building it now would add real risk (silent starvation: the
  model can't miss a tool it never saw) for a problem not observed. Re-open if: more models show selection
  errors, a distractor-heavy BFCL variant shows lost-in-the-middle at 80+ tools, or an in-loop signal surfaces it.
- **Prompt-transform hook (§2.6)** — clean design, no demand yet.
- ~~**Injection hardening**~~ **DONE** — `src/agent/injectionGuard.ts`: detects the classic injection shapes
  (instruction-override, role-hijack, fake system turns, permission-manipulation, exfiltration-lure) and
  FENCES flagged tool output in an untrusted-data boundary at the single tool-result→message boundary
  (`messageBuild.guardToolResults`, wired in `loop.ts` after capping). Treat-all-tool-output-as-data, per §4;
  non-blocking (fence + 🛡️ notice), default-on (`sidecar.injectionGuard.enabled`), clean output untouched.
  15 tests; 562 loop-area tests green. Next credibility rung would be an AgentDojo run.
- **Orchestrator-strength routing, LoRA flywheel** — as metrics demand.
- **Code-graph query interface — DONE:** `query_code_graph` tool (`src/agent/tools/codeGraphQuery.ts`) exposes
  the tree-sitter call/type graph as a relationship query — callers, callees, references, type-users,
  neighborhood — complementing `analyze_impact` (downstream blast radius) with the exploratory both-directions
  view (the "understand the edit before making it" §4 need). Read-only; 9 tests; tool count 85→86.

---

## Open questions (gate decisions)

- Verify every post-2501 citation in the literature doc against arXiv (credibility-critical).
- Plan externalization: harness or context? (gates Phase 3.)
- ~~Does the BFCL constrained-decoding delta justify the agent-loop port?~~ **Answered: NO.** Correction to an
  earlier note here: the BFCL harness's schema was ALREADY per-case (`c.functions`, typically 1–4 candidates),
  not a whole-dataset union — verified by reading `runner.ts`/`backend.ts` directly. The clean small-sample
  follow-up (Results log) narrows the real mechanism: the tax tracks **schema/parameter complexity** (nested
  objects, arrays, many properties), not request count or union size — negligible on simple schemas, real on
  complex ones. Production repair already uses a single tool's (mostly simple) schema, repair-only — this
  result says that's cheap, which is why it stays the design. Strengthened tier-1 heuristic repair too (see #2).

---

## Results log

- **🏁 SWE-bench Lite ablation (scaffold 2.0.0, qwen2.5-coder:7b, 50 tasks, Modal-scored via swebench 4.1.0).**
  scaffold-on **2/50 (4.0%)** vs scaffold-off **2/50 (4.0%)** → **lift +0.0%, McNemar p=1.000, 0 discordant
  pairs — NOT significant.** The honesty gate fired correctly: at 2/50 (7B floor regime) with 0 discordant
  pairs the instrument has no power, and it REFUSES a lift claim rather than printing noise. Usable signal is
  behavioral + a FLAG: scaffold-on terminated ~7.5× faster (50s vs 379s) with MORE empty patches (20 vs 18) —
  the established scaffold made runs bail earlier, not resolve more (investigate: early-give-up vs gate/critic
  early-exit). Note: this arm is the PRE-2.0 mechanism set (no keep-best ratchet / analytic-bound / injection
  guard). Takeaways: (1) the #1 stats work paid off — an honest 0% instead of a lucky point estimate; (2) need
  a powered n (300–500) + a scaffold-2.1 arm to detect a real lift; (3) the bail-early behavior is why do-no-harm
  exists. Full writeup: `sidecar-results-writeup.md` §4.2.
- **Verify-the-verifier: Stryker (TS mutation testing) on our own moat modules.** keepBestRatchet **95.4%**
  (real teeth). injectionGuard **47.1%→72.5%** after hardening (killed 26 untested-alternative-pattern
  mutants; remaining ~22 are equivalent regex mutations, un-killable). completionGate — NOT theater (it kills
  the large majority of mutants) but had genuine unverified branch decisions; **three hardening passes:
  61.1%→65.3%→67.5%→74.7%** (963 mutants; 719 killed / 244 survived at final — cumulative +13.6 points).
  Pass 1: `recordToolCall` failing-result tests (every prior test used a PASSING tool result, so `if (passed)`
  branches were never falsified; 20→12 logic survivors) + `classifyTestResult`/`isAnalysisRequest`
  branch-pinning (→0 logic survivors, fully closed). Pass 2: **adversarial guard-bypass tests** for the 5
  message-walking helpers (`hasReadToolCallForFile`, `hasRunCommandCall`, `hasAnyGroundingToolCall`,
  `firstUserText`, `lastUserText`) — same-shape-but-benign tests can't distinguish "guard correctly skipped"
  from "guard was a no-op with nothing to match anyway"; the fix is a message under the WRONG role with a
  well-formed match, and a non-matching block that coincidentally carries the target field. Pass 3: the
  remaining reprompt-builder functions — **exclusivity assertions** (assert the ABSENCE of section B's wording
  when only section A's findings exist — kills `.length >= 0` mutants that render a section unconditionally):
  `buildGateInjection` 12→1, `buildBehavioralVerificationReprompt` 16→7. **Exclusion-boundary tests** (one
  test per filter clause — `.d.ts`, JS/TS test file, non-source file — each independently excluded):
  `buildBehavioralVerificationReprompt`. **Pluralization tests** (singular vs plural wording, asserting each
  form's ABSENCE in the other case): `buildNoFileWriteReprompt` 16→4, `buildUnverifiedClaimReprompt` 11→8.
  **Directory-prefix test** (every prior test used a bare filename, so `candidateTestFiles`' dir-prefixed
  candidate branch was never exercised): `candidateTestFiles` 9→5. **`lastAssistantText` guard-bypass** (same
  technique as pass 2, applied to the last untouched message-walker, tested indirectly via
  `buildUnverifiedClaimReprompt` since it's private): 16→9. Also added a real-`defaultFileExists`-via-default-
  param test (extended the vscode mock with `Uri.joinPath`) and a `defaultReadFile`-adjacent nested-dir case.
  +19 tests this pass (172→191; +53 cumulative across all three passes, from 138), all green, tsc+eslint
  clean, no regressions (3729 tests across src/agent/). One mutant class deliberately NOT chased: `recordToolCall`'s
  L201 `typeof result.content === 'string' ? ... : ''` ternary is likely equivalent in practice — the type
  system guarantees `.content` is always a string, so the ternary's false branch is unreachable for any
  realistic input. **Remaining survivors (244) are concentrated in `recordToolCall` (12) and residual
  message-walker/reprompt-builder mutants** that are largely equivalent-in-practice or require increasingly
  contrived adversarial inputs for diminishing real-bug-catching value — a reasonable stopping point.
  Stryker kept as devDep + `stryker.conf.json` for on-demand re-audit (too slow for CI). This is the purest
  method-first move: it proved our own gate's decision logic was only partially test-pinned, then closed the
  gap methodically.
- **BFCL failure-taxonomy instrumentation — the tool-subsetting question, answered (method-first).** Built
  `bench/bfcl/failureClassifier.ts`: classifies each AST-checker failure `reason` into a type + axis
  (**selection** → tool subsetting fixes it; **argument** → constrained decoding fixes it; **structure** →
  neither), wired into the BFCL report as a "Failure taxonomy" table. Ran it against a REAL 100-case upstream
  BFCL result (granite4.1:3b, 84% macro, 16 failures): **selection 25%, argument 38%, structure 38% — and
  ZERO wrong-function-selection errors.** The 4 "selection" failures are all `spurious-call` (over-eager
  calling on irrelevance cases — subsetting the catalog doesn't fix over-eagerness, only wrong-choice-among-many).
  **Verdict: do NOT build per-turn tool subsetting** — it would add the §2.2 silent-starvation risk to fix a
  failure mode this model doesn't exhibit. Exactly the "measure before you build" discipline that also caught
  the n=1 "+100%" lift illusion.
  **Important caveat (why this isn't final):** BFCL gives each case only a FEW candidate functions; SideCar's
  real loop puts **86 tools** in context. "Selection-from-a-few is fine" does not prove "selection-from-86 is
  fine" — BFCL under-tests lost-in-the-middle at real scale. Before fully closing this: (a) run the classifier
  across more models to confirm the 0%-selection-error pattern holds, (b) consider a BFCL variant with 80+
  distractor tools to measure selection at realistic N, or (c) add an in-loop selection-failure signal. Parked
  in Deferred with this evidence, not closed as "proven unnecessary forever."

_Append findings as they land — the running record of what we actually measured._

- **BFCL AST subset (100-case sample, Q4_K_M, 32K)** — gemma4:e4b **86%** macro, granite4.1:3b 84%,
  ministral-3 83%. Field-anchored evidence for the small-model thesis; gemma leads → default holds up.
  Caveat: our checker is stricter than upstream on strings; relative ranking is the reliable signal.
- **SWE-bench host-local scoring works without Docker** — flask-5014 gold patch resolves 60/60, base
  fails FAIL*TO_PASS; the scorer discriminates. Only the \_reproducible full-set* scoring needs Docker.
- **flask-5014 pass@5 (gemma4:e4b, Q4_K_M, 30 iters, host-scored):** scaffold-off **4/5**, scaffold-on **1/5**.
  On this _easy_ task the harness is net-negative (over-engineering); the earlier n=1 "+100%" was a lucky
  sample. Confirms the difficulty-dependence decision above and the need for pass@k + a hard-task set.
- **N=20 scoped slice (partial, unscored):** scaffold-on produced a patch on 4/9 tasks vs off's 2/9, with
  2 rescues and 0 reverse — _patch-applicability_ leans toward scaffolding even where _resolve_ is noisy.
- **SWE-bench campaign launched (the real thesis test).** Base = **qwen2.5-coder:7b** (qwen3-coder:8b doesn't
  exist; 7b is the true ≤8B coder). Smoke: focused 668b edits, real file reads, **no over-engineering under the
  gate** (unlike gemma) — a much cleaner base. Methodology corrected: **50 tasks × 1 sample/arm** (SWE-bench Lite
  deterministic stride-50, proportionally representative) — per-task noise averages into a stable _rate_, not the
  1-task pass@k that drowned. Predictions (both arms) generating locally, crash-resilient; scoring → official
  Docker harness (off-machine). Provenance manifest written (gap: seed/temp not yet threaded). Honest ceiling: a
  7B won't _equal_ frontier (~50–70%); the win is the **lift + local/zero-cost**, single-to-low-double digits absolute.
- **⚠️ Decomposition pass@5 (flask-5014) — the instrument is under-powered.** All four arms (bare / gate-only /
  critic-only / all) resolved **1/5**; bare was **4/5** in the prior pass@5 and **1/5** here — the same arm's
  resolve rate swings 20↔80% between two pass@5 runs. **At n=5×1-task, no arm comparison is meaningful**; the
  earlier "scaffolding harms (off 4/5, on 1/5)" was partly a lucky draw. Detecting a real resolve effect needs
  n≥20–30 per arm across several tasks (why the field runs the full 500-task set). **Stable signal is behavioral,
  not resolve-level:** gate-only + all reliably emit ~32KB over-engineered patches (test churn); critic-only +
  bare stay ~450b. So the completion gate demonstrably over-engineers — the do-no-harm fix (keep-best ratchet)
  is justified by mechanism + this behavioral signal, NOT by an (unmeasurable-at-this-n) resolve delta. Also:
  run 1 resolved more than runs 2–5 across arms → back-to-back runs may not be IID (GPU/session state).
- **Code graph → prompt management: bidirectional retrieval expansion.** `enrichWithGraphWalk` (the retriever's
  auto-context expansion, default-on for system-prompt + RAG) previously walked **callers only** (who calls a
  hit). Now walks **callees too** (what the hit calls — its dependencies), resolved via `getCallees` +
  `lookupSymbol`, at the SAME shared `maxGraphHits` budget (interleaved callee-first so many callers can't
  starve callees) — richer context MIX at the same token cost, not more tokens. Default both directions;
  `directions` option + defensive on graphs lacking `getCallees` (existing tests unchanged). Auto-assembled
  context now matches what a developer reads: who calls this AND what it calls. 21 tests; 173 retrieval-area green.
- **Analytic-bound gate shipped — the §5 moat, pillar 2 (the strategy's "single move").** `analyticBounds.ts`:
  a kernel that declares a value bound (`# bounds: 0 <= result <= 1`, energy ≥ 0, `sum == 1`) but doesn't
  enforce it (no assert/clip/raise) is now flagged by the completion gate — advisory always, opt-in hard block
  (`sidecar.analyticBounds.gate`). Emits the exact assertion to add. Turns "tests pass" into "the physics is
  right," as a gate. 26 tests. Pillar 1 (shape/dtype/unit contracts) was v0.115; pillar 3 (property-based
  tests) is next. Per strategy §6 this is item #3 and the most defensible in the whole program.
- **SWE harness parallelized + faster clones (campaign infra).** Two driver improvements landed while running
  the real campaign on the Vast box: (1) **blobless partial clones** (`git clone --filter=blob:none`) — a
  fraction of a full clone's size, viable over the box's slow GitHub link; (2) **process-level task sharding**
  (`SIDECAR_SWE_SHARD_INDEX/COUNT`) so N copies of the driver run disjoint task subsets in parallel — each its
  own process (the vscode mock is a global singleton; in-process concurrency would stomp it). Launcher runs
  4 shards under `OLLAMA_NUM_PARALLEL=4` inside a tmux session; 4 concurrent clones also beat the CDN's
  per-connection throttle (same root cause as the ollama-download fix). Campaign wall-clock ~9h → ~2.5h.
- **Ablation now reports uncertainty, not point estimates (#1).** `bench/swe/stats.ts`: Wilson intervals +
  McNemar's exact paired test + paired-diff lift CI, wired into `computeAblation`/`report.ts`. The report now
  leads with `lift = ±X% (95% CI …), McNemar p=…` and a hard honesty gate that refuses a resolve-lift claim
  when p≥0.05 (names the discordant count, defers to behavioral signals). Directly answers the earlier
  self-critique ("at n=5×1-task no arm comparison is meaningful"): the harness will now SAY so instead of
  printing a misleading "+X%". 20 bench tests green (14 stats vs known values). Still open: seed/temp
  provenance threading + scaling tasks to a powered discordant count.
- **Keep-best ratchet — pure core landed.** `src/agent/loop/keepBestRatchet.ts`: `decideRatchet(before, after)`
  is a total function over two `RatchetSignal`s → `keep` / `revert-regression` / `revert-overengineering`.
  Regression dominates (any green→red test signal reverts, even if a new test also went green — a scaffold that
  fixes one test while breaking another is not Pareto-safe); otherwise the over-engineering guard reverts a
  patch that grew past `DEFAULT_OVER_ENGINEER_BYTES` (4KB) with no pass-signal improvement. Snapshot/restore
  takes injected IO (pure + testable now, wires to fs/shadow/audit later). 19 tests green. Loop wiring is the
  next step (see Active #0). This is the do-no-harm foundation; it reads signals the loop already pays for.
- **Vast.ai box operational for the campaign.** 2×RTX 5090, driver 580, torch 2.12+cu130 (sm_120). Ollama's
  `install.sh` shipped a BROKEN install — the 1.4GB `.tar.zst` truncated on the box's slow CDN link (single-
  stream ~260KB/s) so `llama-server` never extracted → GPU 0%, `gpu_count=0`, silent CPU fallback. Fixed by
  parallel download (aria2c -x16) + verify-full-size + verify-archive-contains-llama-server before extract;
  GPU inference now confirmed (qwen2.5-coder:1.5b, 2588 MiB VRAM, 29/29 layers offloaded, 2.9s load). Lesson
  saved to memory ([[reference_ollama_cloud_install_gotcha]]): exit 0 ≠ complete; verify byte size + contents
  after any big cloud fetch. Campaign prep (pull 7B + `npm ci`) now running detached on the box.
- **BFCL native vs schema-constrained (gemma4:e4b, Q4_K_M):** native = **87% macro** (100 cases). Constrained
  (Ollama `format`, union tool schema) **timed out at 30 min** having done ~56 cases vs native's fast 100 —
  the Phase-1 cost is **latency, not accuracy** (partial constrained cases passed at a comparable rate).
  Grammar-mask construction over a big `oneOf` schema is expensive for local inference (the §2.5 round-trip
  cost). Implication: constrained decoding is likely best kept as **repair-only** (where we already use it),
  not the default path — pending a clean small-sample accuracy read. Confirms the "constrain at the action
  boundary only" instinct extends to "and only when the latency is affordable."
- **Clean small-sample follow-up (gemma4:e4b, bundled 8-case fixture, `SIDECAR_BFCL_N`, same slice both arms).**
  Added per-case `durationMs` + `meanDurationMs` instrumentation (`runner.ts`/`types.ts`/`report.ts`) and a
  deterministic category-proportional `sampleCases(n)` (`loader.ts`) so native vs constrained can be compared
  on an IDENTICAL small slice instead of a full run that risks the timeout above. Result: **native 100%
  (8/8), 3.3s/case mean — constrained 100% (8/8), 3.5s/case mean.** The tax essentially DISAPPEARS (~6%,
  noise-level at n=8) on this slice's simple schemas (1–3 top-level properties, ≤2 candidate functions, no
  nesting/enums/arrays — confirmed by inspecting the fixture). **Refines the earlier finding: the constrained-
  decoding tax looks schema-complexity-dependent, not a fixed per-request Ollama cost.** The upstream 100-case
  run that timed out exercised functions with dict/array/nested params (per the failure-taxonomy work's
  observed `reason` strings — `budget = {max,min}`, `gradeDict = {...}`, `columns = [...]`) — exactly the
  shapes this fixture set lacks. This STRENGTHENS the repair-only decision rather than reversing it: production
  repair already constrains on a SINGLE tool's schema (simple parameter shapes for most of the 86 tools), which
  this result says should be cheap; a big multi-function union (the BFCL bench shape, and what a naive
  "constrain everything" design would need) is where the tax bites. **Open follow-up (not done): confirm the
  tax reappears on a deliberately complex schema** (many properties / nested objects / a large `oneOf`) to
  directly test the mechanism rather than infer it — no upstream 100-case dataset is cached in this
  environment to re-run at full scale. New tests: `sampleCases` (7), timing aggregation (5) — 67 BFCL tests
  green, tsc clean.
