# SWE-bench solve-environment scoping

## The problem (root cause of the flat, model-agnostic numbers)

`swe.eval.ts` clones each repo at `base_commit` and `reset --hard`s it, but **never
installs the repo's dependencies**. So during the _solve_:

- `import <repo>` fails; `run_tests` returns an `ImportError`/collection error, not
  real pass/fail. Reproduced on django-10914: the agent's 4 identical `run_tests`
  results were all the same env error.
- The agent codes **blind** — it can't reproduce the bug, can't verify a fix, can't
  regression-check. Its core write→test→fix loop is dead.
- Worse, when the agent retries the (uselessly identical) test, **cycle detection
  kills it as "bad-reasoning."**

This caps _every_ model near the floor and **flattens strong vs weak** — the
observed gemma4 (70/70 on our eval) ≈ qwen (48/70) tie on SWE-bench is this. The
scaffold's verification layer (completion gate, auto-fix, `run_tests`) is built on
real test feedback, so it never got a fair test either.

Watched trajectory (gemma4, django-10914, "set `FILE_UPLOAD_PERMISSIONS` default to
`0o644`" — a one-liner): it edited `storage.py`'s constructor (wrong file; the fix
is `global_settings.py`), wrote its _own_ test, ran it 4× against the broken env,
and was cycle-killed. 716s, `bad-reasoning`, failed.

## The enabler (confirmed)

`swebench.harness.constants.MAP_REPO_VERSION_TO_SPECS` gives the **authoritative
per-`(repo, version)` recipe** — the same source the scorer uses, so solve and
score can't drift:

```
django/django @ 3.0 → python 3.6, install: pip install -e .,
                      test_cmd: ./tests/runtests.py --settings=test_sqlite
```

Plus each task carries `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, `base_commit`.

## Why uv (validated spike)

`uv` removes the two reasons this seemed to need Docker:

1. **Python provisioning** — `uv venv --python 3.8` pulls a standalone CPython
   (arm64) for the pinned version. No pyenv/system-python fight.
2. **Speed** — editable install of django 3.0 + deps in seconds; cache per
   `(repo, version)`.

**Spike (django-10914), all local, no Docker:**

```
uv venv --python 3.8 .venv && uv pip install -e .        # seconds
apply test_patch; runtests <FAIL_TO_PASS>   → FAILED     # bug reproduces
+ apply gold code patch;    runtests        → OK          # fix flips it green
```

→ the uv env **faithfully reproduces the task**. Approach validated.

### Protocol note

The `test_patch` (hidden acceptance test) is applied **only** at scoring /
validation time — the agent never sees it. The solve environment's value is that
`run_tests`, `run_command`, and the agent's own repro scripts finally _work_
against installed deps. The gold-patch check (test_patch + gold → green) is a
**harness-internal validation gate**: confirm an env reproduces a task before
trusting the agent's runs on it (the "validate the ceiling before trusting local
numbers" discipline).

## What uv does NOT fix (container fallback)

- **Native C-extension deps at pinned old versions** — numpy, scipy, matplotlib,
  scikit-learn, pandas, xarray. Old pins often have no arm64 wheels and won't
  compile against modern clang. → containerized `run_tests` (Modal), native-dep
  repos only.
- **Sub-3.7 pins** (e.g. django 3.0's 3.6): substitute nearest available (3.8) and
  gate on the gold-patch check, or route to a container.

## Plan

**Phase 0 — env-independent correctness (small, isolated, do first)**

- Don't let cycle detection kill a legitimate verify loop (repeated `run_tests`
  while iterating is correct behavior, not "bad-reasoning").
- (No "point run_tests at FAIL_TO_PASS" — that test is hidden by protocol.)

**Phase 1 — uv-local environments (primary path; pure-Python majority)**

- In `swe.eval` setup: spec-driven from `MAP_REPO_VERSION_TO_SPECS` — `uv venv
--python <spec>`, install deps + editable repo, cached per `(repo, version)`.
- Wire `run_tests`/`run_command`'s shell session to the venv (`VIRTUAL_ENV`/`PATH`,
  cwd = repo).
- Precompute + cache the gold-patch validation gate per task; skip/flag tasks whose
  env doesn't reproduce.
- Covers django, sympy, sphinx, pytest, flask, requests, pylint, … — free, offline.

**Phase 2 — containerized `run_tests` (fallback; native-dep tail)**

- Sync working tree into the task's swebench image (Modal, reuse the scorer image),
  run `test_cmd` there. Only for repos uv can't build locally.

## Success criterion

`run_tests` returns real pass/fail during the solve; the agent can reproduce → fix
→ verify. Re-run the ablation on the validated (env-backed) task subset — the first
point at which "does the scaffold lift?" can actually be answered. Hold full
re-runs until then; more runs on the blind harness only reconfirm the floor.
