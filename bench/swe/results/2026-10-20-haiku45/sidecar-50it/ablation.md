# SWE-bench Lite ablation — claude-haiku-4-5-20251001

## Headline: scaffolding lift = +0.0% (95% CI [-11.1%, +11.1%]), McNemar p = 1.000 — NOT significant

Same model, same 50-task slice, same seed — only the SideCar harness differs. This delta is the number a bare agent-wrapper cannot produce.

> ⚠️ **Not statistically resolvable at this n.** Only 8 discordant pair(s) (4 rescued, 4 regressed) — too few to separate this lift from chance (McNemar p = 1.000). Report the on/off rates below, but do NOT claim a resolve lift until more more tasks move the discordant count into a powered range. The behavioral signals (empty-patch rate, patch size, latency) are the usable evidence meanwhile.

## Reproducibility envelope

- model: `claude-haiku-4-5-20251001` (anthropic)
- dataset: SWE-bench_Lite slice (50) · max agent iterations: 50
- scored by official swebench harness 5.0.2
- **scaffold version: 5.1.0** (results comparable only across matching versions)

## Resolve rates

| Arm | Resolved | Rate (95% CI) | Empty patches | Mean latency | Mean turns | Scaffold fires |
| --- | --- | --- | --- | --- | --- | --- |
| scaffold-on | 25 / 50 | 50.0% [36.6%, 63.4%] | 3 | 118s | 44.3 | 1.1 |
| scaffold-off | 25 / 50 | 50.0% [36.6%, 63.4%] | 2 | 113s | 43.4 | 1.1 |

Latency cost of the harness: +5s per task.

**Rescued by the harness** (4): matplotlib__matplotlib-23562, matplotlib__matplotlib-25433, pytest-dev__pytest-5692, sympy__sympy-16792
**Regressed by the harness** (4): psf__requests-1963, sphinx-doc__sphinx-8801, sympy__sympy-18057, sympy__sympy-18698