# Nemotron 3 Super — `psf__requests-1963`

**Status:** unscored portable prediction handoff.

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
