# SideCar — Small-Model Agent Architecture & Strategy

_Companion to `sidecar-small-model-scaffolding-roadmap.md` (detailed phase tables live there)._

---

## 1. Thesis & current position

**The bet.** A local-first coding agent whose advantage is not the model — models are commoditized — but the system around it: verification, scoping, context economy, and a correctness discipline tuned for a domain the funded generalists won't chase.

**Where SideCar stands.**

- _Capability_ is largely solved. The verification stack (completion gate, regression guards, adversarial critic), typed sub-agent facets, shadow workspaces, architect/editor split, delegation, prompt pruner, and Model Arena put it ahead of most of the field on the expensive-to-fake axis.
- _Distribution_ is not a capability problem. 115 organic installs with zero marketing is pull, not push — conversion through the weakest possible funnel (marketplace search, 0 reviews suppressing rank). The addressable interest behind that number is much larger than the number. Capability and distribution are orthogonal; the hard one is done.

**The wedge.** A researcher's coding agent that proves the math is right, running locally. No competitor with 5M installs can say that sentence. Everything below either serves that sentence or is infrastructure underneath it.

---

## 2. Core architecture — the unifying model

Several roadmap items are special cases of a few ideas. These are the load-bearing abstractions.

### 2.1 Two failure layers, one principle

- **Syntactic failures** (malformed / invalid tool calls) — the class small models _add_. Killed by constrained decoding (grammars make invalid calls unsamplable). Local-first gives logit access, so this is available to SideCar and not to cloud-only agents.
- **Semantic failures** (valid-but-wrong) — killed by the existing verification stack (tests, types, gates).
- **Principle:** grammars guarantee _valid_, never _correct_. Keep the two layers distinct; each covers the other's blind spot. Cognition that a small model can't reliably hold (the plan, the tool catalog, prior results) moves out of the weights and into the harness.

### 2.2 On-demand capability database

Capabilities (tools, code knowledge, conventions, few-shot trajectories) live in a registry; context is assembled by query. The model only has to learn one stable skill — _how to ask_ — instead of selecting among 80 tools in-context. That single query call is itself grammar-constrainable, so it composes with §2.1.

**The catch — relocated, not removed, difficulty.** This shifts the hard problem from in-context selection to retrieval, and changes a _visible_ failure (wrong tool chosen, auditable) into a _silent_ one (right capability never surfaced; the model can't miss what it never saw). Two constraints keep it from failing:

- **Tiered, not pure on-demand.** A compact always-resident index (categories + one-liners — the _shape_ of what's queryable) plus on-demand detail. Pure on-demand overcorrects from overload into silent starvation. This is the progressive-disclosure / Skills-frontmatter pattern.
- **Structured queries, not free text.** "Write a good semantic query" is itself a skill small models are weak at. Faceted queries (intent / input type / category) are easier and grammar-constrainable.
- Add a **working-set cache** so retrieved capabilities stay resident for the task (else a small model re-queries and thrashes), sharing the same memory substrate as the externalized plan store.

This is not a new system — it is the Project Knowledge Index generalized from "code chunks" to "all capabilities," with tools as one more retrievable document type.

**Method-first bound:** retrieval **recall@k** on tasks with known required-capability sets — measurable without running the agent, and it measures exactly the part that now carries the risk.

### 2.3 Facet composition

SideCar's typed sub-agent facets are an **authorization/scoping** mechanism (allowlist + preferred model + task class). They interlock with §2.2:

- The facet **is a pre-resolved query** — it names the intent and bounds the capability surface deterministically, so on-demand retrieval refines _within_ a sane neighborhood rather than searching everything. This directly answers the silent-starvation risk.
- The facet supplies a **structured prior on every query**: intent/category come from the facet, the model only fills specifics — a much easier ask of a weak model.

**The trap:** don't let the facet allowlist and the registry become two sources of truth about what a capability _is_. Clean split — **facet = scope/policy** (what this agent is allowed and likely to need), **database = the single registry** (what exists + full schema). A facet _resolves to a query_ against the registry; it never holds its own copy of tool definitions, or you're back to 80 allowlists drifting out of sync. **One registry, many facet-shaped views.**

**The payoff — one source of truth.** Facet → task class → (capability scope _and_ smallest sufficient model). Routing, context assembly, and cost control all derive from a single declaration instead of three. That consolidation is worth more than most individual capabilities.

### 2.4 Two-layer retrieval

Facets are task-class granularity — right for scoping, too coarse for within-task retrieval (one coding facet spans many specific capabilities). So: **facets bound the neighborhood, on-demand retrieval picks within it.** Two layers, not one. Collapse them and you lose either the reliable pre-filter or the fine-grained economy.

### 2.5 Scaling — prompt size vs database operations

This is the actual justification for §2.2, and it is a **trade between two cost axes**, not a free win. State it explicitly or the architecture is just an assertion.

**Eager-tools regime (today).**

```
context_per_turn ≈ system_prompt + Σ_{all N capabilities} schema_i + history
```

The tool-schema term is **O(N)** in the registry size N. As N grows (80 → 200 → 1000) context grows linearly, and for a small model that degrades tool _selection_ (lost-in-the-middle) long before it hits cost/TPM ceilings. Net consequence: **capability count is capped by the context window, not by usefulness.** Round-trips per turn: 1.

**On-demand-database regime.**

```
context_per_turn ≈ system_prompt + resident_index(C) + working_set(k) + history
```

- `resident_index` is **O(C)** in the number of _categories_ C (compact one-liners). New capabilities land under existing categories, so C grows far slower than N — effectively constant.
- `working_set` is **O(k)**, the capabilities actively retrieved for the current task. k is bounded by _task complexity_, not by N.

So **per-turn context is decoupled from N.** The registry can grow to thousands of capabilities with no per-turn context growth. That is the win.

**The counter-cost (the omitted half).** Cost moves from a _static_ axis (context size) to a _dynamic_ axis (retrieval operations). Each query is a round-trip:

```
total_task_cost ≈ Σ_turns context_per_turn   +   q · round_trip_cost
```

where **q = queries per task**. Smaller per-turn context, but more operations — and for local small-model inference each round-trip is real wall-clock latency. A model that queries badly re-queries, so **q can blow up**, which is the failure that erases the entire benefit.

**Every §2 component maps to controlling one term in this trade:**

| Component                                             | Term it controls                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Tiered resident index (§2.2)                          | keeps `resident_index` small **and** lets the model see the capability _shape_, cutting exploratory queries (↓ q) |
| Facet pre-resolution (§2.3)                           | makes the first query hit — narrows scope deterministically before the model queries (↓ q)                        |
| Working-set cache (§2.2)                              | prevents re-querying resident capabilities (bounds q, keeps k resident)                                           |
| Grammar-constrained / structured queries (§2.1, §2.2) | eliminates malformed queries that waste round-trips (↓ wasted q)                                                  |

**The crossover.** On-demand wins when `O(C + k) + q·round_trip < O(N)` per-turn context. For small N (a handful of tools) eager is cheaper and simpler — don't build the database for 10 tools. The architecture pays off precisely because N is already 80 and growing; the four controls above are what keep q bounded so the trade stays favorable as N scales.

**Method-first bounds:** track **q (queries per completed task)** and **k (working-set size)** alongside recall@k and CPS. If q trends up as N grows, one of the four controls is failing — that is the diagnostic that tells you _which_ before cost or latency regresses.

### 2.6 User-extensible prompt transforms

Some users will want lossy text compression (third-party prompt optimizers, custom passes) for their own cost/latency reasons. The right answer is **not** to integrate any specific library — it is to expose a generic transform hook and make those libraries adapters behind it. This decouples SideCar from any one dependency and turns a footgun into a bounded, opt-in feature.

**Why a hook, not a dependency.** Wiring a single library in directly couples you to it (e.g. one unreleased 308-star repo that may go stale) and bakes its tradeoffs into the core. An interface costs almost nothing more and lets users bring whatever pass they prefer (LLMLingua, a regex stripper, an entropy optimizer) without SideCar taking on the dependency or the blame.

**The load-bearing rule — type-aware, default-deny on structured segments.** The transform stage sees the _segment type_ (system instruction, tool schema, grammar, code, retrieved prose, plan state) and is **structurally forbidden** from transforming anything but prose-class segments. Schemas, grammars, code, and plan state are never eligible, by policy, at the boundary. This bakes the earlier objections (lossy compression breaks structure and degrades small-model adherence) into the architecture as a guardrail rather than trusting the user or the docs to enforce them. Even a user running aggressive compression cannot silently invalidate a tool call — the segments that _would_ break are never reachable.

**Properties:**

- **Off by default, config-gated** — safe default, explicit opt-in.
- **Pipeline placement** — a post-assembly / pre-send stage in the §2.2 context pipeline, composing after the existing pruner. An ordered transform list mirrors the sequential-chaining pattern these optimizers already use.
- **Out of the core install** — lazy-imported optional dependency in the Python worker (reuse the `delegate_task` boundary), graceful when absent. Honors "doesn't ship with SideCar."
- **Measured, on the right axis** — surface before/after token delta _and_ route it through Model Arena so users A/B **task completion / CPS**, not token savings alone. A pass that saves 15% tokens and drops completion 8% must be visible as such.
- **Protected regions** — lift the protected-tags idea (explicit non-compressible spans) into the interface, used both by the system (to fence structured segments) and by users.

```python
class PromptTransform(Protocol):
    def applies_to(self, seg: Segment) -> bool: ...   # prose-class only, enforced by policy
    def transform(self, seg: Segment) -> Segment: ...  # returns text + token delta
```

Third-party optimizer stages (entropy, punctuation, synonym, etc.) each become a thin adapter implementing this protocol; none of them is a core dependency.

**Cost to accept:** any opt-in transform draws "why did my output break" support load. The default-deny on structured segments is what bounds it — the only failures a user can create are in prose quality, which is recoverable and shows up in the metrics rather than as a corrupted tool call.

---

## 3. The scaffolding roadmap (compact)

Full item-level tables and acceptance bounds in the companion file. Sequence respects dependency and ROI.

| Phase | Focus                                        | Standout gap                                                                                   | Status                                         |
| ----- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0     | Measurement foundation                       | Failure taxonomy + CPS / schema-validity / executable-call metrics; real-task (not smoke) eval | 🟡 — spend + smoke exist, diagnostics don't    |
| 1     | Structural guarantees (constrained decoding) | **Grammar-constrained tool calls** — biggest lever, likely absent, uniquely yours              | ❌                                             |
| 2     | Context economy                              | Per-turn tool subsetting; small-model-specific prompt                                          | ❌ / 🟡                                        |
| 3     | State externalization                        | Plan held in harness, per-turn step re-injection                                               | 🟡 — plan mode exists, externalization unclear |
| 4     | Verification tuning                          | Make adversarial critic tier-aware (deterministic verifiers for small primary)                 | ✅ / 🟡 — mostly built                         |
| 5     | Routing & fallback                           | Failure-triggered escalation; up-front task-type routing                                       | 🟡 — plumbing exists                           |
| 6     | Model adaptation (optional)                  | LoRA on your own gate-passed trajectories                                                      | ❌                                             |

**Priority:** Phase 0 first (method-first; the syntactic-vs-semantic split decides 1-vs-4 ROI) → Phase 1 (A1–A2) → Phase 2 (B1–B2) → Phase 3 (C2). Phases 4–5 are tier-awareness on things already built. Phase 6 only after metrics show a residual the harness can't close.

---

## 4. Cross-cutting concerns

- **Independent benchmarks.** Your own MEEMS-task eval is a self-defined yardstick; pair it with a public one — BFCL v4 / τ-bench / StableToolBench for tool use, SWE-bench / TerminalBench for the coding loop — so the number is comparable to the field and tells you whether a local 3B is at the frontier of its weight class or just passing your smoke tests.
- **Prompt-injection hardening.** The loop ingests untrusted text from many directions (file contents, web results, CI logs, live tickets injected into the prompt). Small models are markedly more injection-susceptible than frontier models, and this operates at the _reasoning_ layer — different from your secrets/vuln scanning. Architectural fix: treat all tool output as data, never instructions; structurally fence retrieved content; never let it silently expand tool permissions. Threat-model pass before it's exploited.
- **Verify the verifier.** The gate is only as strong as its tests, and agents write tests that pass trivially (tautological asserts, hollow mocks). A green gate over wrong code is invisible from the signal you watch. **Mutation testing** — inject faults, confirm the suite catches them — is the independent bound on your bound. Low mutation score = the moat is theater. Purest method-first move available.
- **Code graph.** The Project Knowledge Index is retrieval; it can't tell the agent the _consequences_ of a change (callers, type flow, downstream breakage) — the invisible-20% that separates "edited the file" from "understood the edit." A persistent call/type/dependency graph, built on tree-sitter ASTs you already have, drops into the §2.2 database as another knowledge source.
- **Run provenance.** Agent runs are nondeterministic; for the Research Assistant mode to be reproducible, log per run: model + version, prompt-template version, tool set, temperature, seed. Without it a logged "experiment" can't be rerun. This is what makes the agent a legitimate part of a research methodology rather than a black box.
- **Orchestrator strength.** Fork/merge arbitration and sub-agent aggregation are _reasoning_ tasks — exactly what small models do worst. Run the **strongest** model at the orchestration layer, the cheapest sufficient one at the workers. Inverts the usual cost instinct; that's where the leverage is.
- **Gates as free training labels.** The completion gate + regression guards are already an automatic quality labeler: every gate-passing run is a positive trajectory, every failure a typed negative. Capture runs systematically and your own usage becomes a gate-validated fine-tuning corpus specific to your registry — the flywheel that makes Phase 6 cheap instead of cold-start.

---

## 5. The vertical — the actual moat

Generic small-model infrastructure is necessary but not differentiating. The edge is **correctness machinery for numerical/scientific code**, which is both what serves MEEMS and what no generalist will build:

- Shape / dtype / unit contracts checked at gate time.
- Property-based tests (Hypothesis) on numerical kernels.
- **Validation against analytic bounds** — your own research discipline (method-first against independent bounds) encoded as a verification gate.

This turns "tests pass" into "the physics is right." It is the most defensible item in the entire program and it rides directly on Phase 1 constrained decoding.

---

## 6. Strategy & sequencing

**Stop widening.** The constraint flipped from _what to build_ to _what to finish_. Open threads are not free — each adds maintenance surface, context budget, and drift risk. Generating the next idea is the cheap part; driving one wedge to something demonstrable is the expensive part and where the value is.

**The single move:** take the numerical vertical (§5) riding on constrained decoding (Phase 1), with Phase 0 measurement underneath it, all the way to a result you can show. "Researcher's agent that proves the math is right, running locally" is the demonstrable claim no competitor can make — and it's also the one decent writeup that moves the install number more than fifty more features would. Capability is the asset; the writeup is the megaphone that's simply not yet picked up.

**Recommended order of operations**

1. **Phase 0 measurement** — failure taxonomy + CPS/schema-validity/recall@k. Can't steer otherwise.
2. **Phase 1 grammar-constrained tool calls** — biggest reliability lever, uniquely local.
3. **Numerical correctness gates (§5)** — the differentiator; small surface, high defensibility.
4. **Verify-the-verifier (mutation testing)** — confirms 1–3 are real, not theater.
5. **On-demand capability database + facet resolution (§2.2–2.4)** — the architecture that makes 1–2 scale; build once tooling/measurement exist to prove it helps.
6. Everything else (injection hardening, code graph, provenance, orchestrator routing, LoRA) as metrics demand — not pre-emptively.

---

## 7. Open questions to resolve

These gate decisions and are the statuses least certain from the public listing:

- **Plan externalization (C1–C2):** does plan mode hold the plan in the harness or in context? Changes Phase 3 priority.
- **Lazy schema loading (B3):** does Skills 2.0 already defer full schemas, or load them eagerly? Changes Phase 2 priority.
- **Phase 0 readiness:** is any per-turn diagnostic (schema validity, tool-selection correctness) already captured, or is the only signal aggregate smoke pass rate?
- **Competitor-matrix claims** in the marketplace listing — verify before informed users challenge them; credibility cost.
