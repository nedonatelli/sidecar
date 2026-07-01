#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SWE-bench ablation campaign — end-to-end on ONE GPU + Docker cloud box.
#
# Does the whole thing: pull the model, fetch a deterministic task slice,
# generate scaffold-off vs scaffold-on predictions (Ollama), score BOTH arms
# with the official swebench Docker harness, and compute the ablation lift.
#
# Prereqs on the box (see cloud/README.md): NVIDIA GPU + drivers, Docker,
# git, Node 20+, Python 3.11+, ~150 GB disk. Run from the repo root.
#
#   MODEL=qwen2.5-coder:7b N=50 DATASET=SWE-bench_Lite bash bench/swe/cloud/run_campaign.sh
# ---------------------------------------------------------------------------
set -euo pipefail

MODEL="${MODEL:-qwen2.5-coder:7b}"
N="${N:-50}"
DATASET="${DATASET:-SWE-bench_Lite}"
MAX_ITERS="${MAX_ITERS:-30}"
WORK="${WORK:-$PWD/swe_campaign_$(date +%Y%m%d_%H%M%S)}"
SLICE="$WORK/slice.jsonl"
PRED="$WORK/predictions"
mkdir -p "$PRED"

echo "== [1/6] deps =="
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
(ollama serve >/"$WORK/ollama.log" 2>&1 &) ; sleep 5
ollama pull "$MODEL"
npm ci
python -m pip install --quiet --upgrade swebench

echo "== [2/6] dataset ($DATASET, $N tasks) =="
node bench/swe/cloud/fetch_dataset.mjs --dataset "$DATASET" --n "$N" --out "$SLICE"

echo "== [3/6] generate predictions (both arms) =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_MODEL="$MODEL" \
  SIDECAR_SWE_OUT="$PRED" SIDECAR_SWE_MAX_ITERS="$MAX_ITERS" \
  SIDECAR_SWE_TASK_TIMEOUT=300000 SIDECAR_SWE_TIMEOUT=360000000 \
  npm run bench:swe:predict 2>&1 | tee "$WORK/predict.log"

echo "== [4/6] official swebench scoring (Docker) — per arm =="
for arm in scaffold-off scaffold-on; do
  python -m swebench.harness.run_evaluation \
    --dataset_name "princeton-nlp/$DATASET" \
    --predictions_path "$PRED/preds.$arm.jsonl" \
    --run_id "sidecar-$arm" \
    --max_workers "${SWE_WORKERS:-4}" 2>&1 | tee "$WORK/score.$arm.log"
  # The harness writes <model>.<run_id>.json with resolved_ids in CWD.
  report=$(ls -t "${MODEL//[:\/]/__}__$arm".sidecar-"$arm".json 2>/dev/null | head -1 || true)
  [ -z "$report" ] && report=$(ls -t *sidecar-"$arm"*.json 2>/dev/null | head -1 || true)
  cp "$report" "$WORK/resolved.$arm.json" 2>/dev/null || echo "!! locate the swebench report json for $arm and copy to $WORK/resolved.$arm.json"
done

echo "== [5/6] ablation lift =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_PREDS="$PRED" \
  SIDECAR_SWE_RESOLVED_ON="$WORK/resolved.scaffold-on.json" \
  SIDECAR_SWE_RESOLVED_OFF="$WORK/resolved.scaffold-off.json" \
  SIDECAR_SWE_MODEL="$MODEL" SIDECAR_SWE_OUT="$WORK" \
  npm run bench:swe:ablate 2>&1 | tee "$WORK/ablation.log"

echo "== [6/6] done → $WORK/ablation.md =="
