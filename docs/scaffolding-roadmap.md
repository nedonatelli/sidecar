# SideCar Scaffolding Roadmap

**Thesis.** SideCar is local-first: it runs structurally weaker models (local Ollama) than frontier cloud APIs. The _scaffolding_ — the harness that constrains, grounds, verifies, adapts, and measures the model — is what makes those models usable, and is therefore the product's main lever. A weak model with strong scaffolding can approach a strong model's output on structured tasks; leaving the model to operate raw throws that lever away.

This was demonstrated concretely (v0.113.x): the **same** Ollama-hosted model, asked to "review the architecture," produced hallucinated boilerplate when run raw (invented `.env`/`settings.local.json`, recommended an event bus and DI that already exist as `HookBus` / `ToolExecutorContext`), but produced a grounded, cited, structured review when run through the read-only `architecture-reviewer` facet + grounding gates + anti-stall reprompts. The model never changed; the harness did.

## The model: Constrain → Ground → Verify → Adapt → Measure

Every scaffold falls into one of five stages. SideCar is strong on the first two and thin on the last three — so the roadmap is to build out Verify, Adapt, and Measure.

| Stage         | What it does                                                      | Status     | Representative existing machinery                                                                   |
| ------------- | ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| **Constrain** | Force tool use; restrict the action surface; route to specialists | **Strong** | `HookBus` + 5 built-in hooks, 4 completion sub-gates, cycle/burst caps, 9 facets w/ tool allowlists |
| **Ground**    | Put real code/context in front of the model; read before claiming | **Strong** | 9 retrievers + RRF fusion, episodic memory, no-grounding gate, query rewrite                        |
| **Verify**    | Confirm the output is actually true                               | **Thin**   | Adversarial critic — but **edits only**, never analysis output                                      |
| **Adapt**     | Scale scaffolding intensity to model capability                   | **Absent** | Role routing + architect/editor split swap models, but never introspect capability                  |
| **Measure**   | Prove a scaffold helps, and at what latency cost                  | **Thin**   | Eval harness scores trajectory + file-state; no faithfulness/citation/ablation                      |

### The Verify gap, concretely

Even through the facet (grounded + structured), a run still fabricated `src/context/context.ts` (the real file is `src/agent/context.ts`), mislabeled `scheduler.ts` as "the core agent loop" (it's `loop.ts`), and shipped findings it admitted it "could not verify." Grounding raised the floor; it did not make output _true_. The remaining failure mode is a **verification** problem — and "when the model is the weak link, add a checker" is itself scaffolding.

## Governing principles

1. **Prefer deterministic verification over model-judges-model.** The single most important principle for local-first. A VRAM-bound user may run exactly _one_ model — there is no stronger model to route a critic to, and loading a second one means a swap (VRAM + reload latency). So the harness must substitute for model strength, not assume a better model exists. Push as much verification as possible into deterministic code (path/symbol resolution, grep, cross-claim contradiction detection — _no model call at all_); spend a model call only on the irreducible semantic residual. A second/stronger model (a fast local sidecar, or a cloud critic) is an _optional luxury_ for the minority who have one, never the plan.
2. **A same-model self-check still helps — because checking is easier than generating, not because it's a better judge.** "Does this claim contradict this file's contents?" is a narrow, grounded entailment check; "review the architecture" is open-ended generation. The same weak model is measurably more reliable on the narrow task. But its lift is _bounded_ — it shares the model's blind spots, so it is not an independent judge, and every model-based self-check must be ablation-proven (principle 3), not assumed.
3. **Every new scaffold ships with an eval proving its lift.** Scaffolding costs iterations, tokens, and wall-clock — which bite hardest on slow local models, the exact place we need it. No "felt better"; measure pass-rate delta (Measure tier). This matters _more_ for local-first: we cannot assume any model-based scaffold helps on the single model the user actually runs. A scaffold that doesn't move the needle is pure latency tax and gets cut.
4. **Adapt scaffolding intensity to the one available model — don't swap models.** The capability profile (A1) drives _how much_ deterministic scaffolding and decomposition to apply, and _whether a self-check call is worth its latency at all_ — not which bigger model to substitute. Weak model → maximize deterministic verification + decomposition; strong model → light touch.
5. **Reuse the extension points.** New gates go through `completionGate` + `HookBus`; new verifiers reuse `criticHook`'s caps/injection infra; new routers reuse the intent-detection pattern. Don't invent a parallel framework — the HookBus _is_ the framework.

## Initiatives (prioritized)

### Tier 1 — VERIFY

- **V1. Claim & citation resolution gate** _(S–M, START HERE)_ — extract cited `path` / `path:symbol` from the final answer, verify they resolve on disk (with NodeNext `.js`→`.ts` handling), and reprompt on fabricated paths + hedge phrases ("cannot verify", "without reading", "implied usage"). A new `completionGate` sub-gate. Deterministically kills 3 of the last run's 4 failures.
- **V2. Adversarial analysis critic** _(M, SHIPPED gated-off)_ — generalize `criticHook` (today: edits only) to fire on read-only analysis output: a focused second pass that fact-checks each claim against the read-evidence the agent gathered. Catches the semantic miss V1's deterministic check can't (a real file mislabeled as something it isn't). **Justified by the narrower-task effect (principle 2), NOT a stronger judge** — it runs on the same one local model, so its lift is bounded and must be ablation-proven by M2 before it's trusted. Only reaches for `criticModel` when a second model genuinely exists. Reuses critic caps + injection.
- **V3. Structured output for verifiable artifacts** _(M, shipped)_ — threaded an optional `responseFormat` ('json' | JSON-schema) through `ApiBackend.complete`/`completeWithOverrides`; OllamaBackend enforces it via the native `format` field and the critic passes `CRITIC_FINDINGS_SCHEMA`. Local-first scoped (Ollama enforces; cloud backends accept-and-ignore, tolerant parser stays as fallback). Facet RPC / review-section schemas could follow the same pattern.
- **V4. Answer-forcing on non-voluntary termination** _(S, shipped)_ — `forceFinalAnswer.ts`. A weak model often never emits a plain-text final answer — every turn is a tool call — so when the loop ends on the iteration cap or a cycle/burst bail it leaves the user a wall of tool-call JSON even when the needed data was already gathered. Runs ONE tools-disabled synthesis turn on `max-iterations`/`stuck` termination (never on `natural`/`aborted`/`out-of-resources`). Found via trajectory dump: `error-recovery-to-correct-file` read the right file on its LAST iteration then terminated on the cap before it could state the result. **Effect:** error-recovery baseline-fail → now-pass, zero smoke regressions (deterministic gate — it can only add a synthesis turn that was structurally missing).
- **V5. Unapplied-edit nudge** _(S, shipped)_ — `unappliedEdit.ts`, the mirror of the isolate-rewrite nudge. Fires when the model describes a fix in a fenced ```code block but calls NO mutation tool and then tries to verify it (re-runs the script / re-reads the file) — the file never changed, so it loops on the identical failure until cycle detection bails. Redirects it to actually call edit_file/write_file, before the bail. Bounded to one injection/run so a false positive (an explanatory code block) costs one message. **Honest effect (correct-the-record):** the target case `run-fix-iteration-cycle` is stochastic (~4/6 unseeded; its baseline "failure" was largely a SEED=42 sampling that deterministically stuck). Over 6 unseeded reps the model called edit_file on its own in all 6, and the nudge fired only on the 1 genuinely-stuck trajectory — correctly silent on the 5 normal-edit reps (low false-positive), and it rescued the stuck SEED=42 run. So it is a targeted safety net for the described-but-didn't-apply pattern (which recurs on any fix-task, the whole of SWE-bench), NOT a deterministic pass-rate lever, and it regresses nothing.

### Tier 2 — ADAPT

- **A1. Model capability profile** _(M)_ — registry mapping model → `{toolCallReliability, instructionFollowing, ctxWindow, knownUnsafe}`, seeded from existing per-model eval data, probe-on-first-use to fill gaps.
- **A2. Capability-driven scaffolding intensity** _(M)_ — drive gate aggressiveness, burst caps, the architect/editor split, deterministic-check depth, and "force a facet for complex tasks" off A1. **Single-model assumption: A2 tunes _how much harness_ to apply to the one model the user runs, not which model to swap to.** Weak model → maximize deterministic verification + decomposition, and decide whether a self-check call earns its latency; strong model → light touch. Routing a critic to a separate model is an optional path here, gated on a second model actually being available — not the default.

### Tier 3 — ORCHESTRATE

- **O1. Generalized intent → specialist router** _(M)_ — extend the v0.113 auto-offer beyond `architecture-reviewer` to all facets (review→reviewer, audit→security-reviewer, write tests→test-author …). Makes the facet pattern the default for complex tasks.
- **O2. Multi-facet decompose + synthesize** _(L, shipped — review slice)_ — a "comprehensive" review dispatches the architecture + security reviewers together (`classifyReviewFacets` → multiple ids; `dispatchFacets` runs them in parallel) and merges via `synthesizeFacetReviews` — deterministic per-specialist-section concatenation, NOT an LLM merge (no fresh hallucination surface over grounded reviews). General task→facet-DAG decomposition beyond the review slice remains future work.

### Tier 4 — MEASURE

- **M1. Faithfulness + citation-resolution scorers** _(S–M, shipped — but see finding below)_ — added a deterministic `citationsResolve` scorer (reuses V1's verifier) + the `review-cites-real-paths` case. Faithfulness (LLM-judge) folded into V2.
- **M2. Ablation harness** _(M, shipped)_ — `npm run eval:ablation` runs cases with/without each scaffold; reports pass-rate lift **and** latency delta. Enforces the eval-lift principle (principle 3). Load-bearing for local-first: a same-model self-check shares the model's blind spots, so V2-style scaffolds _cannot be assumed to help_.

#### Finding (M1/M2 follow-up): binary pass/fail is the wrong instrument for verify lift

Running M2 against V1 produced a hard, instructive negative result. **Cost** measures cleanly (critic ≈ +22s, gate ≈ +8s on a local model). **Lift does not**, because `citationsResolve` is binary-absolute (_every_ cited path must resolve): a real review always name-drops at least one conventional non-source path (`dist/`, an inferred module), so it fails 100% in both arms and the lift is uncomputable — even though V1 demonstrably fires (latency proves it) and demonstrably reduces fabrication (observed: a clean grounded review vs. an earlier one that invented `resolveToolOutput`).

The right instrument is a **count/rate**: _unresolved-citation count per run_, compared as means across arms. **Shipped (v0.118), and it took FOUR instrument generations to get an honest number** — each powered run exposed the next bug in the measurement itself:

1. **Binary** (perfection-or-fail): fails both arms, lift uncomputable — the original finding.
2. **Raw count**: rose _with_ the gate (6.70→7.50) because gated reviews are longer and cite more — a count punishes thoroughness; the rate (`unresolvedCitations / citedPaths`) is the fair comparator.
3. **Exact-at-root resolution**: rate flat at 0.85 in BOTH arms — prose cites by basename/partial path (`loop.ts`), so ~85% of _legitimate_ citations counted as fabrications. **This same bug shipped in the V1 gate itself** (false-accusing reprompts since v0.114); both resolvers are now suffix-aware.
4. **Extractor noise**: brand tokens (`Node.js`, `Vue.js`) and dotted-filename truncation (`vitest.config.ts` → `config.ts`) inflated the arm that wrote more prose. Fixed with a brand stoplist + full dotted-name matching.

The metric stack now lives in `src/agent/citationCheck.ts` behind **golden-fixture tests** with known ground truth for every observed failure mode (measurement code gets product-code discipline). **The clean result (n=10/arm, qwen2.5-coder:7b, `review-cites-real-paths`):** `unresolvedCitationRate` **1.00 → 0.76 (Δ −0.24)** with the gate on, at +9.8s — while citedPaths ROSE 9.9→14.2 (more thorough AND less fabricated). The off-arm rate of exactly **1.00** validates the instrument at its interpretable extreme: an ungrounded review fabricates every citation — the model never called a read tool in 17/20 runs, which is v0.119's sharpest problem statement (one bounded grounding reprompt is not enough for a cold 7B). `citationsResolve` stays a **soft** expectation so the case isn't a permanent red.

**Standing lesson:** for any verify-layer scaffold, measure a continuous metric (count/rate/score), not binary pass/fail — perfection-or-fail can't see a reduction. Correctness is proven deterministically (gate unit tests); cost is proven by ablation; lift needs a graded metric.

#### Finding (M2 on the edit critic): the LLM critic is empirically net-NEGATIVE on a local model

Ablating the critic over the bugfix cluster (binary-clean edit cases, so lift IS measurable here) gave the first hard lift number — and it's negative: **`critic HURTS — lift −17% (100%→83%), latency +66s [n=12/12]`**. Without the critic the model fixed the bugs 100%; with it, 83%. The mechanism is the same false-positive-then-block we saw the analysis critic do live: on an already-correct diff the critic flags a non-issue at high severity, blocks, and the model second-guesses its correct fix into a broken one.

This **empirically validates principle 1** (deterministic verification > model-judges-model): the deterministic scaffolds (V1 citation gate, stub-check, autofix) have no false-positive-then-rewrite path; the same-model LLM critic does, and on a local model it nets out harmful on tasks the model already handles. The critic's _potential_ upside (catching a bug the model got wrong) is unmeasured — it needs error-headroom cases — but the downside is now quantified and large.

**Decision:** keep the critic OFF by default (it is — `critic.enabled`), and treat it as a last-resort opt-in, not a default. The reliable verify lever is the deterministic layer. Do not pour more into tuning the critic to be "less harmful"; the data says the architecture (model judging itself) is the limit. (The analysis critic was already made advisory in v0.114.3; the edit critic still blocks — if the critic is ever defaulted on, the edit critic should be reconsidered the same way.)

##### Confirmation (v0.116 pre-release re-ablation, qwen2.5-coder:7b, smoke n=8/1-rep)

Re-ran M2 on a second local model to confirm the finding still holds before cutting 0.116. Result:

| Scaffold       | Lift               | Latency | Verdict                           |
| -------------- | ------------------ | ------- | --------------------------------- |
| completionGate | 0% (63%→63%)       | +1.9s   | neutral on smoke, cheap           |
| autoFix        | 0% (63%→63%)       | +4.2s   | neutral on smoke, most expensive  |
| **critic**     | **−13% (63%→50%)** | +2.4s   | **net-negative (confirms above)** |

The critic's negative sign reproduces on a different model — the false-positive-then-block mechanism is not model-specific. `completionGate`/`autoFix` show **no net lift on the smoke set**, but this run is low-power (n=8, 1 rep; ±1 case = ±12.5%) and the smoke cases mostly pass without the scaffold, so they under-exercise the gate/autofix failure modes. Their value (if any) lives in error-headroom cases, not smoke — a higher-rep run on scaffold-relevant cases is the outstanding work before defaulting either on. Standing conclusion is unchanged: **the deterministic layer is the reliable lever; the model-judges-model critic stays opt-in.**

## Planned initiatives (unscheduled)

The initiatives above are shipped or in flight. The following are the next
forward-looking bets — grounded in the same Constrain→Verify→Adapt→Measure model
but not yet scheduled. Ordered roughly by leverage.

### CONSTRAIN

- **C1. On-demand capability database** _(L, vision — biggest lever)_ — generalize the Project Knowledge Index from code chunks to _all_ agent capabilities (tools, project conventions, few-shot trajectories), assembled per-query instead of injecting the full tool catalog every turn. A tiered always-resident core + working-set cache + faceted (grammar-constrainable) queries, where a facet is a pre-resolved capability query. Turns a fixed O(N-tools) context cost into O(core + k-retrieved). Supersedes ad-hoc tool-schema stubbing as the primary small-model context-budget lever.
- **C2. Per-turn built-in-tool subsetting + schema compression** _(M)_ — gate the 87 built-in tool schemas by task relevance and strip verbose descriptions/enums for weak models, beyond today's stub-the-extended-tools tiering. (MCP lazy schema loading shipped in v0.117 — measured 46–60% per-server catalog cut; C2 extends the same move to the built-in catalog.) Caveat: BFCL under-tests lost-in-the-middle at real full-catalog scale — measure at scale before trusting.
- **C3. Bash / command grammars** _(M)_ — evidence-driven grammars (Lark-style) for the shell tool, the highest-blast-radius surface, constraining generation to well-formed commands (grammar-constrained decoding).

### VERIFY

- **V6. Shape/dtype/unit-constrained decoding** _(L, frontier)_ — enforce array-semantic constraints (shape, dtype, unit) at _decode_ time for numerical code — one step past today's contract _checking_ (analytic-bound gate, property-test synthesis), which rejects after the fact. Constrains the generation itself.

### ADAPT

- **A3. Verification-triggered escalation** _(M)_ — derive an uncertainty signal from verifier failures (N gate/critic failures on a subtask) and escalate _that subtask_ to a stronger/cloud model — a cost-cascade. Distinct from today's error/circuit-breaker fallback, which is not verification-triggered.
- **A4. Per-facet model envelopes** _(M)_ — each facet declares the smallest sufficient model; the orchestration (fork/merge) layer runs the strongest. Wires the currently-empty `preferredModel` into capability-tiered dispatch (needs A1).

### STATE _(new tier — the one genuinely greenfield area)_

- **S1. Plan externalization ("plan-in-the-harness")** _(L, mechanics shipped v0.119 — adoption evidence open)_ — `update_plan` tool + per-turn `<plan_state>` re-injection (`{current step, last result, remaining steps}`), compaction-proof by construction; plan persists into the crash-resume checkpoint; pre-plan nudge in the per-turn addon slot (cache-safe). Probing found + fixed a real pre-existing bug: the tool catalog and dispatch ignored per-run config overrides (injection-first violation), so config-gated tools were invisible to facet/eval runs. **Measured negative (v0.119, test-across-models — FIVE families):** voluntary adoption is ZERO — ~10 nudged plan-arm runs across qwen2.5-coder:7b, ministral-3, qwen3.5, granite4.1:3b, and llama3.2 produced zero `update_plan` calls, even on a discriminative case (non-derivable step codes, instructions-via-read, a forced-compression 40KB-noise step). Headroom analysis: models above the capability floor pass in BOTH arms (no lift measurable at eval scale — 10 sequential steps ≈ 12 tool calls); the one model AT the floor (llama3.2: 0% both arms, dies at the noise step) fails identically in both arms BECAUSE it never engages the plan. Headroom exists; adoption is conclusively the bottleneck. **Harness-seeded creation shipped (same release):** `parsePlanFromText` deterministically parses the plan-mode output the user approved; `handleExecutePlan` seeds the external plan at the approval transition (gated on `plan.externalized`), so every plan-mode run gets `<plan_state>` re-injection with zero model cooperation. Seeded rerun on the floor model (llama3.2, 3 reps/arm): 0%→0%, all runs dying at the same step — llama3.2 is SUB-floor (granite4.1:3b, the same 2GB class, passes barehanded), so the result is uninformative beyond do-no-harm. **Arc closed (v0.119, granite forensics):** the plan-arm "failures" on granite4.1:3b were ALL harness defects — the model completed the task in 4/4 reps (sentinel at a wrong path). Four mechanisms found via TRAJ=2 trajectory reads and fixed: (1) per-step `update_plan` bookkeeping burned the iteration budget → update_plan-only turns are refunded (bounded); (2) the keep-best ratchet reverted gate-provoked PRIMARY work on a test-less task → plan-gate injections no longer arm the boundary, and the ratchet stands down when no verification activity ever occurred (a live default-on bug); (3) "current == steps.length" false completion → the gate checks plan-named deliverables against editedFiles and reprompts with the exact missing paths; (4) STALE-PLAN REPLAY — the model worked without bookkeeping, then replayed finished steps from the stale injected pointer → **evidence-driven plan maintenance** (`advancePlanPastWrite`: a successful write of a step's last-named path advances `current`; the harness owns the pointer, the model owes no protocol). Result: granite plan-arm 0/4 → pass, with the missing-deliverable check catching its systematic `DONE.md` path slip live. **Final verdict: do-no-harm on all capable models (ministral / qwen3.5 / granite pass both arms); remaining honest cost ~2-3× latency; lift on capable models unproven at eval scale.** The failure regime S1 targets is SWE-length runs; the evidence venue is a `scaffold-on-plan` arm in the next SWE campaign. Feature stays default-off until then.
- **S2. Small-model-aware compaction** _(M, shipped v0.119)_ — the compaction SHAPE now follows the capability tier: `compactionKeepRecentTurns` / `compactionMaxSummaryChars` on the scaffolding profile (weak = more raw turns + tighter summary — a long summary is itself noise to a small model; strong = deeper summarization; medium = the historical 2/800, so behavior-neutral when adaptive scaffolding is off). "Keep the plan" is achieved by re-injection, not retention: `update_plan` results are shed aggressively (read-class) because `<plan_state>` re-supplies the plan every turn (S1+S2 composing). "Open contracts" = error results, which were already never-compressed. Ablation evidence rides the same long-horizon case as S1.

### LEARN _(new tier)_

- **L1. Gate → trajectory flywheel** _(L, vision)_ — capture gate-passing runs as a gate-validated fine-tuning corpus specific to the tool registry; LoRA/QLoRA on the user's own correct trajectories; a per-task-class few-shot trajectory library. Gates become free training labels.

### MEASURE

- **M3. Powered-measurement program** _(M)_ — promote a cost-adjusted throughput metric over raw pass rate as the headline; add diagnostic metrics (schema-validity, executable-call, tool-selection rates); a ≥30-task real-repo suite; a cross-tier (small/large/cloud) regression harness with per-PR deltas; powered n≈300–500 for SWE-bench with IID / order-effect checks.
- **Bail-early / do-no-harm violation — mechanism closed, measurement open (v0.118 work):** an established scaffold turned a clean `natural` completion into `bad-reasoning` on 2 of 4 SWE tasks (django-14608, sympy-11897) — the harness made the model _worse_. Investigation verdict: this is **gate-provoked flailing**, not gate/critic early-exit — the completion gate's verification push gives a weak 7B no way to comply (no reachable test runner, or an already-broken edit), so it flails into unrelated-file edits and duplicated broken patterns until cycle detection bails. The candidate policy ("revert any scaffold-tail edit with zero test-signal gain") shipped as scaffold **2.0.1** (`DEFAULT_OVER_ENGINEER_BYTES` 4096→0); code-reading confirmed `evaluateRatchetAtTermination` is termination-agnostic (only user-abort skips it — bail-terminated runs DO get the revert), and both concrete campaign failure shapes are now pinned as passing regression tests in `keepBestRatchetWiring.test.ts` (the 536-byte unrelated-file edit at a `stuck` bail; the duplicated-pattern second file, with the imperfect pre-scaffold edit correctly preserved — do-no-harm means converging to the scaffold-off outcome, not fixing the model's work). **Closed (v0.118):** the third-arm campaign delivered the evidence (over-engineering 36574→29603b mean patch at n=50, reverts in 12% of runs, do-no-harm clean — nothing un-resolved) and `scaffolding.keepBest` is **default-on** as scaffold 2.1.0. Ledger caveat: resolve non-regression is vacuous at 7B/Verified (0 resolves in every arm); re-verify the third arm on a resolvable class before treating the verdict as fully closed.

### Cross-cutting

- **Prompt-transform hook** _(M)_ — a `PromptTransform` protocol with a type-aware, default-deny-on-structured-segments policy, so opt-in lossy prompt compressors (LLMLingua-style) are adapters that can never corrupt a tool call — never a core dependency.

## Recommended sequence

`V1 → M1 → V2 → A1 → M2 → A2 → O1 → V3 → O2` (shipped/in-flight), then the
unscheduled bets lead with **C1 (capability DB)** and **S1 (plan externalization)**
— the two biggest small-model levers — with **M3** underpinning them so each is
ablation-proven, not assumed.

V1 first: smallest, highest-confidence, fixes what we just watched break, and its verifier is reused by M1. M1 second so everything after is measurable. V2 ships gated-off; **M2 moves up to right after A1** so we can ablation-prove V2 (and any model-based scaffold) actually lifts pass-rate on one local model before trusting or defaulting it on. Then the rest of adapt/orchestration.

## Status

**All nine initiatives shipped** (v0.114.x, branch `grounding-review-gate`): V1, M1, V2, A1, M2, A2, O1, V3, O2. V2/A2 ship gated-off (`critic.enabled` / `adaptiveScaffolding.enabled`); the rest are behavior-neutral or additive. Live-model testing validated O1 routing + V1 grounding and caught two real bugs (security-reviewer hallucinated deps; dead suggestion buttons), both fixed.

**Open follow-ups** (none blocking): the count/rate lift metric (M1/M2 finding above — binary pass/fail can't measure verify lift); confirming V2 catches a fabrication on a real model (stochastic); a recurring "I will now…" plan-and-stop stall; general task→facet-DAG decomposition beyond the review slice (O2); structured output for facet RPC / review sections (V3 pattern).
