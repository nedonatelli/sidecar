# Literature Foundations — Scaffolding for Small Models

_Third companion to the architecture and roadmap docs. Reading list mapped to roadmap workstreams; each entry notes what it establishes and which design claim it grounds. arXiv IDs given where stable._

**State of the field (the honest framing).** Two independent threads converged recently. (1) _Harness engineering_ is now named as its own discipline — the scaffolding around the model (context delivery, tool interfaces, planning artifacts, verification loops, memory, sandboxes) determines real-task success more than the model does. (2) The _small-models-for-agentic_ thesis now has empirical backing: for scoped, schema-constrained agentic subtasks, sub-10B models are sufficient and economically dominant. The intersection — scaffolding designed _specifically_ for small models — is the emergent, under-saturated area, which is exactly where SideCar lives.

---

## A. Framing — harness engineering as a discipline

- **Agent Harness Engineering: A Survey** (2026) — introduces a seven-layer harness taxonomy and traces the arc from the ReAct while-loop through AutoGPT/BabyAGI failures (execution runaway, context blowout, state loss) being recognized as _infrastructure_ problems, not prompt problems. The best single framing of what SideCar is.
- **awesome-harness-engineering** (ai-boost, GitHub) and **awesome-agent-harness** (RUCAIBox, GitHub) — curated, maintained catalogs of harness components, evals, memory, permissions, observability. Use as living indices.
- **Addy Osmani — Agent Harness Engineering** (2026) — names the harness↔model co-training feedback loop: models get post-trained _inside_ harnesses, so they overfit to specific tool logic (the `apply_patch` vs `str_replace` regression). Direct caution for a **model-agnostic** tool — "the best harness is the one designed for your task, not the one the model trained inside."

## B. The SLM-for-agentic thesis (grounds the whole bet)

- **Belcak et al., Small Language Models are the Future of Agentic AI** (2506.02153, NVIDIA) — the position paper: <10B models are sufficient, more suitable, and 10–30× cheaper for most agentic invocations; includes an LLM→SLM conversion algorithm. The economic and architectural justification for local-first.
- **Small Language Models for Agentic Systems: A Survey** (2510.03847) — the operational companion: SLM-default/LLM-fallback architectures, the routing pseudo-algorithm, and the production metrics you adopted (schema validity, executable-call rate, CPS, p50/p95). Maps to Phase 0 and Phase 5.
- **A Comprehensive Survey of Small Language Models in the Era of LLMs** (2411.03350) — broad reference on SLM techniques and trustworthiness.
- **Small Models, Big Tasks: Empirical Study on SLMs for Function Calling** (2025) and **DispatchQA** (EMNLP 2025 industry) — empirical floors on small-model function-calling, domain-scoped.

## C. Phase 1 — Constrained / structured decoding (the biggest lever)

- **XGrammar** (2411.15100, Dong et al., CMU/NVIDIA) — the efficient grammar engine; adaptive token-mask caching, low overhead, exposes a token-mask interface. The reference implementation for your tool-call grammars.
- **Geng et al., Grammar-Constrained Decoding for Structured NLP Tasks without Finetuning** (EMNLP 2023) — foundational: enforce structure at decode time, no training.
- **Generating Structured Outputs from LMs: Benchmark and Studies / JSONSchemaBench** (2501.10868) — head-to-head of Guidance/Outlines/llama.cpp/XGrammar/OpenAI/Gemini over 10K real schemas. Use to pick your enforcement backend.
- **The Alignment Tax of Constrained Decoding in LLM Reflection** (2604.06066) — the essential caveat: hard constraints can degrade reasoning ("structure snowballing"), _but_ shifting format adherence from the training layer to the decoding layer reduces cognitive load on small models. This is the empirical basis for your **constrain-at-the-action-boundary-only** rule (A2) — grammar the tool call, never the reasoning.
- **SLOT: Structuring the Output of LLMs** (2505.04016) and **Tam et al. (2024)** — format-forcing via prompting alone produces invalid structures and can lower reasoning performance; constrained decoding is the fix. Justifies why grammars beat "please output JSON."

## D. Phases 2–3 — Context engineering, memory, state externalization

- **Liu et al., Lost in the Middle** (2307.03172) — the foundational result: models underweight mid-context information; worse for small models. The reason 80 tool schemas in-context wrecks selection (B1).
- **Rethinking Memory in LLM-based Agents** (2505.00675) and **Memory for Autonomous LLM Agents: Mechanisms, Evaluation, Emerging Frontiers** (2603.07670) — the two memory taxonomies; representations, operations, retrieval-vs-context tradeoffs.
- **Contextual Memory Virtualisation: DAG-Based State Management and Structurally Lossless Trimming** (2602.22402) — directly validates your lossless-by-omission thesis (§2.2). Documents native autocompaction discarding 98% of session state (132k→2.3k tokens) and proposes structurally lossless alternatives. Read this against your C-phase.
- **MemGPT** (2310.08560) — OS-style virtual memory hierarchy; explicit read/write memory ops. The model for externalized working memory (C3).
- **A-MEM** (Zettelkasten-style linked memory) and **Zep/Graphiti** (temporal knowledge graph) — structured memory beating flat vector stores; relevant if the capability database (§2.2) grows toward a graph.
- **Reflexion** (2303.11366) and **Voyager** (2305.16291) — episodic self-reflection memory and a reusable skill library; the conceptual ancestors of your lazy-skills + trajectory store.
- **CodeCompass: Navigating the Navigation Paradox** (2602.20048) — "having a file in context does not guarantee the model uses it correctly." The coarse-grained analogue of lost-in-the-middle and the argument for a code graph over chunk retrieval (cross-cutting §4).

## E. Phase 4 — Verification & self-correction (grounds deterministic-verifier-first)

- **Huang et al., LLMs Cannot Self-Correct Reasoning Yet** (2310.01798, DeepMind) — the core result: without _external_ feedback, intrinsic self-correction fails and often _degrades_ performance. The direct justification for preferring deterministic verifiers (tests/types/lint) over an LLM self-critique when the primary is small (D2).
- **The Self-Correction Illusion: LLMs Correct Others but Not Themselves** (2606.05976) — relabeling a byte-identical wrong claim from the model's own `<thought>` to an external role lifts correction by 23–93 points. Validates your **adversarial critic as a separate role/agent** — and implies an external deterministic signal is stronger still.
- **Cobbe et al.** (GSM8K verifiers, 2110.14168) and **Lightman et al., Let's Verify Step by Step** (2305.20050) — the standalone-verifier and process-reward classics; the case for a trained verifier over self-judgment.
- **Self-Correction with Key Condition Verification** (2405.14092, EMNLP 2024) and **PAG: Policy as Generative Verifier** (2506.10406) — verify-then-revise only when an attempt is flagged wrong, rather than always re-attempting. Relevant to making the critic cheap on small primaries.
- _Context for the snowball risk:_ once a small model commits to a wrong call it tends to justify it ("hallucination snowballing") — supports validator-first execution (D1), catching the bad call _before_ it executes.

## F. Phase 5 — Routing & cascades (SLM-default, LLM-fallback)

- **Chen, Zaharia, Zou — FrugalGPT** (2305.05176, TMLR) — the canonical cascade: adaptive routing across model tiers, matching top-model accuracy at up to ~98% cost savings. The reference for E2/E3.
- **Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey** (2603.04445) — the three-stage control pipeline you should mirror: low-cost pre-router → post-generation verifier → escalation policy.
- **AutoMix** (2024) — self-verification drives escalation; the verifier-cascade pattern (E2).
- **Chuang et al., Confident or Seek Stronger** (2025) — uncertainty-based **on-device SLM→stronger-LLM** routing, benchmarked; the closest match to your local-first escalation.
- **UCCI: Calibrated Uncertainty for Cost-Optimal Cascade Routing** (2605.18796) — practical and important: raw logprob/token-margin is a _weak_ routing signal until calibrated (isotonic fit on held-out data); calibrate first, threshold second. Shapes how you build E1.
- **GATEKEEPER / I Know What I Don't Know** (2502.19335) — confidence tuning for cascades; deferral improves with calibrated abstention. (Production caveat widely reported: self-reported confidence is poorly calibrated — set thresholds from _your_ labeled tasks, not benchmark numbers.)

## G. Phase 6 — Tool-learning & fine-tuning on trajectories

- **Gorilla** (Patil et al., NeurIPS 2024) — fine-tune + retriever-in-training-loop for massive/evolving APIs; APIBench. The model for fine-tuning to _your_ registry (G1).
- **ToolLLM** (Qin et al., ICLR 2024) — 16k APIs, DFS decision trajectories teaching exploration/recovery.
- **Toolformer** (Schick et al., 2023) and **CodeAct** (ICML 2024, executable code actions over JSON calls) — foundational tool-use training paradigms.
- **Hammer** (function masking during fine-tuning to penalize hallucinated/irrelevant tools) — a robust **on-device** function-calling recipe; the most directly small-model-relevant tuning trick.
- **Agent-FLAN, AgentTuning, FireAct** — agent-tuning data/method papers for turning base models into reliable tool users.
- **Self-Evolving AI Agents: A Survey** (2508.07407) — SFT-on-trajectories as the flywheel; ties your gate-passed runs to a training corpus.
- **Simia-SFT / Simia-RL** (2511.01824) — synthesize tool-use trajectories _without_ a real environment; an 8B model fine-tuned this way beats GPT-4o-class on τ²-Bench subtasks. Makes G1/G2 cheap to bootstrap.
- **Fission-GRPO: Learning to Recover from Execution Errors** (2601.15625) — RL specifically for robust tool-error recovery; relevant once deterministic feedback (D3) is in place.

## H. Cross-cutting — benchmarks, injection, error taxonomies

- **Benchmarks (Phase 0 / F3):** BFCL v4 (function calling), StableToolBench (tool execution), τ²-Bench (multi-turn tool agents), SWE-bench / TerminalBench (coding loop), RouterBench (routing), JSONSchemaBench (constrained decoding). These are your _independent_ yardsticks — run at least one alongside your MEEMS-task eval.
- **AgentDojo** (Debenedetti et al., NeurIPS 2024) — dynamic environment for evaluating prompt-injection attacks/defenses on tool-using agents. The eval harness for your injection-hardening concern (§4).
- **AgentDebug — Where LLM Agents Fail and How They Learn From Failures** (ICLR 2026) — an Agent Error Taxonomy with modular failure categories. Adopt/adapt for your F1 failure taxonomy rather than inventing one.
- **The Evolution of Tool Use in LLM Agents** (2603.22862) — survey threading syntax-alignment → orchestration; good map of the tool-use sub-field.

---

# Deeper review — additional clusters

_Second pass, hunting architecturally central areas under-covered above. Several turned out to validate SideCar's design as independent convergent work._

## J. Tool retrieval at scale — the empirical core of §2.2

The literature directly under your on-demand capability database, more developed and more validating than the first pass suggested.

- **ToolRet — Retrieval Models Aren't Tool-Savvy** (2503.01763, Shi et al. 2025) — the key warning: across 7.6k retrieval tasks over 43k tools, even strong conventional IR models fail at tool retrieval, and **retrieval quality directly degrades downstream task pass rate**. Empirical proof of your §2.2 catch — retrieval is a first-class bottleneck, not solved preprocessing, and its failures are silent. Ships a 200k-instance training set for fine-tuning tool-retrieval IR models.
- **The tool-selection collapse number:** on BFCL-derived scheduling tasks, accuracy falls from ~43% at 4 tools to ~2% at 51 — not graceful degradation. The hard quantification behind B1.
- **RAG-MCP** (2505.03275) — retrieve only relevant MCP schema(s) before engaging the model; restores selection accuracy to small-toolset levels, cuts tokens >50%, triples selection success under load, indexes new tools without retraining. Your §2.2 architecture, independently validated.
- **ITR — Instruction-Tool Retrieval** (2602.17046) — the closest convergent work: retrieves per step both the minimal system-prompt fragments _and_ the smallest tool subset, with confidence-gated fallbacks; reports 95% per-step context reduction, 32% relative routing gain, 70% cost cut, 2–20× more loops. This is §2.2 + B1 + B2 + your tiered dynamic prompt in one paper — read it closely.
- **Toolshed** (2410.14594, Lumer et al.) and **ScaleMCP** (2505.06416) — tool knowledge bases / RAG-Tool Fusion and dynamic auto-synchronizing registries; both flag the ~128-tool provider ceiling and the "1000 database-operation tools" scaling case. Relevant to keeping your single registry (§2.3) in sync.
- **SkillRet** (2605.05726) — extends retrieval benchmarking from tools to _skills_ (procedural content, reusable prompting logic); maps to your lazy-skills layer.

## K. Type-constrained / semantic code generation — the bridge to your moat (extends §C)

Constrained decoding has already moved beyond syntax into _semantics_ — the mechanism your numerical vertical needs.

- **Type-Constrained Code Generation with LMs** (2504.09246, Mündler et al., ETH) — the seminal one: prefix automata + search over inhabitable types enforce well-typedness during decoding, **more than halving compiler errors and raising functional correctness** across model sizes/families. Proof that decoding constraints can encode _semantic_ rules, not just JSON shape.
- **PL Techniques for Bridging LLM Codegen Semantic Gaps** (2507.09135) — type-system-guided generation; HiTyper's Type Dependency Graphs for _Python_ (the dynamically-typed, harder case that is your domain); LSP integration for real-time type/binding info.
- **DCCD — Draft-Conditioned Constrained Decoding** (2603.03305) — sharpens your "constrain the action, not the reasoning" rule into a method: unconstrained draft first, then constrain conditioned on it, because hard masking otherwise pushes decoding toward locally-valid-but-semantically-wrong trajectories. The refinement of A2.
- **Learning to Guarantee Type Correctness** (2510.10216) — caveat consistent with your thesis: type-constraints can shift output to a _still-incorrect but well-typed_ program. Valid ≠ correct, at the type level too.

_Implication for §5:_ shape/dtype/unit-constrained decoding for numerical Python is the natural extension of this line — and it does not yet exist. Your moat sits one clear step past the published frontier.

## L. Test quality & mutation testing — grounding "verify the verifier" (extends §E)

The empirical backbone for your completion-gate-theater concern.

- **Mutation-Guided LLM Test Generation at Meta (ACH)** (2501.12862) — the killer industrial result: of 571 generated tests, **277 would have been discarded under line-coverage criteria but were kept under mutation-based adequacy** — coverage-green systematically misses what mutation catches. 73% engineer acceptance; also tackles equivalent-mutant detection. The number that justifies adding mutation testing to your gate.
- **Rethinking the Value of Agent-Generated Tests** (2602.07900) — characterizes what SE agents actually write (real assertions vs observational prints) and how it relates to resolution — i.e., the trivial-test failure mode, measured.
- **Test vs Mutant / ADVERTEST** (2602.08146) — couples adversarial LLM test generation with LLM mutant generation; surviving mutants expose structural test weaknesses coverage can't see. The exact blind spot: a test that executes a statement without asserting its effects passes while missing the bug.
- **MuTAP** (Dakhel et al. 2024) — first to feed surviving mutants back into prompts to strengthen LLM-generated tests.
- **Meta Engineering, "LLMs Are the Key to Mutation Testing"** (2025) — mutation testing forces tests that _validate behavior instead of just executing it_; catalogs the five deployment barriers (mutant volume, unrealistic/equivalent mutants, cost, scale).

## M. Planning & decomposition (Phase 3)

- **Understanding the Planning of LLM Agents: A Survey** (2402.02716, Huang et al.) — canonical taxonomy: task decomposition (decomposition-first vs interleaved), multi-plan selection, external-planner-aided, reflection/refinement, memory-augmented. The map for your externalized-plan work.
- **ADaPT — As-Needed Decomposition and Planning** (Prasad et al. 2023) — the standout for small models: recursively decompose a subtask _only when the executor can't handle it_, adapting to task complexity and **model capability**. The planning-side mirror of your SLM-default/LLM-fallback (Phase 5).
- **ReAct** (Yao et al. 2022), **Plan-and-Solve** (Wang et al. 2023), **Tree-of-Thoughts** (Yao 2023), **RAP / LLM-MCTS** — decomposition and plan-search primitives; tree/MCTS search matters only if a small model can sustain it (often it can't — externalize instead).
- _Cost note:_ reflection/multi-plan methods cost materially more tokens — ties to your §2.5 scaling trade.

## N. Multi-agent orchestration & failure modes

- **MAST — Why Do Multi-Agent LLM Systems Fail?** (2503.13657, Cemri et al., Berkeley, NeurIPS 2025) — 1,600+ traces, 7 frameworks, κ=0.88; 14 failure modes in three categories: **specification/system-design (~42%), inter-agent misalignment/coordination (~37%), verification gaps (~21%)**. Two findings land on SideCar directly: (1) failures are architectural, not model-level — single-agent sometimes _beats_ multi-agent with the same model, the empirical case for running your strongest model at the orchestration/merge layer; (2) MAS verifiers are typically superficial ("code accepted if it compiles") — the multi-agent restatement of verify-the-verifier. Production MAS failure rates reported at 41–86.7%.
- _Concrete use:_ MAST's specification category validates facets-as-specification (§2.3); its coordination category is your Fork-&-Parallel-Solve merge risk; adopt its taxonomy for the orchestration slice of F1.

## O. Repo-level code understanding & code graphs — the flagged SideCar gap

The literature for the code graph you don't yet have; mature, with large gains.

- **RepoGraph** (2410.14684, Ouyang et al., ICLR 2025) — a plug-in repository-level code graph that **boosts existing SWE agents by 32.8% relative on SWE-bench**. Headline evidence that graph structure beats flat chunk retrieval.
- **CodexGraph** (Liu et al., NAACL 2025) — exposes the code graph to the agent via a **graph-database query interface**; the agent writes and runs queries for structure-aware navigation. The cleanest model for folding a code graph into your §2.2 capability database as another queryable source.
- **Caller-Centric Exploration / ReCUBE** (2603.25770) — surfaces incoming callers and call hierarchies _before_ the agent implements a change — exactly the invisible-20% ("who calls this") problem you described.
- **GraphCoder** (ASE 2024, control-flow + data/control-dependence), **LocAgent** (ACL 2025, heterogeneous graph for multi-hop localization), **KGCompass** (issue↔code-entity KG, 58.3% SWE-bench Lite), **Aider's PageRank repo map** (the production-simple version), **RepoCoder** (the iterative-RAG baseline to beat).
- **Issue Localization via Iterative Code Graph Searching** (2503.22424) — module- and function-call graphs specifically for **Python** repositories — closest to your stack.

---

## P. Where the literature is thin (gaps = your opportunities) — updated after the deeper pass

The deeper pass _closed_ several apparent gaps (tool retrieval, code graphs, type-constrained decoding all turned out mature). What remains genuinely open is narrower and sharper:

- **Shape/dtype/unit-constrained decoding for numerical code.** Type-constrained decoding (§K) exists for general type systems; _array-semantic_ constraints (broadcast compatibility, unit consistency, dimensional analysis) for numerical Python do not. Your moat, one concrete step past the published frontier — and publishable.
- **Numerical correctness as an agent gate.** Property-based testing (Hypothesis) on generated kernels and validation against analytic bounds, wired into the completion gate — no dedicated literature. Combined with mutation testing (§L), a correctness-gate story no one has told.
- **Scaffolding _for small models specifically_, with controlled per-failure-mode attribution.** Many position papers and individual tricks; few studies isolating which intervention moves which small-model bucket. Your Phase-0 instrumentation (F1) over the failure taxonomies (AgentDebug §H, MAST §N) could produce exactly that.
- **The valid-vs-correct gap under constraints, measured for small models.** Constraints guarantee valid; how often a schema- or type-valid call from a 3B is _semantically_ wrong, and how much deterministic verification recovers, is essentially unmeasured. A clean empirical question sitting directly on your stack.
