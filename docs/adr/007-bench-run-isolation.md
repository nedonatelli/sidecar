---
title: 'ADR-007: Process-level isolation for benchmark runs, no OS sandbox'
layout: docs
---

# ADR-007: Process-level isolation for benchmark runs, no OS sandbox

**Date**: 2026-10
**Status**: Accepted

## Context

The SWE-bench driver (`tests/llm-eval/swe.eval.ts`) runs the agent's `run_command` calls on the host, in a persistent shell that starts in the task's clone. #196 found what that allowed. An agent that ran `cd /tmp` stayed there for the rest of the run, and one scaffold-off run spent 297 of its 351 seconds in a `find` over the host's whole filesystem. Nothing contained the commands themselves.

Two mechanisms have been added since:

- **Shell guard (#199).** After each `run_command`, a shell that has left the clone is moved back, and the result tells the model so. A `cd` inside the clone still persists, as it does in the product. The manifest records `shellGuard: true`.
- **Shell isolation (#357).** Each task's shell gets its own `TMP`/`TEMP`/`TMPDIR` and `HOME` under the run's scratch folder, plus `PYTHONNOUSERSITE=1`. So temp listings, `~`, and user-wide Python packages show nothing of the machine's user. The manifest records `shellIsolated: true`.

Scoring already runs in containers, under the official harness in WSL. The open question was whether the agent's own commands should run in an OS sandbox or a container too.

The options:

- **macOS sandbox for bench runs.** The product's sandbox (`src/terminal/seatbelt.ts`, around `/usr/bin/sandbox-exec`) is macOS-only, and the session ignores it on Windows and Linux. Turning it on would contain macOS runs only, so a campaign would behave differently depending on which machine ran it.
- **Predictions inside WSL or a container.** This would contain every host. It also changes the environment the agent works in (paths, shell, toolchain, line endings), so every existing baseline would need re-running. It adds container setup to every campaign, and the agent's environment would differ from what users run.
- **Process-level isolation only** (what #199 and #357 provide). Cheap, the same on every host, and baselines stay comparable from the version that introduced it.

## Decision

Benchmark prediction runs use **process-level isolation only**: the shell guard plus per-task temp and home folders. They don't run inside an OS sandbox or a container. Scoring stays in containers.

This holds while:

- runs happen on machines the maintainer controls;
- the tasks are public benchmark repositories (SWE-bench Lite);
- run data is scanned before it is published anywhere (the trajectory exporter's checks).

Revisit this decision if any of those stops holding. Examples: running tasks from untrusted sources, running on a shared machine or one that holds other people's data, or finding an agent run that reached outside the clone in a way the guard and isolation didn't stop.

## Consequences

**Easier:**

- Campaigns run the same way on Windows, macOS and Linux hosts with no container setup.
- The agent works in an environment close to what users run, and results stay comparable with baselines taken since `shellIsolated` was introduced.

**Harder or accepted:**

- The agent's commands are not contained. They run as the user, and absolute paths, the network, and anything else the user can reach stay reachable. That's why the conditions above matter.
- Isolation is incomplete on Windows: Git for Windows maps `/tmp` to the real Temp folder, and that can't be remapped from inside the shell.
- Cells run with and without `shellIsolated` must not be compared, because isolation changes trajectories.
- The macOS sandbox stays a product feature and is off in bench runs (`sandboxEnabled: false`).
