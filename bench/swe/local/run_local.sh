#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SWE-bench ablation — fully local on a Mac. No GPU box, no Docker.
#
# Predictions run on your local Ollama; the official swebench scorer runs the
# hidden tests in Modal's serverless containers (so no Docker-in-Docker and no
# x86-under-QEMU pain on Apple Silicon). Everything reuses a committed task
# slice + a local repo cache, so a run needs zero network at solve time and the
# only external call is Modal at score time.
#
# One-time setup:
#   1. Ollama installed and the model pulled (the script pulls if missing).
#   2. Modal auth once:  .sidecar/cache/swe-venv/bin/modal token set \
#                          --token-id <id> --token-secret <secret>
#      (the venv is created on first run; auth persists in ~/.modal.toml)
#
# Usage (from repo root):
#   npm run bench:swe:local                       # gemma4:e4b, 20 tasks
#   MODEL=qwen2.5-coder:7b N=50 npm run bench:swe:local   # full slice
#   MAX_ITERS=60 TASK_TIMEOUT=2400000 npm run bench:swe:local  # no truncation
#
# Result: $WORK/ablation.md  (the harness lift, per-arm resolve rates, CI).
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MODEL="${MODEL:-gemma4:e4b}"
N="${N:-20}"
SLICE="${SLICE:-bench/swe/data/canary.jsonl}"
ARMS="${ARMS:-scaffold-off,scaffold-on}"
MAX_ITERS="${MAX_ITERS:-30}"
# Per-task ceiling, ms. Was hardcoded at 300_000 (5 min), which silently
# truncated most scaffolded arms: measured gate-only arms legitimately run
# 673–1202s on django tasks, so a 5-minute cap made this script's results
# non-comparable to the documented runs. Now configurable, defaulting to 20 min.
# This is a HANG guard, not a work budget — raise it freely when debugging.
TASK_TIMEOUT="${TASK_TIMEOUT:-1200000}"
CACHE="${SIDECAR_SWE_REPO_CACHE:-.sidecar/cache/swe-repos}"
VENV="${SWE_VENV:-.sidecar/cache/swe-venv}"
WORK="${WORK:-.sidecar/cache/swe-local/run_$(date +%Y%m%d_%H%M%S)}"
PRED="$WORK/predictions"
mkdir -p "$PRED" "$CACHE"

echo "== [1/5] ollama =="
command -v ollama >/dev/null || { echo "!! ollama not installed — https://ollama.com/download"; exit 1; }
curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 \
  || { echo "  starting ollama…"; (ollama serve >"$WORK/ollama.log" 2>&1 &) ; sleep 5; }
ollama list | awk '{print $1}' | grep -qx "$MODEL" || ollama pull "$MODEL"

echo "== [2/5] repo cache ($CACHE) =="
# Full clones (all blobs) so swe.eval.ts can `reset --hard <base>` offline per
# task. Idempotent — clones only what's missing. Only repos the selected N
# tasks touch are cloned (sampleTasks sorts by instance_id, takes first N).
repos=$(python3 - "$SLICE" "$N" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows.sort(key=lambda r: r["instance_id"])
seen = []
for r in rows[: int(sys.argv[2])]:
    if r["repo"] not in seen:
        seen.append(r["repo"])
print("\n".join(seen))
PY
)
for repo in $repos; do
  dir="$CACHE/${repo//\//_}"
  if [ ! -d "$dir/.git" ]; then
    echo "  clone $repo"
    git clone --quiet "https://github.com/$repo.git" "$dir"
  fi
done

echo "== [3/5] predictions (model=$MODEL, N=$N, arms=$ARMS) =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_MODEL="$MODEL" \
  SIDECAR_SWE_OUT="$PRED" SIDECAR_SWE_MAX_ITERS="$MAX_ITERS" SIDECAR_SWE_ARMS="$ARMS" \
  SIDECAR_SWE_REPO_CACHE="$CACHE" \
  SIDECAR_SWE_TASK_TIMEOUT="$TASK_TIMEOUT" SIDECAR_SWE_TIMEOUT=360000000 \
  npm run bench:swe:predict 2>&1 | tee "$WORK/predict.log"

echo "== [4/5] scoring (Modal) =="
if [ ! -d "$VENV" ]; then python3 -m venv "$VENV"; "$VENV/bin/pip" install -q --upgrade pip >/dev/null; fi
"$VENV/bin/python" -c 'import swebench, modal' 2>/dev/null || "$VENV/bin/pip" install -q swebench modal
"$VENV/bin/modal" profile current >/dev/null 2>&1 \
  || { echo "!! Modal not authed. Run once: $VENV/bin/modal token set --token-id <id> --token-secret <secret>"; exit 1; }
# Offline HF: score against the committed local slice (has the gold test fields),
# never princeton-nlp/* over the network.
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1
ABSVENV="$PWD/$VENV" ABSSLICE="$PWD/$SLICE" ABSPRED="$PWD/$PRED"
( cd "$WORK"
  for arm in ${ARMS//,/ }; do
    "$ABSVENV/bin/python" -m swebench.harness.run_evaluation \
      --dataset_name "$ABSSLICE" \
      --predictions_path "$ABSPRED/preds.$arm.jsonl" \
      --run_id "sidecar-local-$arm" --modal true \
      --max_workers "${SWE_WORKERS:-8}" 2>&1 | tee "score.$arm.log"
    report=$(ls -t ./*sidecar-local-"$arm".json 2>/dev/null | head -1 || true)
    [ -n "$report" ] && cp "$report" "resolved.$arm.json" \
      || echo "!! no resolved report for $arm — check score.$arm.log"
  done
)

echo "== [5/5] ablation lift =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_PREDS="$PRED" \
  SIDECAR_SWE_RESOLVED_ON="$WORK/resolved.scaffold-on.json" \
  SIDECAR_SWE_RESOLVED_OFF="$WORK/resolved.scaffold-off.json" \
  SIDECAR_SWE_MODEL="$MODEL" SIDECAR_SWE_OUT="$WORK" \
  npm run bench:swe:ablate 2>&1 | tee "$WORK/ablation.log"

echo "== done → $WORK/ablation.md =="
