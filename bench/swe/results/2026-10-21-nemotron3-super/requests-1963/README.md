# Nemotron 3 Super — `psf__requests-1963`

**Status:** scored 2026-10-21 with swebench 5.0.2 in local Docker (colima, amd64
via Rosetta) via `bench/swe/local/score_local.sh`. **Both arms resolve.**

| Arm          | Resolved | FAIL_TO_PASS | PASS_TO_PASS | Turns | Termination                 |
| ------------ | -------- | ------------ | ------------ | ----- | --------------------------- |
| scaffold-off | yes      | 7/7          | 112/112      | 11    | `bad-reasoning` (see below) |
| scaffold-on  | yes      | 7/7          | 112/112      | 27    | vLLM `EngineCore` crash     |

The two patches differ: scaffold-on carries the previous redirect's request
forward (`current_request = prepared_request`), close to the upstream fix, while
scaffold-off rewrites the loop to also yield the final response. The official
tests accept both.

**Labels to distrust in `predictions.meta.jsonl`:**

- **scaffold-on `failureReason` is infrastructure.** `EngineCore encountered an
issue` is vLLM's message for a dead engine. The SWE failure classifier didn't
  recognize it, so the run reads as a capability failure; the patch counted
  regardless, because a salvaged patch always does. The engine died because
  Ray's memory monitor killed its GPU worker; see
  [Troubleshooting](../../../../../docs/troubleshooting.md#vllm-enginecore-encountered-an-issue).
- **`terminationBucket: bad-reasoning` on both arms doesn't mean bad reasoning.**
  The loop's failure taxonomy has no infrastructure bucket, so a backend error
  lands there. Scaffold-off resolved the task in 11 turns but didn't end
  `natural`. Why can't be told without its trajectory, which this handoff omits.
- **`maxIterationsSource: tier:weak`** is SideCar's fallback for a model it can't
  size from its name, not a measurement of Nemotron-3-Super (see #248).

One task is a smoke test, not a result.

This is a one-instance paired SWE-bench Lite run for `nemotron-3-super`:

- Dataset: committed `canary.jsonl` slice, filtered to `psf/requests`
- Agent iteration ceiling: 50
- Arms: `scaffold-off`, `scaffold-on`
- Model endpoint: self-hosted OpenAI-compatible server

Both arms emitted a non-empty official-format patch. `scaffold-on` subsequently
ended with an `EngineCore` server failure after 27 turns; the official scorer
should still score the emitted patch and report the result independently.

## Score on a Docker-capable machine

From the repository root:

```sh
bench/swe/local/score_local.sh ./swe-score nemotron3-super-requests-1963 \
  bench/swe/results/2026-10-21-nemotron3-super/requests-1963/preds.scaffold-off.jsonl \
  bench/swe/results/2026-10-21-nemotron3-super/requests-1963/preds.scaffold-on.jsonl
```

This writes `resolved.scaffold-off.json`, `resolved.scaffold-on.json`, and
per-arm logs under `./swe-score`. The scorer needs Docker, Python, and
`swebench>=5`, but not access to the model server or an API key.

`run.manifest.json` is the generated provenance with the internal endpoint URL
removed; it contains no credential material.
