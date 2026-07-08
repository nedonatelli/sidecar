# SideCar Roadmap

_Last updated: 2026-07-07 (v0.117.0)_

This document is forward-looking only: what SideCar is building next and why. Completed work lives in the [CHANGELOG](CHANGELOG.md).

---

## Release Plan

### Planned

**Organizing principle (revectored July 2026): depth over breadth.** Releases now deepen, prove, or prune what SideCar already has instead of adding capability surface. The drivers are the five depth axes below — the scaffolding program ([docs/scaffolding-roadmap.md](docs/scaffolding-roadmap.md)) promoted from background research to the release plan. The former candidate pool (the June 2026 competitive-gap analysis) is re-tagged by axis in the [Depth Backlog](#depth-backlog); its pure-breadth items moved to the [Vision Shelf](#unscheduled--vision-shelf).

| Axis                       | Depth goal                                                                                                                       | Grounding                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **1 · Context economy**    | Turn fixed O(N-tools/schemas) context cost into O(core + k-retrieved) — the biggest small-model lever                            | C1/C2 in the scaffolding roadmap; BFCL context findings                                             |
| **2 · Verification depth** | Deterministic verify layer that provably reduces fabrication — graded metrics, do-no-harm as a hard requirement                  | M1/M2 findings: binary pass/fail can't see reduction; critic proven net-negative; keep-best ratchet |
| **3 · Long-horizon state** | Externalize the plan and working memory out of the drifting message window                                                       | S1/S2 — the one genuinely greenfield area                                                           |
| **4 · Measurement power**  | Powered, honest instruments: cost-adjusted headline metric, n large enough to detect real effects, cross-tier regression harness | M3; Wilson CI + McNemar stats layer already shipped                                                 |
| **5 · Prove-or-prune**     | Every default-off feature gate earns a verdict: ablation/dogfood evidence → default-on, keep-gated, or **delete**                | ~20 features ship gated-off today; the critic ablation shows "shipped" ≠ "helps"                    |

| Version | Headline (candidate, not committed)                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.118  | **Verification depth** — unresolved-citation **count/rate** ablation metric (the open M1/M2 finding; graded, not binary) · keep-best third-arm SWE ablation (quantify the over-engineering-rate drop) · bail-early / do-no-harm investigation (scaffold turned `natural` completions into `bad-reasoning`) |
| v0.119  | **Long-horizon state** — S1 plan externalization (per-turn step re-injection: `{current step, last result, remaining steps}`) + S2 capability-tiered compaction (keep plan + open contracts, shed resolved detail)                                                                                         |
| v0.120  | **Prove-or-prune, round 1** — per-gate verdicts on the default-off feature set (see [Prove-or-Prune Ledger](#prove-or-prune-ledger)); default-on the ablation-proven winners, delete the losers                                                                                                            |

---

### Shipped

Per-release history (headlines, details, verification notes) lives in the [CHANGELOG](CHANGELOG.md). This roadmap deliberately carries no completed work.

---

### Depth Backlog

Re-tagged July 2026 by depth axis from the source-verified competitive gap analysis (June 2026, mined from OpenCode, _101 Claude Code Tips_, Ollama/MCP material — every item confirmed a real gap by reading the code; 9 candidates found already shipped were omitted). Items that added new capability surface rather than deepening an existing one moved to the [Vision Shelf](#unscheduled--vision-shelf).

**Axis 1 — Context economy**

- [ ] **Per-turn built-in-tool subsetting + schema compression** (C2) — gate the 80+ built-in tool schemas by task relevance for weak models; measure at real full-catalog scale first (BFCL under-tests lost-in-the-middle).

**Axis 2 — Verification depth**

- [ ] **Unresolved-citation count/rate metric** _(→ v0.118)_ — expose the citation gate's unresolved set as a numeric ablation metric; binary pass/fail provably cannot measure verify lift (M1/M2 finding).
- [ ] **Bail-early / do-no-harm investigation** _(→ v0.118)_ — a scaffold turned clean `natural` completions into `bad-reasoning` on 2/4 SWE tasks; do-no-harm is a hard requirement for any default-on scaffold.
- [ ] **Prompt-cache hygiene** — suspend (or warn on) format-on-save / background linters touching the agent's read-set mid-run; SideCar is uniquely exposed running in-editor + Anthropic caching.
- [ ] **Proactive LSP-diagnostics push** — completes an existing stub (`DiagnosticSubscriber` reactive path; the `get_diagnostics` pull-tool already ships). Free grounding signal the harness currently ignores.

**Axis 3 — Long-horizon state**

- [ ] **Plan externalization (S1)** _(→ v0.119)_ — externalized plan/todo store with per-turn step re-injection + durable working-memory scratchpad; today the plan lives only in the drifting message window.
- [ ] **Capability-tiered compaction (S2)** _(→ v0.119)_ — keep the plan + open contracts, shed resolved detail; the tier signal (A1) exists but isn't wired to compaction.

**Axis 4 — Measurement power & runtime observability**

- [ ] **Powered-measurement program (M3)** — cost-adjusted headline metric over raw pass rate; diagnostic metrics; ≥30-task real-repo suite; cross-tier regression harness; powered n for SWE-bench.
- [ ] **Ollama native response-metadata surfacing** — consume `load_duration`/`eval_count`/`eval_duration` for real tokens/sec + cold-start detection (dropped today at `ollamaBackend.ts:207`); feed status bar + arena.
- [ ] **GPU-residency / silent-CPU-fallback detection** — `nvidia-smi` or Ollama `/api/ps` to warn when a model spills out of VRAM mid-session (KV-cache growth); size-vs-VRAM math misses this.

**Deepen-existing (smaller; base already exists, scope is the delta)**

- [ ] Permission **command-prefix globs + per-agent overrides** (allow/ask/deny + `.sidecar/policy.json` already exist; tool-names-only today)
- [ ] Per-model **reasoning/thinking capability flag** (`supportsTools` already tracked; extends the A1 capability profile)

---

### Prove-or-Prune Ledger

Axis 5 made concrete. Every default-off feature gate must earn one of three verdicts — **default-on** (evidence it helps), **keep-gated** (niche but justified), or **delete** (unproven surface = maintenance tax). Scaffold gates are judged by ablation lift (`npm run eval:ablation` — graded metrics per the M1/M2 finding, not binary); feature gates by dogfood/usage evidence. The critic ablation is the cautionary precedent: shipped ≠ helps (measured −13% to −17% lift).

| Gate                                                                                                                                                                                              | Kind     | Evidence instrument               | Verdict so far                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `critic.enabled`                                                                                                                                                                                  | scaffold | ablation (done, 2 models)         | **net-negative** — keep-gated as last-resort opt-in; candidate for delete if unused |
| `scaffolding.keepBest`                                                                                                                                                                            | scaffold | SWE third-arm ablation (→ v0.118) | pending                                                                             |
| `adaptiveScaffolding.enabled` · `autoFixOnFailure` · `codeGraph.impactGate` · `numericalContracts.gate` · `analyticBounds.gate` · `mutation.enabled`                                              | scaffold | ablation on error-headroom cases  | pending — smoke set under-exercises them (v0.116 finding)                           |
| `modelRouting.enabled` · `nextEdit.enabled` · `enableInlineCompletions` · `diagnostics.reactiveFixEnabled`                                                                                        | feature  | dogfood + latency budget          | pending                                                                             |
| `profiling.enabled` · `latex.enabled` · `literature.enabled` · `notebookMode.enabled` · `research.enabled` · `visualVerify.enabled` · `evalHistory.enabled` · `voice.enabled` · `zenMode.enabled` | feature  | dogfood/usage                     | pending                                                                             |
| `mcpDelegation.enabled` · `mcpServer.enabled`                                                                                                                                                     | feature  | dogfood + security review         | pending — v0.117 hardening pass done; dogfood/usage verdict still open              |

---

### Unscheduled / Vision Shelf

Not promised to any specific release. Full specs in [docs/feature-specs.md](docs/feature-specs.md).

GPU-Native Hot-Swapping · GPU-Aware Load Balancing · Multi-repo cross-talk · Selective Regeneration · Zen Mode Context Filtering · Enterprise & Collaboration · Bitbucket/Atlassian integration · LanceDB HNSW backend (deferred from v0.110) · Domain Profiles (dense-repo context mode for physics/signal-processing) · Scheduled Task Concurrency Safety (Shadow routing + DocumentConcurrencyGate)

**Breadth items shelved by the July 2026 depth revector** (from the June 2026 competitive gap analysis; source-verified real gaps, deliberately deprioritized in favor of depth work): Multi-phase skills with idempotent resume · Per-skill self-updating "Lessons Learned" · Skill output-schema contract + negative "Rules" section · Batch clarify-Q&A (`ask_user` batch-emit + review-all + submit-together) · Global user-level guidance file (`~/.config/sidecar/SIDECAR.md`) · Markdown-authored slash commands unified with skills

**Small-model scaffolding bets not yet scheduled** (grounded specs + priority in [docs/scaffolding-roadmap.md](docs/scaffolding-roadmap.md) → _Planned initiatives_; C1 slice 1 shipped in v0.117; S1/S2 and the graded verify metric are in the v0.118–0.119 release plan above): Full on-demand capability database (C1 beyond MCP lazy loading — query-assemble tools/conventions/trajectories) · Verification-triggered escalation (verifier-failure count escalates a subtask to a stronger model) · Shape/dtype/unit-constrained decoding for numerical code · Bash/command grammars · Gate→trajectory flywheel (LoRA on gate-passing runs).

---

## Coverage Plan

**Enforced floor (v0.114)**: CI ratchet at `statements 70 / branches 63 / functions 67 / lines 71` (`COVERAGE_THRESHOLDS` in `vitest.config.ts`). VS Code lifecycle files (`extension.ts`, `chatView.ts`, `activation/`, `ui/`, `views/`, `commands/`) and non-behavioral code (`types.ts`, `constants.ts`, mocks, `chatWebview.ts`) are excluded from the denominator so the metric reflects test-worthy logic, not file-count accounting. RAG-eval ratchet active since v0.62: `meanPrecisionAtK ≥ 0.45`, `meanRecallAtK ≥ 0.95`, `meanF1AtK ≥ 0.55`, `meanReciprocalRank ≥ 0.90`.

**Policy**: every new source file lands with ≥80% coverage; the ratchet floor guards already-covered code against regression. Branch coverage carries the lowest floor because error paths and concurrent races are legitimately harder to exercise. Most recent reported measured full run was **80.0 / 70.99 / 81.4 / 81.25** — above floor on all four.

**Enforcement**: CI runs `vitest run --coverage` against `COVERAGE_THRESHOLDS`; any PR that drops a metric below the floor fails. Error-path and concurrent-race branches are the remaining gap — every new test suite deliberately targets those.

---

## Reference

- [Feature Specifications](docs/feature-specs.md) — detailed specs for every backlog item
- [Audit Archive](docs/audit-archive.md) — Cycle-4 audit findings (post-v0.79, 2026-04-21)
- [CHANGELOG](CHANGELOG.md) — per-release notes
- [SECURITY.md](SECURITY.md) — threat model and vulnerability disclosure
