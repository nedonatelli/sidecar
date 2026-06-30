# SideCar — Small-Model Agentic Scaffolding Roadmap

**Goal:** maximize the fraction of agentic tasks a local small model (1–12B) completes _reliably and cheaply_, and make it fail fast and detectably at the edge of its competence so fallback fires cleanly.

**Design thesis:** the small-model bottleneck is schema/format adherence and context economy, not raw intelligence. Move cognition out of the weights and into the harness; guarantee structure by construction instead of hoping for it. Your local-first stance is the unfair advantage — you have logit access, so you can do grammar-constrained decoding that cloud-only agents structurally cannot.

---

## Status legend (verified against code at v0.114.56 — 2026-06-29)

| Symbol | Meaning                                               |
| ------ | ----------------------------------------------------- |
| ✅     | Implemented (verified in code)                        |
| 🟡     | Partial — adjacent/half-wired; not in this exact form |
| ❌     | Absent in code                                        |
| ❓     | (retired — all cells resolved against source)         |

> **Verification pass (2026-06-29, v0.114.56).** Statuses below were re-derived from a code read, not the marketplace listing. Net strategic shifts:
>
> - **Phase 1 is cheaper than billed.** A1's Ollama schema-`format` path is fully plumbed but **dead code** (zero callers); A5's reprompt mechanism already exists for empty responses and can be extended to parse errors. Both top levers are "activate + connect," not greenfield.
> - **The real gap cluster is "tier-aware" (D2, C4, E2) — and the tier signal already exists.** `modelCapability.ts` derives weak/medium/strong and feeds a `scaffoldingProfile`; the critic, compaction, and escalation just aren't wired to it.
> - **Phase 0 collapses to a small delta.** A real end-to-end agent harness (`agentHarness.ts`, 34 cases), cross-model comparison (`modelComparison.eval.ts`), and structured `metrics.jsonl`/`spend.jsonl` already exist. Net new work: F1 taxonomy + the four F2 metrics + real-task scale + CI tier-deltas. The premise "`testCurrentModel` is smoke" was wrong — that function doesn't exist; the harness runs `runAgentLoop` autonomously in real sandboxes.
> - **Phase 3 is the one genuinely greenfield area** (C1 is checkpoint-only, not externalized).
> - **B3 resolved:** tools already do progressive disclosure (`describe_tool` + stubs); skills don't. The 80-tool token tax is already mitigated — measure real overhead before building B1.

The two layers to keep separate throughout: **syntactic** failures (malformed/invalid calls — small models add this class) are killed by constrained decoding; **semantic** failures (valid-but-wrong) are killed by your existing verification stack. Grammars guarantee _valid_, never _correct_.

---

## Phase 0 — Measurement foundation (do first; gates everything)

You can't optimize a small model blind. Aggregate pass rate hides which failure bucket is actually killing you, and each bucket has a different fix.

| ID  | Item                                                                                                                                          | Failure mode addressed                  | Acceptance / independent bound                                                | Status                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| F1  | **Failure taxonomy instrumentation** — tag every failed turn as malformed-call / wrong-tool / lost-plan / bad-reasoning / timeout             | Optimizing the wrong thing              | Every failed run lands in exactly one bucket; distribution reported per model | ❌ — `classifyError` is user-facing only (messageUtils.ts:403); no turn-level root-cause bucketing             |
| F2  | **Production metrics** — schema validity rate, executable call rate, tool-selection accuracy, cost-per-successful-task (CPS), p50/p95 latency | No signal on where tokens/cost go       | Dashboard per model tier; CPS is the headline number, not pass rate           | 🟡 — metrics.jsonl + spend.jsonl track spend/byTool; the five diagnostic metrics absent                        |
| F3  | **Real-task eval, not smoke** — run the suite against actual tasks in a real repo (e.g. MEEMS), measure end-to-end completion                 | Smoke pass rate ≠ real-world acceptance | Per-model completion rate on ≥30 real tasks; tracked across versions          | 🟡 — real E2E harness exists (agentHarness.ts, 34 cases, real sandboxes) but tiny fixtures, not ≥30 real tasks |
| F4  | **Cross-tier regression harness** — same task set across local-small / local-large / cloud, ELO + completion                                  | No A/B when scaffolding changes         | Every scaffolding PR reports delta on F2 metrics                              | 🟡 — modelComparison.eval.ts compares models on one case set; no CI automation, no tier deltas                 |

**Exit criterion for Phase 0:** you can state, with numbers, what fraction of small-model failures are syntactic vs semantic. That number decides whether Phase 1 or Phase 4 has higher ROI for _your_ tool set.

---

## Phase 1 — Structural guarantees (syntactic layer; highest ROI lever)

This is the biggest single lever and the one most likely missing. Constrained decoding makes a malformed call _unsamplable_ rather than caught-after-the-fact.

| ID  | Item                                                                                                                  | Notes                                                                                                                                        | Acceptance                                                       | Status                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Per-tool grammar from JSON schema** — generate GBNF (llama.cpp), use Ollama `format`, or XGrammar/Outlines via vLLM | Drive it off your existing tool registry; one grammar per tool, union grammar gated on selected tool name                                    | Schema validity rate → ~100% on local models                     | 🟡 — **dead `format` path now ACTIVATED** as schema-constrained repair (v0.115, toolCallRepair.ts): the tool's `input_schema` is the grammar via Ollama `format`. Not yet proactive per-call grammar — engages on malformed only |
| A2  | **Constrain only at the action boundary**                                                                             | Free-form reasoning stays unconstrained; grammar engages only when emitting the tool call. Over-constraining reasoning lobotomizes the model | Reasoning quality unchanged vs unconstrained; calls always valid | ✅ — repair engages only on a malformed tool call (the action); reasoning + happy path untouched (v0.115, loop.ts boundary hook)                                                                                                 |
| A3  | **Tier-aware structured output**                                                                                      | Local small → grammar; cloud (Anthropic/OpenAI) → native tool-use/structured-output API (they don't need it)                                 | Single code path selects enforcement mode by backend             | ❌ — cloud backends ignore `responseFormat`; no selector path                                                                                                                                                                    |
| A4  | **Bash/command grammars**                                                                                             | Shell is your highest-blast-radius tool. Consider evidence-driven Lark grammars (cf. NVIDIA grammargen) rather than hand-written             | Executable call rate on shell tool ↑ measurably                  | ❌                                                                                                                                                                                                                               |
| A5  | **JSON-repair + reprompt fallback**                                                                                   | For any backend without logit access, repair malformed calls and reprompt with the _specific_ parse error before failing the turn            | Malformed-call failures that reach the user → ~0                 | ✅ — v0.115: heuristic JSON repair (jsonRepair.ts) + schema-constrained regeneration (toolCallRepair.ts); malformed text calls no longer silently dropped (textParsing.ts emits a `_malformedInputRaw` marker)                   |

---

## Phase 2 — Context economy (token tax + selection accuracy)

For a 3B model, 80 tool schemas in context is worse than a cost tax — lost-in-the-middle is more severe for small models, so it degrades _tool selection_ directly. Your ~23K-token request overhead is the symptom.

| ID  | Item                                   | Notes                                                                                                                                                             | Acceptance                                                  | Status                                                                                                                                               |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Per-turn tool subsetting**           | Retrieve K candidate tools for the current step (reuse your Project Knowledge Index machinery) and expose only those to the model                                 | Tool-selection accuracy ↑; per-request tokens ↓ sharply     | ❌ — static tier + per-facet allowlist, not per-turn (state.ts:267). NB: token tax already partly mitigated by B3 stubbing — measure before building |
| B2  | **Small-model-specific system prompt** | Terse, imperative, few competing directives. Frontier-tuned 7–10K-token prompts confuse small models. Strip mode/command boilerplate the small model doesn't need | Overhead tokens measured before/after; selection accuracy ↑ | 🟡 — `LOCAL_MAX_SYSTEM_CHARS` cap + recency tweak; prompt _content_ model-agnostic                                                                   |
| B3  | **Lazy skill/tool schema loading**     | One-line descriptor in context; full schema loads only on invocation (the "Pi" pattern)                                                                           | System-prompt baseline well under your current overhead     | 🟡 — **resolved**: tools lazy via `describe_tool`+stubs (tools.ts:462); skills inject full body eagerly (skillLoader.ts:15)                          |
| B4  | **Schema compression**                 | Drop verbose descriptions, collapse enums, prune optional args the small model misuses                                                                            | Tokens/tool ↓ with no executable-rate regression            | ❌ — schemas presented verbatim                                                                                                                      |

---

## Phase 3 — State externalization (move the plan out of the weights)

Small models drop the thread over a 50-iteration loop. The harness, not the model, should carry plan state.

| ID  | Item                             | Notes                                                                                                 | Acceptance                               | Status                                                                                                                                                                       |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Externalized plan/todo store** | Plan lives in harness state, not chat history                                                         | Plan survives compaction intact          | ❌ — **resolved**: PlanStore is a crash-resume message _snapshot_, not a live plan (planStore.ts:4); plan text rides the message window and is compressed like anything else |
| C2  | **Per-turn step re-injection**   | Each turn sees only {current step, last result, remaining steps} — one small, well-specified decision | "lost-plan" failure bucket (F1) ↓        | ❌ — model sees full history each turn                                                                                                                                       |
| C3  | **Working-memory scratchpad**    | Separate durable scratchpad from conversational history; small models conflate them                   | Long-horizon task completion ↑           | ❌ — Pinned = user-curated context, Episodic = RAG over compressed summaries; neither is a live scratchpad                                                                   |
| C4  | **Small-model-aware compaction** | Compaction is lossy; tune _what_ is dropped (keep plan + open contracts, drop resolved detail)        | No regression after auto-compact trigger | ❌ — thresholds uniform (compression.ts:142); only system-prompt char cap is size-aware                                                                                      |

---

## Phase 4 — Verification & feedback tuning (semantic layer)

You already lead here. The work is adapting it to a small _primary_, where a second-LLM critic is unreliable and expensive.

| ID  | Item                                                 | Notes                                                                                                                                                           | Acceptance                                            | Status                                                                                                                                 |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Validator-first execution**                        | Schema/type-validate the call _before_ running the tool                                                                                                         | Invalid calls never reach execution                   | 🟡 — JSON-syntax check only, not schema validation pre-exec (executor.ts:103)                                                          |
| D2  | **Prefer deterministic verifiers for small primary** | Typecheck/lint/test over the adversarial-critic LLM call when the primary is small (a small critic ≈ noise, doubles cost). Reserve LLM critic for cloud primary | Critic cost/turn ↓ on local; semantic-catch rate held | ❌ — critic fires identically for Opus and a 3B (criticHook.ts:305); tier signal exists (modelCapability.ts) but unwired to the critic |
| D3  | **Terse, concrete feedback**                         | Return the exact failing line/error, not prose. Small models act on specifics, drown in narrative                                                               | Recovery rate after first failure ↑                   | 🟡 — auto-fix/syntax gate concrete (file:line); some gate paths still prose                                                            |
| D4  | **Cheap completion gate**                            | Gate is good; ensure lint+tests run fast enough not to stall a local loop                                                                                       | Gate overhead within latency budget (F2)              | ✅ — gate + regression guards exist; no latency budget, 15s/command timeout only                                                       |

---

## Phase 5 — Routing & fallback (SLM-default, LLM-fallback)

The architecture you already have (architect/editor split, `delegate_task`) is correct; this makes it signal-driven.

| ID  | Item                              | Notes                                                                                              | Acceptance                                            | Status                                                                                       |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E1  | **Uncertainty/confidence signal** | Logprob-based or verifier-derived; trips escalation                                                | Escalations correlate with would-be failures          | ❌ — static heuristics only                                                                  |
| E2  | **Verifier-cascade escalation**   | N verifier failures on a subtask → escalate _that subtask_ to a frontier model, not the whole task | Failed-task rate ↓ at bounded CPS increase            | ❌ — fallback is circuit-breaker/error-triggered, not verification-triggered (client.ts:508) |
| E3  | **Up-front task-type routing**    | Planning-heavy / cross-cutting steps routed to big model before the small model spins on them      | Small model never assigned steps outside its envelope | 🟡 — architect/editor split + role routing (routing.ts:115); no task-type detection          |
| E4  | **Per-facet model envelopes**     | Extend typed sub-agent facets so each facet declares the smallest model that clears its task class | Each facet runs the cheapest sufficient model         | 🟡 — field exists but **built-in facets leave `preferredModel` empty** (facetLoader.ts:276)  |

---

## Phase 6 — Model-level adaptation (optional; highest effort)

| ID  | Item                                          | Notes                                                                                                                                                              | Acceptance                                            | Status                                                                                                                                 |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **LoRA/QLoRA on your tool-use trajectories**  | Fine-tune a small model on _your_ registry's correct trajectories — the literature shows tiny models crushing frontier models on in-distribution tool use this way | In-distribution executable-call rate approaches cloud | 🟡 — Kickstand LoRA attach/detach exists (consumption, kickstand.ts); audit logs exist (auditLog.ts) but not gate-labeled for training |
| G2  | **Few-shot trajectory library per task type** | Inject a known-good trajectory for the task class (budget against B's token economy)                                                                               | Cold-start tool-use accuracy ↑                        | ❌ — generic examples only; no task-typed trajectory injection                                                                         |
| G3  | **Model-selection guidance**                  | Curate which SLMs clear which task classes (SmolLM3, Qwen3-4B-Instruct, Ministral-3B/8B all current strong agentic picks)                                          | Default-model recommendation backed by F-metrics      | 🟡 — `modelCapability.ts` tier + Arena ELO; no curated guidance, no auto-select                                                        |

---

## Recommended sequence & rationale

1. **Phase 0** before anything — method-first. The syntactic-vs-semantic split decides Phase 1 vs Phase 4 priority for your registry.
2. **Phase 1 (A1–A2)** — almost certainly your biggest gap and biggest lever; uniquely available because you're local.
3. **Phase 2 (B1–B2)** — directly attacks the 23K overhead and small-model selection in one move.
4. **Phase 3 (C2)** — cheap, high-impact for long-horizon tasks once syntax is solved.
5. **Phase 4–5** — mostly making tier-aware what you already have.
6. **Phase 6** — only after F-metrics show a stubborn residual the harness can't close.

---

## Likely gaps to prioritize (net of what you've built — verified v0.114.56)

- **Grammar-constrained decoding (A1–A2, A4)** — v0.115 **activated** the dead `format` path: schema-constrained tool-call repair at the action boundary (A2 ✅). Remaining: proactive per-call grammar (A1 full) and bash/command grammars (A4).
- **JSON-repair / parse-error reprompt (A5)** — ✅ done in v0.115: heuristic repair + schema-constrained regeneration, and malformed text calls now emit a marker instead of being silently dropped.
- **Externalized plan with step re-injection (C1–C2)** — confirmed: the plan is a crash-resume _message snapshot_, not harness state. This is the one genuinely greenfield area; gate its priority on whether F1 shows "lost-plan" is a real bucket.
- **Failure taxonomy + the four diagnostic metrics (F1–F2)** — the harness and structured logs exist; what's missing is turn-level bucketing + schema-validity / executable-rate / tool-selection / CPS. Smaller lift than it looked.
- **Tier-awareness of critic, compaction, escalation (D2, C4, E2)** — all uniform today. The `modelCapability.ts` → `scaffoldingProfile` tier signal already exists; these just aren't wired to it. "Make X tier-aware" is consistently cheaper than billed.
- **Marketplace credibility** — the README's unbenchmarked "94% / best agentic score" claim and the "verified June 2026" competitor-gap rows are a live exposure independent of the above. Publish the eval output or soften the wording.

## Where you're already ahead of the field

Completion gate, regression guards, shadow workspaces, typed sub-agent facets, architect/editor split, `delegate_task`, prompt pruner, Model Arena — **plus** more than the listing showed: a real end-to-end agent eval harness (`agentHarness.ts` + `modelComparison.eval.ts`), structured `metrics.jsonl`/`spend.jsonl`, an ablation harness (`npm run eval:ablation`), tool-level progressive disclosure (`describe_tool` + stubs), and a `modelCapability.ts` capability-tier → scaffolding system. The verification stack (Phase 4) and delegation plumbing (Phase 5) are largely built. Remaining work is concentrated in **Phase 1 (activate the wired-but-unused constrained-decoding path), the tier-awareness cluster, and Phase 3 (real plan externalization)** — narrower than the original Phases 0–3 framing implied.
