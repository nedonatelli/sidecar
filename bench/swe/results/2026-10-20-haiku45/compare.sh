#!/usr/bin/env bash
# Regenerate comparison.md. Trajectories live in the release asset, not in git:
#   gh release download swe-data-2026-10-20 -R nedonatelli/sidecar -p '*.tar.gz' -D /tmp
#   tar -xzf /tmp/swe-data-2026-10-20-haiku45.tar.gz -C /tmp
#   bench/swe/results/2026-10-20-haiku45/compare.sh /tmp/swe-data-2026-10-20-haiku45
set -euo pipefail
T="${1:?path to the extracted swe-data-2026-10-20-haiku45 directory}"
R="$(cd "$(dirname "$0")" && pwd)"
cd "$(git rev-parse --show-toplevel)"
python3 -I bench/swe/analysis/compare_agents.py --slice bench/swe/data/canary.jsonl \
  --run "SideCar off, 50 it:sidecar@scaffold-off:$R/sidecar-50it/resolved.scaffold-off.json:$T/sidecar-50it" \
  --run "SideCar on, 50 it:sidecar@scaffold-on:$R/sidecar-50it/resolved.scaffold-on.json:$T/sidecar-50it" \
  --run "SideCar on, 150 it:sidecar:$R/sidecar-150it/resolved.scaffold-on.json:$T/sidecar-150it" \
  --run "SideCar on, 150 it, tiered budgets:sidecar:$R/sidecar-150it-budgets/resolved.scaffold-on.json+$R/sidecar-150it-budgets/rerun/resolved.scaffold-on.json:$T/sidecar-150it-budgets+$T/sidecar-150it-budgets/rerun" \
  --run "Claude Code:claude-code:$R/claude-code/resolved.claude-code.json:$T/claude-code" \
  --run "mini-SWE-agent:mini:$R/mini-swe-agent/resolved.mini.json:$T/mini-swe-agent/main+$T/mini-swe-agent/rerun"
