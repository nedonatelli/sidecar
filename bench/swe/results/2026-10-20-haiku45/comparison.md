## Resolve rates (50 tasks)

| Agent                              | Resolved |
| ---------------------------------- | -------- |
| SideCar off, 50 it                 | 25/50    |
| SideCar on, 50 it                  | 25/50    |
| SideCar on, 150 it                 | 30/50    |
| SideCar on, 150 it, tiered budgets | 31/50    |
| Claude Code                        | 30/50    |
| mini-SWE-agent                     | 25/50    |

## Paired comparison (McNemar, two-sided exact)

| A                                  | B                                  | only A | only B | p     |
| ---------------------------------- | ---------------------------------- | ------ | ------ | ----- |
| SideCar off, 50 it                 | SideCar on, 50 it                  | 4      | 4      | 1.000 |
| SideCar off, 50 it                 | SideCar on, 150 it                 | 3      | 8      | 0.227 |
| SideCar off, 50 it                 | SideCar on, 150 it, tiered budgets | 2      | 8      | 0.109 |
| SideCar off, 50 it                 | Claude Code                        | 2      | 7      | 0.180 |
| SideCar off, 50 it                 | mini-SWE-agent                     | 6      | 6      | 1.000 |
| SideCar on, 50 it                  | SideCar on, 150 it                 | 2      | 7      | 0.180 |
| SideCar on, 50 it                  | SideCar on, 150 it, tiered budgets | 1      | 7      | 0.070 |
| SideCar on, 50 it                  | Claude Code                        | 2      | 7      | 0.180 |
| SideCar on, 50 it                  | mini-SWE-agent                     | 6      | 6      | 1.000 |
| SideCar on, 150 it                 | SideCar on, 150 it, tiered budgets | 3      | 4      | 1.000 |
| SideCar on, 150 it                 | Claude Code                        | 6      | 6      | 1.000 |
| SideCar on, 150 it                 | mini-SWE-agent                     | 8      | 3      | 0.227 |
| SideCar on, 150 it, tiered budgets | Claude Code                        | 5      | 4      | 1.000 |
| SideCar on, 150 it, tiered budgets | mini-SWE-agent                     | 8      | 2      | 0.109 |
| Claude Code                        | mini-SWE-agent                     | 8      | 3      | 0.227 |

## Per repo

| Repo         | n   | SideCar off, 50 it | SideCar on, 50 it | SideCar on, 150 it | SideCar on, 150 it, tiered budgets | Claude Code | mini-SWE-agent |
| ------------ | --- | ------------------ | ----------------- | ------------------ | ---------------------------------- | ----------- | -------------- |
| django       | 19  | 10                 | 10                | 11                 | 12                                 | 13          | 10             |
| sympy        | 12  | 8                  | 7                 | 8                  | 8                                  | 9           | 8              |
| matplotlib   | 4   | 0                  | 2                 | 2                  | 3                                  | 1           | 1              |
| scikit-learn | 4   | 2                  | 2                 | 3                  | 3                                  | 2           | 3              |
| pytest       | 3   | 1                  | 2                 | 3                  | 1                                  | 2           | 1              |
| sphinx       | 3   | 1                  | 0                 | 0                  | 1                                  | 1           | 0              |
| astropy      | 1   | 1                  | 1                 | 1                  | 1                                  | 1           | 0              |
| pylint       | 1   | 0                  | 0                 | 0                  | 0                                  | 0           | 0              |
| requests     | 1   | 1                  | 0                 | 1                  | 1                                  | 0           | 1              |
| seaborn      | 1   | 1                  | 1                 | 1                  | 1                                  | 1           | 1              |
| xarray       | 1   | 0                  | 0                 | 0                  | 0                                  | 0           | 0              |

## What the agents did (mean per task)

| Metric                  | SideCar off, 50 it | SideCar on, 50 it | SideCar on, 150 it | SideCar on, 150 it, tiered budgets | Claude Code | mini-SWE-agent |
| ----------------------- | ------------------ | ----------------- | ------------------ | ---------------------------------- | ----------- | -------------- |
| Model turns             | 43.4               | 44.3              | 60.2               | 68.7                               | 46.5        | 81.0           |
| Tool calls              | 43.0               | 45.2              | 64.8               | 65.9                               | 46.9        | 77.9           |
| Shell commands          | 14.8               | 15.9              | 21.7               | 32.5                               | 31.1        | 77.9           |
| Test runs               | 5.1                | 5.4               | 9.4                | 13.6                               | 8.2         | 8.9            |
| Searches (shell)        | 3.0                | 3.8               | 4.4                | 5.6                                | 10.3        | 15.2           |
| File reads              | 15.5               | 16.2              | 20.4               | 19.1                               | 11.6        | 0.0            |
| Re-reads of a read file | 11.5               | 11.9              | 15.6               | 14.2                               | 7.5         | 0.0            |
| First edit at call #    | 18.7               | 20.1              | 20.2               | 21.4                               | 15.5        | —              |
| Budget refusals         | 1.2                | 1.2               | 3.1                | 0.3                                | 0.0         | 0.0            |
| Runs with telemetry     | 50                 | 50                | 50                 | 50                                 | 50          | 50             |

## Turn distribution

| Agent                              | median | p90 | max | >50 | >100 |
| ---------------------------------- | ------ | --- | --- | --- | ---- |
| SideCar off, 50 it                 | 50.0   | 50  | 50  | 0   | 0    |
| SideCar on, 50 it                  | 50.0   | 50  | 50  | 0   | 0    |
| SideCar on, 150 it                 | 55.5   | 92  | 133 | 28  | 4    |
| SideCar on, 150 it, tiered budgets | 70.5   | 112 | 132 | 35  | 10   |
| Claude Code                        | 48.5   | 72  | 94  | 22  | 0    |
| mini-SWE-agent                     | 67.0   | 146 | 250 | 38  | 10   |
