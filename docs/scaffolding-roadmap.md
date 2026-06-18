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

1. **Every new scaffold ships with an eval proving its lift.** Scaffolding costs iterations, tokens, and wall-clock — which bite hardest on slow local models, the exact place we need it. No "felt better"; measure pass-rate delta (Measure tier). A scaffold that doesn't move the needle is pure latency tax and gets cut.
2. **Every scaffold is capability-gated.** Strong models should skip guards they don't need (Adapt tier). Heaviest scaffolding goes exactly where the model is weakest.
3. **Reuse the extension points.** New gates go through `completionGate` + `HookBus`; new verifiers reuse `criticHook`'s caps/injection infra; new routers reuse the intent-detection pattern. Don't invent a parallel framework — the HookBus *is* the framework.

## Initiatives (prioritized)

### Tier 1 — VERIFY
- **V1. Claim & citation resolution gate** *(S–M, START HERE)* — extract cited `path` / `path:symbol` from the final answer, verify they resolve on disk (with NodeNext `.js`→`.ts` handling), and reprompt on fabricated paths + hedge phrases ("cannot verify", "without reading", "implied usage"). A new `completionGate` sub-gate. Deterministically kills 3 of the last run's 4 failures.
- **V2. Adversarial analysis critic** *(M)* — generalize `criticHook` (today: edits only) to fire on read-only analysis output: a cheap second pass that re-opens each cited file and confirms/refutes each finding (majority-vote). Reuses critic caps + injection.
- **V3. Structured output for verifiable artifacts** *(M)* — there is currently **zero** schema enforcement; critic findings, review sections, and facet RPC are parsed from free text. Use Ollama `format`/GBNF + Anthropic `tool_use` to force validated schemas, making contracts enforceable instead of prompt-only.

### Tier 2 — ADAPT
- **A1. Model capability profile** *(M)* — registry mapping model → `{toolCallReliability, instructionFollowing, ctxWindow, knownUnsafe}`, seeded from existing per-model eval data, probe-on-first-use to fill gaps.
- **A2. Capability-driven scaffolding intensity** *(M)* — drive gate aggressiveness, burst caps, the architect/editor split, and "force a facet for complex tasks" off A1. Weak local model → max scaffolding; strong cloud model → light touch.

### Tier 3 — ORCHESTRATE
- **O1. Generalized intent → specialist router** *(M)* — extend the v0.113 auto-offer beyond `architecture-reviewer` to all facets (review→reviewer, audit→security-reviewer, write tests→test-author …). Makes the facet pattern the default for complex tasks.
- **O2. Multi-facet decompose + synthesize** *(L)* — planner decomposes a task into a facet DAG (`dependsOn` + RPC infra already exists); synthesizer merges. "Comprehensive review" = architecture + security + test-coverage facets, one merged report.

### Tier 4 — MEASURE
- **M1. Faithfulness + citation-resolution scorers** *(S–M)* — add quality scorers to the eval harness beyond trajectory/file-state. Citation-resolution reuses V1's verifier; faithfulness is an LLM-judge scorer.
- **M2. Ablation harness** *(M)* — run eval cases with/without each scaffold; report pass-rate **and** latency delta. Enforces principle #1.

## Recommended sequence

`V1 → M1 → V2 → A1 → A2 → O1 → V3 → O2`

V1 first: smallest, highest-confidence, fixes what we just watched break, and its verifier is reused by M1. M1 second so everything after is measurable. Then the verify/adapt core, then orchestration.
