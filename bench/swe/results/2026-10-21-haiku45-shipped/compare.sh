#!/usr/bin/env bash
# Regenerate comparison.md. Trajectories live in release assets, not in git:
#   gh release download swe-data-2026-10-21 -R nedonatelli/sidecar -p '*.tar.gz' -D /tmp
#   gh release download swe-data-2026-10-20 -R nedonatelli/sidecar -p '*.tar.gz' -D /tmp
#   for t in /tmp/swe-data-*.tar.gz; do tar -xzf "$t" -C /tmp; done
#   bench/swe/results/2026-10-21-haiku45-shipped/compare.sh /tmp/swe-data-2026-10-21-haiku45-shipped /tmp/swe-data-2026-10-20-haiku45
set -euo pipefail
T="${1:?path to the extracted swe-data-2026-10-21-haiku45-shipped directory}"
P="${2:?path to the extracted swe-data-2026-10-20-haiku45 directory}"
R="$(cd "$(dirname "$0")" && pwd)"
O="$R/../2026-10-20-haiku45"
cd "$(git rev-parse --show-toplevel)"
python3 -I bench/swe/analysis/compare_agents.py --slice bench/swe/data/canary.jsonl \
  --run "SideCar shipped defaults (5.1.2):sidecar:$R/resolved.scaffold-on.json:$T/sidecar-shipped" \
  --run "SideCar 150 it, tiered budgets (5.1.1):sidecar:$O/sidecar-150it-budgets/resolved.scaffold-on.json+$O/sidecar-150it-budgets/rerun/resolved.scaffold-on.json:$P/sidecar-150it-budgets+$P/sidecar-150it-budgets/rerun" \
  --run "SideCar 150 it (5.1.0):sidecar:$O/sidecar-150it/resolved.scaffold-on.json:$P/sidecar-150it" \
  --run "SideCar on, 50 it (5.1.0):sidecar@scaffold-on:$O/sidecar-50it/resolved.scaffold-on.json:$P/sidecar-50it" \
  --run "Claude Code:claude-code:$O/claude-code/resolved.claude-code.json:$P/claude-code"
