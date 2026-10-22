# Debugging trajectories

This directory contains the four model-engaged attempts from the October 21
overnight SWE queue. The 22 cache-miss attempts are intentionally absent: the
agent never began for those attempts, so they have no model trajectory.

For each candidate attempt:

- `*.seednone.trial0.jsonl` is the full per-turn trace, including model
  responses, tool calls, tool output, decisions, and terminal state.
- `trajectory.*.log` is the concise execution log emitted for the same
  attempt.

| Instance                 | Arm          | Full trace                                                  | Concise log                                          |
| ------------------------ | ------------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| `astropy__astropy-12907` | scaffold-off | `astropy__astropy-12907.scaffold-off.seednone.trial0.jsonl` | `trajectory.astropy__astropy-12907.scaffold-off.log` |
| `astropy__astropy-12907` | scaffold-on  | `astropy__astropy-12907.scaffold-on.seednone.trial0.jsonl`  | `trajectory.astropy__astropy-12907.scaffold-on.log`  |
| `psf__requests-1963`     | scaffold-off | `psf__requests-1963.scaffold-off.seednone.trial0.jsonl`     | `trajectory.psf__requests-1963.scaffold-off.log`     |
| `psf__requests-1963`     | scaffold-on  | `psf__requests-1963.scaffold-on.seednone.trial0.jsonl`      | `trajectory.psf__requests-1963.scaffold-on.log`      |

The files were copied from the final queue runs:
`swe-five-task-20261021-172247` (Astropy) and
`swe-stratified-eight-20261021-172431/task-index-25` (Requests). They were
scanned for the DGX temporary token, common API-key formats, authorization
headers, and GitHub tokens before inclusion.

The run machine's username in paths and the git author name in the agent's own `git_log` output were replaced with `<user>` and `<author>` before publishing (2026-10-22).
