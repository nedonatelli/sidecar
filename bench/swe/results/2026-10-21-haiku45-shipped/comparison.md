## Resolve rates (50 tasks)

| Agent | Resolved |
|---|---|
| SideCar shipped defaults (5.1.2) | 30/50 |
| SideCar 150 it, tiered budgets (5.1.1) | 31/50 |
| SideCar 150 it (5.1.0) | 30/50 |
| SideCar on, 50 it (5.1.0) | 25/50 |
| Claude Code | 30/50 |

## Paired comparison (McNemar, two-sided exact)

| A | B | only A | only B | p |
|---|---|---|---|---|
| SideCar shipped defaults (5.1.2) | SideCar 150 it, tiered budgets (5.1.1) | 4 | 5 | 1.000 |
| SideCar shipped defaults (5.1.2) | SideCar 150 it (5.1.0) | 6 | 6 | 1.000 |
| SideCar shipped defaults (5.1.2) | SideCar on, 50 it (5.1.0) | 9 | 4 | 0.267 |
| SideCar shipped defaults (5.1.2) | Claude Code | 3 | 3 | 1.000 |
| SideCar 150 it, tiered budgets (5.1.1) | SideCar 150 it (5.1.0) | 4 | 3 | 1.000 |
| SideCar 150 it, tiered budgets (5.1.1) | SideCar on, 50 it (5.1.0) | 7 | 1 | 0.070 |
| SideCar 150 it, tiered budgets (5.1.1) | Claude Code | 5 | 4 | 1.000 |
| SideCar 150 it (5.1.0) | SideCar on, 50 it (5.1.0) | 7 | 2 | 0.180 |
| SideCar 150 it (5.1.0) | Claude Code | 6 | 6 | 1.000 |
| SideCar on, 50 it (5.1.0) | Claude Code | 2 | 7 | 0.180 |

## Per repo

| Repo | n | SideCar shipped defaults (5.1.2) | SideCar 150 it, tiered budgets (5.1.1) | SideCar 150 it (5.1.0) | SideCar on, 50 it (5.1.0) | Claude Code |
|---|---|---|---|---|---|---|
| django | 19 | 12 | 12 | 11 | 10 | 13 |
| sympy | 12 | 9 | 8 | 8 | 7 | 9 |
| matplotlib | 4 | 1 | 3 | 2 | 2 | 1 |
| scikit-learn | 4 | 2 | 3 | 3 | 2 | 2 |
| pytest | 3 | 2 | 1 | 3 | 2 | 2 |
| sphinx | 3 | 1 | 1 | 0 | 0 | 1 |
| astropy | 1 | 1 | 1 | 1 | 1 | 1 |
| pylint | 1 | 0 | 0 | 0 | 0 | 0 |
| requests | 1 | 1 | 1 | 1 | 0 | 0 |
| seaborn | 1 | 1 | 1 | 1 | 1 | 1 |
| xarray | 1 | 0 | 0 | 0 | 0 | 0 |

## What the agents did (mean per task)

| Metric | SideCar shipped defaults (5.1.2) | SideCar 150 it, tiered budgets (5.1.1) | SideCar 150 it (5.1.0) | SideCar on, 50 it (5.1.0) | Claude Code |
|---|---|---|---|---|---|
| Model turns | 66.1 | 68.7 | 60.2 | 44.3 | 46.5 |
| Tool calls | 63.7 | 65.9 | 64.8 | 45.2 | 46.9 |
| Shell commands | 30.7 | 32.5 | 21.7 | 15.9 | 31.1 |
| Test runs | 13.1 | 13.6 | 9.4 | 5.4 | 8.2 |
| Searches (shell) | 5.1 | 5.6 | 4.4 | 3.8 | 10.3 |
| File reads | 18.9 | 19.1 | 20.4 | 16.2 | 11.6 |
| Re-reads of a read file | 14.2 | 14.2 | 15.6 | 11.9 | 7.5 |
| First edit at call # | 21.8 | 21.4 | 20.2 | 20.1 | 15.5 |
| Budget refusals | 0.1 | 0.3 | 3.1 | 1.2 | 0.0 |
| Runs with telemetry | 50 | 50 | 50 | 50 | 50 |

## Turn distribution

| Agent | median | p90 | max | >50 | >100 |
|---|---|---|---|---|---|
| SideCar shipped defaults (5.1.2) | 64.5 | 102 | 150 | 34 | 6 |
| SideCar 150 it, tiered budgets (5.1.1) | 70.5 | 112 | 132 | 35 | 10 |
| SideCar 150 it (5.1.0) | 55.5 | 92 | 133 | 28 | 4 |
| SideCar on, 50 it (5.1.0) | 50.0 | 50 | 50 | 0 | 0 |
| Claude Code | 48.5 | 72 | 94 | 22 | 0 |
