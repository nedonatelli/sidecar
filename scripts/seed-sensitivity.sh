#!/usr/bin/env bash
# Pass rate across SEEDS for the cases that flipped between the two sweeps.
#
# Seeded runs are reproducible (verified: same case + same seed twice -> same
# result), so repeating a run measures nothing. What varies outcomes is the seed
# — `fix-simple-bug` passes at 42 and fails at 1337 on granite4.1.
#
# So a baseline is a single-seed sample. A case that passes 2 of 5 seeds is
# MARGINAL, and its flip between sweeps says nothing about the harness fixes; a
# case that passes 5 of 5 or 0 of 5 is stable, and a flip there is meaningful.
#
# Uses `eval:agent`, which scores without writing any baseline.
set -uo pipefail
cd "$(dirname "$0")/.."
SEEDS=(42 1337 7 20260805 31337)
STAMP=$(date +%Y%m%dT%H%M%S); DIR=".sidecar/logs/seed-sensitivity-$STAMP"; mkdir -p "$DIR"
echo "seed sensitivity -> $DIR"
printf '%s\n' "case,model,seed,result" > "$DIR/results.csv"

# case:model — the model that flipped on that case between 2026-08-02 and 08-05
PAIRS=(
  "rename-function-across-callers:gemma4:e4b"
  "sidecar-md-enforces-convention:gemma4:e4b"
  "fix-two-independent-bugs:gemma4:e4b"
  "no-stub-in-write:ministral-3:latest"
  "edit-preserves-surrounding-code:granite4.1:3b"
  "shell-error-recovery:granite4.1:3b"
  "fix-wrong-type-annotation:granite4.1:3b"
  "build-python-calculator-cli:granite4.1:3b"
  "shell-error-recovery:qwen2.5-coder:7b"
  "thinking-aliased-mutation:qwen2.5-coder:7b"
  "version-from-package-json:qwen2.5-coder:7b"
)
for pair in "${PAIRS[@]}"; do
  c=${pair%%:*}; m=${pair#*:}
  for s in "${SEEDS[@]}"; do
    log="$DIR/${c}__${m//[^a-zA-Z0-9._-]/_}__$s.log"
    SIDECAR_EVAL_BACKEND=ollama SIDECAR_EVAL_MODEL="$m" \
      SIDECAR_AGENT_SEED="$s" SIDECAR_EVAL_CASE="$c" \
      npm run eval:agent >"$log" 2>&1
    if grep -qE "^ *✓ .*${c}" "$log"; then r=pass; elif grep -qE "^ *× .*${c}" "$log"; then r=fail; else r=unknown; fi
    echo "$c,$m,$s,$r" >> "$DIR/results.csv"
    echo "   $(date '+%H:%M:%S') $c [$m] seed=$s -> $r"
  done
done
echo "=== DONE -> $DIR/results.csv"
