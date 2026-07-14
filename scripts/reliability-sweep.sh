#!/usr/bin/env bash
# Cross-model reliability sweep.
#
# Runs the eval suite N times per case against each model and persists a per-model
# baseline (pass rate per case) to .sidecar/logs/reliability/.
#
# WHY: a single-trial eval cannot tell a regression from variance. Measured on
# qwen2.5-coder, a plain `grep` case is 88% reliable and `no-stub-in-write` is a
# 52% coin flip — so three consecutive single-trial runs scored 8/9, 6/9 and 7/9
# with a DIFFERENT failing set each time, and a "regression" was read into pure
# noise. Nothing about scaffolding can be claimed on top of that.
#
# The baseline also decides where an ablation can learn anything: a scaffold only
# flips outcomes that could have gone either way, so only the near-coin-flip cases
# carry information — and which cases those are is MODEL-SPECIFIC.
#
# Usage:
#   ./scripts/reliability-sweep.sh                     # default fleet, 25 trials
#   TRIALS=15 ./scripts/reliability-sweep.sh           # cheaper
#   MODELS="qwen2.5-coder:7b llama3.2:latest" ./scripts/reliability-sweep.sh
#
# Then render the matrix (costs no model time):
#   npx vitest run --config vitest.eval.config.ts tests/llm-eval/reliabilityReport.eval.ts
set -uo pipefail
cd "$(dirname "$0")/.."

TRIALS="${TRIALS:-25}"
MODELS="${MODELS:-qwen2.5-coder:7b gemma4:e4b qwen3.5:latest granite4.1:3b ministral-3:latest llama3.2:latest}"
OUT_DIR=".sidecar/logs/reliability"
LOG_DIR=".sidecar/logs/reliability/runs"
mkdir -p "$OUT_DIR" "$LOG_DIR"

echo "Reliability sweep — ${TRIALS} trials/case"
echo "Models: ${MODELS}"
echo

for M in $MODELS; do
  SAFE="$(echo "$M" | tr ':.' '__')"
  echo "→ $M"
  # Serial by design: two concurrent vitest instances wedge the runner (upstream
  # forks-pool startup race), and concurrent models would contend for the GPU and
  # distort the very latencies we are measuring.
  SIDECAR_EVAL_MODEL="$M" \
  SIDECAR_EVAL_TRIALS="$TRIALS" \
  SIDECAR_RELIABILITY_OUT="${OUT_DIR}/${SAFE}.json" \
    npm run eval:smoke > "${LOG_DIR}/${SAFE}.log" 2>&1

  if [ -f "${OUT_DIR}/${SAFE}.json" ]; then
    echo "   baseline → ${OUT_DIR}/${SAFE}.json"
  else
    echo "   NO BASELINE WRITTEN — see ${LOG_DIR}/${SAFE}.log"
  fi
done

echo
echo "Done. Render the matrix:"
echo "  npx vitest run --config vitest.eval.config.ts tests/llm-eval/reliabilityReport.eval.ts"
