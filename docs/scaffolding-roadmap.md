# SideCar Scaffolding Roadmap

**Thesis.** SideCar is local-first: it runs structurally weaker models (local Ollama) than frontier cloud APIs. The *scaffolding* — the harness that constrains, grounds, verifies, adapts, and measures the model — is what makes those models usable, and is therefore the product's main lever. A weak model with strong scaffolding can approach a strong model's output on structured tasks; leaving the model to operate raw throws that lever away.

This was demonstrated concretely (v0.113.x): the **same** Ollama-hosted model, asked to "review the architecture," produced hallucinated boilerplate when run raw (invented `.env`/`settings.local.json`, recommended an event bus and DI that already exist as `HookBus` / `ToolExecutorContext`), but produced a grounded, cited, structured review when run through the read-only `architecture-reviewer` facet + grounding gates + anti-stall reprompts. The model never changed; the harness did.

## The model: Constrain → Ground → Verify → Adapt → Measure

Every scaffold falls into one of five stages. SideCar is strong on the first two and thin on the last three — so the roadmap is to build out Verify, Adapt, and Measure.

| Stage | What it does | Status | Representative existing machinery |
|-------|--------------|--------|-----------------------------------|
| **Constrain** | Force tool use; restrict the action surface; route to specialists | **Strong** | `HookBus` + 5 built-in hooks, 4 completion sub-gates, cycle/burst caps, 9 facets w/ tool allowlists |
| **Ground** | Put real code/context in front of the model; read before claiming | **Strong** | 9 retrievers + RRF fusion, episodic memory, no-grounding gate, query rewrite |
| **Verify** | Confirm the output is actually true | **Thin** | Adversarial critic — but **edits only**, never analysis output |
| **Adapt** | Scale scaffolding intensity to model capability | **Absent** | Role routing + architect/editor split swap models, but never introspect capability |
| **Measure** | Prove a scaffold helps, and at what latency cost | **Thin** | Eval harness scores trajectory + file-state; no faithfulness/citation/ablation |

### The Verify gap, concretely
Even through the facet (grounded + structured), a run still fabricated `src/context/context.ts` (the real file is `src/agent/context.ts`), mislabeled `scheduler.ts` as "the core agent loop" (it's `loop.ts`), and shipped findings it admitted it "could not verify." Grounding raised the floor; it did not make output *true*. The remaining failure mode is a **verification** problem — and "when the model is the weak link, add a checker" is itself scaffolding.

## Governing principles

1. **Prefer deterministic verification over model-judges-model.** The single most important principle for local-first. A VRAM-bound user may run exactly *one* model — there is no stronger model to route a critic to, and loading a second one means a swap (VRAM + reload latency). So the harness must substitute for model strength, not assume a better model exists. Push as much verification as possible into deterministic code (path/symbol resolution, grep, cross-claim contradiction detection — *no model call at all*); spend a model call only on the irreducible semantic residual. A second/stronger model (a fast local sidecar, or a cloud critic) is an *optional luxury* for the minority who have one, never the plan.
2. **A same-model self-check still helps — because checking is easier than generating, not because it's a better judge.** "Does this claim contradict this file's contents?" is a narrow, grounded entailment check; "review the architecture" is open-ended generation. The same weak model is measurably more reliable on the narrow task. But its lift is *bounded* — it shares the model's blind spots, so it is not an independent judge, and every model-based self-check must be ablation-proven (principle 3), not assumed.
3. **Every new scaffold ships with an eval proving its lift.** Scaffolding costs iterations, tokens, and wall-clock — which bite hardest on slow local models, the exact place we need it. No "felt better"; measure pass-rate delta (Measure tier). This matters *more* for local-first: we cannot assume any model-based scaffold helps on the single model the user actually runs. A scaffold that doesn't move the needle is pure latency tax and gets cut.
4. **Adapt scaffolding intensity to the one available model — don't swap models.** The capability profile (A1) drives *how much* deterministic scaffolding and decomposition to apply, and *whether a self-check call is worth its latency at all* — not which bigger model to substitute. Weak model → maximize deterministic verification + decomposition; strong model → light touch.
5. **Reuse the extension points.** New gates go through `completionGate` + `HookBus`; new verifiers reuse `criticHook`'s caps/injection infra; new routers reuse the intent-detection pattern. Don't invent a parallel framework — the HookBus *is* the framework.

## Initiatives (prioritized)

### Tier 1 — VERIFY
- **V1. Claim & citation resolution gate** *(S–M, START HERE)* — extract cited `path` / `path:symbol` from the final answer, verify they resolve on disk (with NodeNext `.js`→`.ts` handling), and reprompt on fabricated paths + hedge phrases ("cannot verify", "without reading", "implied usage"). A new `completionGate` sub-gate. Deterministically kills 3 of the last run's 4 failures.
- **V2. Adversarial analysis critic** *(M, SHIPPED gated-off)* — generalize `criticHook` (today: edits only) to fire on read-only analysis output: a focused second pass that fact-checks each claim against the read-evidence the agent gathered. Catches the semantic miss V1's deterministic check can't (a real file mislabeled as something it isn't). **Justified by the narrower-task effect (principle 2), NOT a stronger judge** — it runs on the same one local model, so its lift is bounded and must be ablation-proven by M2 before it's trusted. Only reaches for `criticModel` when a second model genuinely exists. Reuses critic caps + injection.
- **V3. Structured output for verifiable artifacts** *(M, shipped)* — threaded an optional `responseFormat` ('json' | JSON-schema) through `ApiBackend.complete`/`completeWithOverrides`; OllamaBackend enforces it via the native `format` field and the critic passes `CRITIC_FINDINGS_SCHEMA`. Local-first scoped (Ollama enforces; cloud backends accept-and-ignore, tolerant parser stays as fallback). Facet RPC / review-section schemas could follow the same pattern.

### Tier 2 — ADAPT
- **A1. Model capability profile** *(M)* — registry mapping model → `{toolCallReliability, instructionFollowing, ctxWindow, knownUnsafe}`, seeded from existing per-model eval data, probe-on-first-use to fill gaps.
- **A2. Capability-driven scaffolding intensity** *(M)* — drive gate aggressiveness, burst caps, the architect/editor split, deterministic-check depth, and "force a facet for complex tasks" off A1. **Single-model assumption: A2 tunes *how much harness* to apply to the one model the user runs, not which model to swap to.** Weak model → maximize deterministic verification + decomposition, and decide whether a self-check call earns its latency; strong model → light touch. Routing a critic to a separate model is an optional path here, gated on a second model actually being available — not the default.

### Tier 3 — ORCHESTRATE
- **O1. Generalized intent → specialist router** *(M)* — extend the v0.113 auto-offer beyond `architecture-reviewer` to all facets (review→reviewer, audit→security-reviewer, write tests→test-author …). Makes the facet pattern the default for complex tasks.
- **O2. Multi-facet decompose + synthesize** *(L, shipped — review slice)* — a "comprehensive" review dispatches the architecture + security reviewers together (`classifyReviewFacets` → multiple ids; `dispatchFacets` runs them in parallel) and merges via `synthesizeFacetReviews` — deterministic per-specialist-section concatenation, NOT an LLM merge (no fresh hallucination surface over grounded reviews). General task→facet-DAG decomposition beyond the review slice remains future work.

### Tier 4 — MEASURE
- **M1. Faithfulness + citation-resolution scorers** *(S–M, shipped — but see finding below)* — added a deterministic `citationsResolve` scorer (reuses V1's verifier) + the `review-cites-real-paths` case. Faithfulness (LLM-judge) folded into V2.
- **M2. Ablation harness** *(M, shipped)* — `npm run eval:ablation` runs cases with/without each scaffold; reports pass-rate lift **and** latency delta. Enforces the eval-lift principle (principle 3). Load-bearing for local-first: a same-model self-check shares the model's blind spots, so V2-style scaffolds *cannot be assumed to help*.

#### Finding (M1/M2 follow-up): binary pass/fail is the wrong instrument for verify lift
Running M2 against V1 produced a hard, instructive negative result. **Cost** measures cleanly (critic ≈ +22s, gate ≈ +8s on a local model). **Lift does not**, because `citationsResolve` is binary-absolute (*every* cited path must resolve): a real review always name-drops at least one conventional non-source path (`dist/`, an inferred module), so it fails 100% in both arms and the lift is uncomputable — even though V1 demonstrably fires (latency proves it) and demonstrably reduces fabrication (observed: a clean grounded review vs. an earlier one that invented `resolveToolOutput`).

The right instrument is a **count/rate**: *unresolved-citation count per run*, compared as means across arms — V1's lift then reads as "fewer fabrications with the gate" (e.g. 2.1 → 0.4 avg). The scorer already computes the unresolved set; the work is exposing the count as a numeric ablation metric instead of collapsing to a boolean. Deferred (it's a project of its own); `citationsResolve` is meanwhile kept as a **soft** expectation so the case isn't a permanent red.

**Standing lesson:** for any verify-layer scaffold, measure a continuous metric (count/rate/score), not binary pass/fail — perfection-or-fail can't see a reduction. Correctness is proven deterministically (gate unit tests); cost is proven by ablation; lift needs a graded metric.

## Recommended sequence

`V1 → M1 → V2 → A1 → M2 → A2 → O1 → V3 → O2`

V1 first: smallest, highest-confidence, fixes what we just watched break, and its verifier is reused by M1. M1 second so everything after is measurable. V2 ships gated-off; **M2 moves up to right after A1** so we can ablation-prove V2 (and any model-based scaffold) actually lifts pass-rate on one local model before trusting or defaulting it on. Then the rest of adapt/orchestration.

## Status

**All nine initiatives shipped** (v0.114.x, branch `grounding-review-gate`): V1, M1, V2, A1, M2, A2, O1, V3, O2. V2/A2 ship gated-off (`critic.enabled` / `adaptiveScaffolding.enabled`); the rest are behavior-neutral or additive. Live-model testing validated O1 routing + V1 grounding and caught two real bugs (security-reviewer hallucinated deps; dead suggestion buttons), both fixed.

**Open follow-ups** (none blocking): the count/rate lift metric (M1/M2 finding above — binary pass/fail can't measure verify lift); confirming V2 catches a fabrication on a real model (stochastic); a recurring "I will now…" plan-and-stop stall; general task→facet-DAG decomposition beyond the review slice (O2); structured output for facet RPC / review sections (V3 pattern).
