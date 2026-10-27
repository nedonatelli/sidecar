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
# Unset = the product's ceiling for this model (150 strong tier, 50 otherwise).
MAX_ITERS="${MAX_ITERS:-}"
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

# --- GPU sanity probe (guards a known footgun) ------------------------------
# On slow-CDN boxes `install.sh` can exit 0 but truncate the bundled llama
# runner, so `ollama serve` starts, `pull` succeeds, and generation silently
# falls back to CPU — a 50-task run then crawls at ~0% GPU for hours before you
# notice. Fail loud here (≈1 min) instead. Warm the model and assert the GPU is
# actually engaged.
echo "== [1b/6] verify GPU inference =="
ollama --version >/dev/null 2>&1 || { echo "!! ollama binary missing/broken — reinstall (truncated download?)"; exit 1; }
timeout 120 ollama run "$MODEL" "reply with the single word ok" > "$WORK/warmup.txt" 2>&1 \
  || { echo "!! warmup generation failed — likely a truncated Ollama install (llama runner missing). See $WORK/ollama.log"; exit 1; }
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_mem=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1 | tr -d ' ')
  echo "[verify] GPU memory in use after warmup: ${gpu_mem:-?} MiB"
  if [ "${gpu_mem:-0}" -lt 500 ]; then
    echo "!! GPU memory ~0 during generation — the model is running on CPU, not GPU."
    echo "!! Almost always a truncated Ollama install. Reinstall with a parallel downloader"
    echo "!! (e.g. aria2c) and verify the tarball size before rerunning. Aborting."
    exit 1
  fi
fi

echo "== [2/6] dataset ($DATASET, $N tasks) =="
node bench/swe/cloud/fetch_dataset.mjs --dataset "$DATASET" --n "$N" --out "$SLICE"

# Arms: default two-arm on/off. Set ARMS=scaffold-off,scaffold-on,scaffold-on-ratchet
# for the three-arm campaign (keep-best do-no-harm + over-engineering section).
ARMS="${ARMS:-scaffold-off,scaffold-on}"

if [ -n "$MAX_ITERS" ]; then export SIDECAR_SWE_MAX_ITERS="$MAX_ITERS"; fi
echo "== [3/6] generate predictions (arms: $ARMS) =="
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_MODEL="$MODEL" \
  SIDECAR_SWE_OUT="$PRED" \
  SIDECAR_SWE_ARMS="$ARMS" \
  SIDECAR_SWE_TASK_TIMEOUT=300000 SIDECAR_SWE_TIMEOUT=360000000 \
  npm run bench:swe:predict 2>&1 | tee "$WORK/predict.log"

echo "== [4/6] official swebench scoring (Docker) — per arm =="
# Prove each instance can score a patch at all before trusting any score (#338);
# see bench/swe/scorer_preflight.py. SWE_PREFLIGHT=warn scores anyway; =off skips.
if [ "${SWE_PREFLIGHT:-gate}" != off ]; then
  python -c 'import json, sys; print("\n".join(sorted({json.loads(l)["instance_id"] for p in sys.argv[1:] for l in open(p) if l.strip()})))' \
    "$PRED"/preds.*.jsonl > "$WORK/preflight-ids.txt"
  python bench/swe/scorer_preflight.py --dataset "SWE-bench/$DATASET" run --reuse \
    --instances "$WORK/preflight-ids.txt" 2>&1 | tee "$WORK/preflight.log" || true
  for arm in ${ARMS//,/ }; do
    python bench/swe/scorer_preflight.py --dataset "SWE-bench/$DATASET" gate --predictions "$PRED/preds.$arm.jsonl" \
      || [ "${SWE_PREFLIGHT:-gate}" = warn ] || { echo "!! preflight gate failed for $arm (SWE_PREFLIGHT=warn to score anyway)"; exit 1; }
  done
fi
# Needs a Docker host. There is no serverless option any more: swebench's Modal
# evaluator calls Modal's retired legacy Sandbox filesystem API, so every
# instance errors at sandbox creation (observed 2026-10-20). On a host without
# Docker, copy $PRED back and score it with bench/swe/local/run_local.sh's step 4.
# SWE-bench/ namespace, not princeton-nlp/: swebench 5.x needs the per-instance
# image fields only the former carries (else KeyError: 'image'). Transient
# env-spec fetch flakes (ValueError: Could not find environment.yml — the
# harness pulls it from GitHub at score time) abort a whole arm; retry once.
for arm in ${ARMS//,/ }; do
  for attempt in 1 2; do
    python -m swebench.harness.run_evaluation \
      --dataset_name "SWE-bench/$DATASET" --split test \
      --predictions_path "$PRED/preds.$arm.jsonl" \
      --run_id "sidecar-$arm-a$attempt" \
      --max_workers "${SWE_WORKERS:-4}" 2>&1 | tee "$WORK/score.$arm.log"
    grep -q "Could not find environment.yml" "$WORK/score.$arm.log" || break
    echo "!! transient env-spec fetch flake on $arm (attempt $attempt) — retrying"
  done
  # The harness writes <model>.<run_id>.json with resolved_ids in CWD.
  report=$(ls -t *sidecar-"$arm"-a*.json 2>/dev/null | head -1 || true)
  [ -z "$report" ] && report=$(ls -t *sidecar-"$arm"*.json 2>/dev/null | head -1 || true)
  cp "$report" "$WORK/resolved.$arm.json" 2>/dev/null || echo "!! locate the swebench report json for $arm and copy to $WORK/resolved.$arm.json"
done

echo "== [5/6] ablation lift =="
RATCHET_ARG=""
if [ -f "$WORK/resolved.scaffold-on-ratchet.json" ]; then
  RATCHET_ARG="$WORK/resolved.scaffold-on-ratchet.json"
fi
SIDECAR_SWE_DATA="$SLICE" SIDECAR_SWE_N="$N" SIDECAR_SWE_PREDS="$PRED" \
  SIDECAR_SWE_RESOLVED_ON="$WORK/resolved.scaffold-on.json" \
  SIDECAR_SWE_RESOLVED_OFF="$WORK/resolved.scaffold-off.json" \
  ${RATCHET_ARG:+SIDECAR_SWE_RESOLVED_RATCHET="$RATCHET_ARG"} \
  SIDECAR_SWE_MODEL="$MODEL" SIDECAR_SWE_OUT="$WORK" \
  npm run bench:swe:ablate 2>&1 | tee "$WORK/ablation.log"

echo "== [6/6] done → $WORK/ablation.md =="
