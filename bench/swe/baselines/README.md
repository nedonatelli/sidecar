# Reference agents

SideCar's own A/Bs (scaffold on/off, gates, prompts) compare SideCar with
itself. These drivers run **other agents on the same tasks and the same model**,
so a SideCar number can be split into model and harness. Score every agent's
predictions with the same scorer, `../local/score_local.sh`, and compare with
`../analysis/compare_agents.py`.

| Driver           | Agent                                                                                         | Environment                                 |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `claude_code.py` | Claude Code headless (`claude -p`), stock config                                              | Host clone + the same uv venvs SideCar gets |
| `mini_swe.sh`    | mini-SWE-agent, the SWE-bench team's minimal bash-only agent, at its standard `swebench.yaml` | SWE-bench's own Docker images, on Modal     |

## Claude Code

```sh
python3 -I bench/swe/baselines/claude_code.py .sidecar/cache/cc-swe/canary50
bench/swe/local/score_local.sh .sidecar/cache/cc-swe/canary50 cc .sidecar/cache/cc-swe/canary50/preds.claude-code.jsonl
```

- **Auth and isolation.** It uses `ANTHROPIC_API_KEY` and an empty `CLAUDE_CONFIG_DIR`, so none of your own plugins, hooks, MCP servers or CLAUDE.md load.
- **It runs unsandboxed.** The agent runs with `--permission-mode bypassPermissions` **directly on the host**, in a throwaway clone per task.
- **Telemetry.** Each task's stream-json log (`<id>.stream.jsonl`) is the telemetry, and `meta.claude-code.jsonl` has turns, cost and time per task.
- **Resuming.** Rerunning skips tasks already in the predictions file.

## mini-SWE-agent

```sh
bench/swe/baselines/mini_swe.sh .sidecar/cache/mini-swe/canary50
bench/swe/local/score_local.sh .sidecar/cache/mini-swe/canary50 mini .sidecar/cache/mini-swe/canary50/preds.mini.jsonl
```

- **Setup.** It needs Modal auth (`modal token set`) and the model's API key. The driver creates its own venv, with the `mcp` package that LiteLLM's Anthropic path needs.
- **Infrastructure failures are rerun automatically.** Tasks that died on infrastructure (DNS, Modal stream, timeouts) are rerun once and merged. On 2026-10-20, 27/50 died that way overnight.
- **Modal is fine here.** mini-SWE-agent's swe-rex sandbox on Modal works. What's broken is swebench's Modal _evaluator_, which is why scoring is local.

## Comparability

Record each agent's version, and keep the per-task wall-clock timeout equal across agents (SideCar and `claude_code.py` both default to 20 minutes). Step budgets differ by design, so report them next to the results: SideCar's iteration ceiling, Claude Code has none, mini-SWE-agent allows 250.
